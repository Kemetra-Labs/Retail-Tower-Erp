"""Consumer PINs against the in-tree contract (RT-868 scope 1a).

For every `file: <path> <blob>` line of a consumer PIN, the pinned blob is read from this
repository's object store (Backend-Core history was imported with identical blobs) and
compared with the in-tree file at the checked-out commit by `oasdiff breaking` (WARN or
higher fails, as in the Backend-Core gate) and `oasdiff changelog` (every other change is
reported as drift). Anything that cannot be compared fails: a malformed PIN, a missing blob,
a vendored copy that does not hash to its pin, a pinned file gone from the tree, or an
oasdiff run that does not end in a clean verdict."""

import json
import pathlib
import re
import subprocess
import tempfile

from .findings import DRIFT, FAIL, OK, Finding

_SHA = re.compile(r"^[0-9a-f]{40}$")
_HEADER_KEYS = ("repo", "commit", "source")
# oasdiff JSON levels: 1 INFO, 2 WARN, 3 ERR. The Backend-Core gate fails on WARN.
_BREAKING_LEVEL = 2
_LEVEL_NAME = {1: "INFO", 2: "WARN", 3: "ERR"}
MAX_FINDINGS_LISTED = 20


class PinError(ValueError):
    pass


def _git(repo, *args, stdin=None):
    return subprocess.run(["git", "-C", str(repo), *args], input=stdin, capture_output=True,
                          check=False)


def parse_pin(text):
    """`[(path, blob)]` in file order. Rejects anything it does not understand."""
    files, seen = [], set()
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition(":")
        if not sep:
            raise PinError(f"line {number}: not a `key: value` line: {raw!r}")
        value = value.strip()
        if key in _HEADER_KEYS:
            continue
        if key != "file":
            raise PinError(f"line {number}: unknown key {key!r}")
        parts = value.split()
        if len(parts) != 2 or not _SHA.match(parts[1]):
            raise PinError(f"line {number}: expected `file: <path> <40-hex blob>`, got {raw!r}")
        path = parts[0]
        pure = pathlib.PurePosixPath(path)
        if pure.is_absolute() or ".." in pure.parts or not path.endswith(".yaml"):
            raise PinError(f"line {number}: pinned path must be a relative .yaml path, got {path!r}")
        if path in seen:
            raise PinError(f"line {number}: duplicate pinned path {path!r}")
        seen.add(path)
        files.append((path, parts[1]))
    if not files:
        raise PinError("no `file:` lines")
    return files


def read_blob(repo, blob):
    """The blob's bytes, or None when this repository does not have it."""
    proc = _git(repo, "cat-file", "blob", blob)
    return proc.stdout if proc.returncode == 0 else None


def hash_object(repo, data):
    proc = _git(repo, "hash-object", "--stdin", stdin=data)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace").strip())
    return proc.stdout.decode().strip()


def _run_oasdiff(oasdiff, mode, base, revision, severity_levels):
    cmd = [str(oasdiff), mode, "--format", "json", "--allow-external-refs=false"]
    if mode == "breaking":
        cmd += ["--fail-on", "WARN"]
    if severity_levels:
        cmd += ["--severity-levels", str(severity_levels)]
    try:
        proc = subprocess.run(cmd + [str(base), str(revision)], capture_output=True, check=False)
    except OSError as exc:
        return None, None, f"cannot run {oasdiff}: {exc}"
    try:
        parsed = json.loads(proc.stdout.decode("utf-8"))
    except ValueError:
        parsed = None   # unparseable or empty output is never read as "no changes"
    return proc.returncode, parsed, proc.stderr.decode("utf-8", "replace").strip()


def _describe(change):
    level = _LEVEL_NAME.get(change.get("level"), str(change.get("level")))
    where = " ".join(x for x in (change.get("operation"), change.get("path")) if x)
    text = f"{level} {change.get('id', '?')}"
    if where:
        text += f" {where}"
    return f"{text}: {change.get('text', '')}".strip()


def _summarise(changes):
    lines = [_describe(c) for c in changes[:MAX_FINDINGS_LISTED]]
    if len(changes) > MAX_FINDINGS_LISTED:
        lines.append(f"... and {len(changes) - MAX_FINDINGS_LISTED} more")
    return "; ".join(lines)


def compare_file(oasdiff, base_path, revision_path, severity_levels, subject):
    """Findings for one pinned file (base) against its in-tree file (revision)."""
    code, breaking, err = _run_oasdiff(oasdiff, "breaking", base_path, revision_path, severity_levels)
    if code not in (0, 1) or (code == 0 and not isinstance(breaking, list)):
        return [Finding("pins", subject, FAIL, f"oasdiff breaking errored (exit {code}): {err or 'unparseable output'}")]
    if not isinstance(breaking, list):
        breaking = []
    gating = [c for c in breaking if isinstance(c, dict) and c.get("level", 0) >= _BREAKING_LEVEL]
    if code == 1 or gating:
        if not gating:
            # Exit 1 with nothing parsed: still a failure, never a pass.
            return [Finding("pins", subject, FAIL, f"oasdiff breaking failed without findings: {err}")]
        return [Finding("pins", subject, FAIL, f"{len(gating)} breaking change(s): {_summarise(gating)}")]
    code, changes, err = _run_oasdiff(oasdiff, "changelog", base_path, revision_path, severity_levels)
    if code != 0 or not isinstance(changes, list):
        return [Finding("pins", subject, FAIL, f"oasdiff changelog errored (exit {code}): {err or 'unparseable output'}")]
    if changes:
        return [Finding("pins", subject, DRIFT, f"{len(changes)} non-breaking change(s): {_summarise(changes)}")]
    return [Finding("pins", subject, OK, "identical API surface")]


def check_consumer(repo, consumer, contracts_root, oasdiff, severity_levels):
    repo = pathlib.Path(repo)
    name, pin_path = consumer["name"], consumer["pin"]
    try:
        files = parse_pin((repo / pin_path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, PinError) as exc:
        return [Finding("pins", f"{name} {pin_path}", FAIL, f"unreadable PIN: {exc}")]
    findings = []
    with tempfile.TemporaryDirectory(prefix="contracts-check-") as tmp:
        for path, blob in files:
            subject = f"{name} {path}"
            data = read_blob(repo, blob)
            if data is None:
                findings.append(Finding("pins", subject, FAIL,
                                        f"pinned blob {blob} is not in this repository's object store; "
                                        "cannot compare (fetch full history or repin)"))
                continue
            vendored = consumer.get("vendored")
            if vendored:
                copy = repo / vendored / path
                if not copy.is_file():
                    findings.append(Finding("pins", subject, FAIL, f"vendored copy {vendored}/{path} is missing"))
                    continue
                actual = hash_object(repo, copy.read_bytes())
                if actual != blob:
                    findings.append(Finding("pins", subject, FAIL,
                                            f"vendored copy {vendored}/{path} hashes to {actual}, PIN says {blob}"))
                    continue
            current = repo / contracts_root / path
            if not current.is_file():
                findings.append(Finding("pins", subject, FAIL,
                                        f"pinned file {contracts_root}/{path} no longer exists in the tree"))
                continue
            base = pathlib.Path(tmp) / name / path
            base.parent.mkdir(parents=True, exist_ok=True)
            base.write_bytes(data)
            findings += compare_file(oasdiff, base, current, severity_levels, subject)
    return findings
