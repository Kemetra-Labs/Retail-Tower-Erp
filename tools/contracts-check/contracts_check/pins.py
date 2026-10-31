"""Consumer PINs against the in-tree contract (RT-868 scope 1a).

For every `file: <path> <blob>` line of a consumer PIN, the pinned blob is read from this
repository's object store (Backend-Core history was imported with identical blobs) and
compared with the in-tree file at the checked-out commit by `oasdiff breaking` (WARN or
higher fails, as in the Backend-Core gate) and `oasdiff changelog` (every other change is
reported as drift). Anything that cannot be compared fails: a malformed PIN, a PIN whose
`repo:`/`source:` header does not name this repository's in-tree contract (RT-889), a missing blob,
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


def parse_header(text):
    """`{repo, commit, source}` of a PIN. Each must appear exactly once (RT-889)."""
    header = {}
    for number, raw in enumerate(text.splitlines(), 1):
        key, sep, value = raw.strip().partition(":")
        if not sep or key not in _HEADER_KEYS:
            continue
        if key in header:
            raise PinError(f"line {number}: duplicate `{key}:` line")
        header[key] = value.strip()
    missing = [key for key in _HEADER_KEYS if key not in header]
    if missing:
        raise PinError(f"no `{missing[0]}:` line")
    return header


def check_header(header, repository, contracts_root):
    """Why the PIN does not name this repository's in-tree contract, or None (RT-889).

    The pinned blobs are read from this repository, so a PIN that names another repository
    (such as the frozen Kemetra/Backend-Core) or another source directory is not describing
    what the check compares, and a repin from that repository would go unnoticed."""
    if header["repo"] != repository:
        return f"PIN names repo {header['repo']!r}, not this repository {repository!r}"
    if header["source"] != contracts_root:
        return f"PIN names source {header['source']!r}, not the in-tree contract {contracts_root!r}"
    if not _SHA.match(header["commit"]):
        return f"PIN commit {header['commit']!r} is not a 40-hex commit"
    return None


def read_blob(repo, blob):
    """The blob's bytes, or None when this repository does not have it."""
    proc = _git(repo, "cat-file", "blob", blob)
    return proc.stdout if proc.returncode == 0 else None


def read_at(repo, rev, path):
    """`path` at commit `rev` from the object store, or None when it is not there (RT-1030)."""
    proc = _git(repo, "show", f"{rev}:{path}")
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
    # Every change is listed: a truncated list could hide exactly the drift a reviewer needs.
    return "; ".join(_describe(c) for c in changes)


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


def check_consumer(repo, consumer, contracts_root, oasdiff, severity_levels, *, repository,
                   pin_rev=None, backend_rev=None):
    """Findings for one consumer. By default the PIN, the vendored copies and the contract come
    from the working tree. RT-1030: `pin_rev` reads the PIN and vendored copies at that commit
    (the consumer's release) and `backend_rev` reads the contract at that commit (the
    Backend-Core release), so a system release can be checked without checking anything out."""
    repo = pathlib.Path(repo)
    name, pin_path = consumer["name"], consumer["pin"]
    try:
        if pin_rev:
            raw = read_at(repo, pin_rev, pin_path)
            if raw is None:
                raise OSError(f"{pin_path} does not exist at {pin_rev}")
            text = raw.decode("utf-8")
        else:
            text = (repo / pin_path).read_text(encoding="utf-8")
        files = parse_pin(text)
        header = parse_header(text)
    except (OSError, UnicodeDecodeError, PinError) as exc:
        return [Finding("pins", f"{name} {pin_path}", FAIL, f"unreadable PIN: {exc}")]
    foreign = check_header(header, repository, contracts_root)
    if foreign is not None:
        return [Finding("pins", f"{name} {pin_path}", FAIL, f"{foreign}; repin from this repository")]
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
                if pin_rev:
                    copy_bytes = read_at(repo, pin_rev, f"{vendored}/{path}")
                else:
                    copy = repo / vendored / path
                    copy_bytes = copy.read_bytes() if copy.is_file() else None
                if copy_bytes is None:
                    findings.append(Finding("pins", subject, FAIL, f"vendored copy {vendored}/{path} is missing"))
                    continue
                actual = hash_object(repo, copy_bytes)
                if actual != blob:
                    findings.append(Finding("pins", subject, FAIL,
                                            f"vendored copy {vendored}/{path} hashes to {actual}, PIN says {blob}"))
                    continue
            if backend_rev:
                revision = read_at(repo, backend_rev, f"{contracts_root}/{path}")
                if revision is None:
                    findings.append(Finding("pins", subject, FAIL,
                                            f"pinned file {contracts_root}/{path} does not exist at {backend_rev}"))
                    continue
                current = pathlib.Path(tmp) / "backend" / name / path
                current.parent.mkdir(parents=True, exist_ok=True)
                current.write_bytes(revision)
            else:
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
