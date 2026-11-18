#!/usr/bin/env python3
"""Binary size guard (RT-1460, audit A-19). Stdlib only; runs on Python 3.14.

  size_guard.py check --repo PATH [--base REF] [--head REV] [--config PATH]
  size_guard.py generate --repo PATH [--rev REV]      print a fresh config to stdout

`check` exits 0 when every rule passes, 1 on a violation, 2 on unreadable input.

Why it exists: apps/pos/docs/design holds ~2,900 captures (116 MB) and every clone and CI checkout
pays for them. The guard stops the growth; it never deletes anything and never rewrites history.

Rules (config: tools/size-guard/config.json, read from git, so the same file is read at HEAD and BASE):

  1. Size. A binary (extension in `binary_extensions`) larger than `threshold_bytes` must be in the
     explicit `allowlist` (path -> max bytes). A new one, or one that grew past its entry, fails.
     A Git LFS pointer is a few hundred bytes, so a file stored in LFS passes without an entry.
  2. Shrink-only. Against BASE: no new allowlist path, no raised entry, no raised threshold or
     budget, no removed extension. A moved (renamed) file may carry its old entry to its new path.
  3. No stale entries. An entry whose file is gone, no longer over the threshold or now smaller than
     the entry fails, so the list can only get shorter or tighter.
  4. PR budget. The binaries a change adds or grows may total at most `pr_budget_bytes`. A per-file
     threshold alone does not stop the real problem here: the design folder is 2,880 files under
     100 KB each (averaging 37 KB).

Generated text files (schema.d.ts, api-types.ts, CSV, HTML) are out of scope: only the listed binary
extensions count.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

DEFAULT_CONFIG = "tools/size-guard/config.json"
CONFIG_KEYS = {"threshold_bytes", "pr_budget_bytes", "binary_extensions", "allowlist"}
GITLINK_MODE = "160000"
ZERO_SHA = "0" * 40


class GuardError(Exception):
    """Unreadable input or a git failure: exit code 2, never a silent pass."""


def git(repo: str, *args: str, stdin: bytes | None = None) -> bytes:
    proc = subprocess.run(
        ["git", "-c", "core.quotepath=off", "-C", repo, *args],
        input=stdin,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise GuardError(f"git {' '.join(args)} failed: {proc.stderr.decode(errors='replace').strip()}")
    return proc.stdout


def parse_config(raw: bytes, label: str) -> dict:
    try:
        cfg = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GuardError(f"{label}: not valid JSON: {exc}") from exc
    if not isinstance(cfg, dict) or set(cfg) != CONFIG_KEYS:
        raise GuardError(f"{label}: keys must be exactly {sorted(CONFIG_KEYS)}")
    for key in ("threshold_bytes", "pr_budget_bytes"):
        if not isinstance(cfg[key], int) or isinstance(cfg[key], bool) or cfg[key] <= 0:
            raise GuardError(f"{label}: {key} must be a positive integer")
    exts = cfg["binary_extensions"]
    if not isinstance(exts, list) or not exts or any(
        not isinstance(e, str) or not e or e != e.lower() or e.startswith(".") for e in exts
    ):
        raise GuardError(f"{label}: binary_extensions must be non-empty lowercase names without a dot")
    allow = cfg["allowlist"]
    if not isinstance(allow, dict) or any(
        not isinstance(k, str) or not isinstance(v, int) or isinstance(v, bool) or v <= 0
        for k, v in allow.items()
    ):
        raise GuardError(f"{label}: allowlist must map a path to a positive integer size")
    return cfg


def read_config(repo: str, rev: str, path: str) -> dict | None:
    """The config at `rev`, or None when the file does not exist there (the bootstrap commit)."""
    try:
        raw = git(repo, "show", f"{rev}:{path}")
    except GuardError as exc:
        if "does not exist" in str(exc) or "exists on disk, but not in" in str(exc):
            return None
        raise
    return parse_config(raw, f"{path}@{rev}")


def is_binary(path: str, exts: set[str]) -> bool:
    name = path.rsplit("/", 1)[-1]
    return "." in name and name.rsplit(".", 1)[1].lower() in exts


def tree_sizes(repo: str, rev: str) -> dict[str, int]:
    """path -> blob size for every blob in the tree at `rev` (one git call)."""
    out = git(repo, "ls-tree", "-r", "-l", "-z", rev)
    sizes: dict[str, int] = {}
    for entry in out.split(b"\0"):
        if not entry:
            continue
        meta, _, path = entry.decode().partition("\t")
        mode, kind, _sha, size = meta.split(None, 3)
        if kind == "blob" and mode != GITLINK_MODE:
            sizes[path] = int(size)
    return sizes


def object_sizes(repo: str, shas: list[str]) -> dict[str, int]:
    if not shas:
        return {}
    out = git(repo, "cat-file", "--batch-check=%(objectname) %(objectsize)", stdin=("\n".join(shas) + "\n").encode())
    sizes: dict[str, int] = {}
    for line in out.decode().splitlines():
        parts = line.split()
        if len(parts) != 2 or not parts[1].isdigit():
            raise GuardError(f"cannot size object: {line!r}")
        sizes[parts[0]] = int(parts[1])
    return sizes


def changes(repo: str, base: str, head: str) -> list[dict]:
    """Added, modified and renamed blobs between base and head: path, old_path, old_sha, new_sha."""
    out = git(repo, "diff", "--raw", "-z", "-M", "--no-abbrev", "--diff-filter=AMR", base, head).split(b"\0")
    items: list[dict] = []
    i = 0
    while i < len(out) and out[i]:
        meta = out[i].decode().lstrip(":").split()
        old_mode, new_mode, old_sha, new_sha, status = meta[:5]
        if status.startswith("R"):
            old_path, path = out[i + 1].decode(), out[i + 2].decode()
            i += 3
        else:
            old_path = path = out[i + 1].decode()
            i += 2
        if GITLINK_MODE in (old_mode, new_mode):
            continue
        items.append({"path": path, "old_path": None if status == "A" else old_path, "old_sha": old_sha, "new_sha": new_sha})
    return items


def check(repo: str, base: str | None, head: str, config_path: str) -> tuple[list[str], list[str]]:
    notes: list[str] = []
    errors: list[str] = []
    cfg = read_config(repo, head, config_path)
    if cfg is None:
        raise GuardError(f"{config_path} does not exist at {head}")
    exts = set(cfg["binary_extensions"])
    threshold = cfg["threshold_bytes"]
    allow: dict[str, int] = cfg["allowlist"]

    head_sizes = tree_sizes(repo, head)
    diff = changes(repo, base, head) if base else []
    renames = {c["path"]: c["old_path"] for c in diff if c["old_path"] and c["old_path"] != c["path"]}

    # Rule 1: every binary over the threshold is allowlisted at no more than its entry.
    for path, size in sorted(head_sizes.items()):
        if size <= threshold or not is_binary(path, exts):
            continue
        if path not in allow:
            errors.append(
                f"{path} is a {size}-byte binary, over the {threshold}-byte threshold, and not in LFS or the allowlist. "
                "Store captures as CI artifacts (apps/pos/docs/design/README.md), or compress the file."
            )
        elif size > allow[path]:
            errors.append(f"{path} grew to {size} bytes; its grandfathered limit is {allow[path]}.")

    # Rule 3: no stale entries.
    for path, limit in sorted(allow.items()):
        size = head_sizes.get(path)
        if size is None:
            errors.append(f"allowlist entry {path} points at a file that no longer exists; remove the entry.")
        elif size <= threshold:
            errors.append(f"allowlist entry {path} is {size} bytes, not over the threshold; remove the entry.")
        elif size < limit:
            errors.append(f"allowlist entry {path} is {limit} but the file is {size} bytes; lower the entry to {size}.")

    # Rule 2 and rule 4 need a base.
    if base is None:
        notes.append("no --base: shrink-only and PR budget checks skipped")
        return errors, notes
    base_cfg = read_config(repo, base, config_path)
    if base_cfg is None:
        notes.append(f"{config_path} is not at the base: bootstrap commit, shrink-only check skipped")
    else:
        for key in ("threshold_bytes", "pr_budget_bytes"):
            if cfg[key] > base_cfg[key]:
                errors.append(f"{key} was raised from {base_cfg[key]} to {cfg[key]}; the guard may only tighten.")
        missing = set(base_cfg["binary_extensions"]) - exts
        if missing:
            errors.append(f"binary_extensions lost {sorted(missing)}; the guard may only widen.")
        for path, limit in sorted(allow.items()):
            origin = path if path in base_cfg["allowlist"] else renames.get(path)
            old_limit = base_cfg["allowlist"].get(origin) if origin else None
            if old_limit is None:
                errors.append(f"allowlist gained {path}; the list is shrink-only (no new entries).")
            elif limit > old_limit:
                errors.append(f"allowlist entry {path} was raised from {old_limit} to {limit}; shrink-only.")

    # Rule 4: the bytes a change adds or grows.
    shas = [c["new_sha"] for c in diff if is_binary(c["path"], exts)] + [
        c["old_sha"] for c in diff if is_binary(c["path"], exts) and c["old_path"] and c["old_sha"] != ZERO_SHA
    ]
    obj = object_sizes(repo, sorted(set(shas)))
    growth: list[tuple[int, str]] = []
    for c in diff:
        if not is_binary(c["path"], exts):
            continue
        before = obj[c["old_sha"]] if c["old_path"] else 0
        delta = obj[c["new_sha"]] - before
        if delta > 0:
            growth.append((delta, c["path"]))
    total = sum(d for d, _ in growth)
    notes.append(f"binary bytes added or grown: {total} of {cfg['pr_budget_bytes']} allowed in {len(growth)} file(s)")
    if total > cfg["pr_budget_bytes"]:
        top = ", ".join(f"{p} (+{d})" for d, p in sorted(growth, reverse=True)[:5])
        errors.append(
            f"this change adds or grows {total} bytes of binaries, over the {cfg['pr_budget_bytes']}-byte budget. Largest: {top}. "
            "Upload captures as CI artifacts and link them from the markdown instead."
        )
    return errors, notes


def generate(repo: str, rev: str, config_path: str) -> dict:
    """A fresh config: the current threshold, budget and extensions, and every over-threshold binary."""
    current = read_config(repo, rev, config_path)
    base_cfg = current or {
        "threshold_bytes": 512000,
        "pr_budget_bytes": 2097152,
        "binary_extensions": ["avif", "gif", "gz", "jpeg", "jpg", "mov", "mp4", "pdf", "png", "tgz", "webm", "webp", "zip", "7z"],
        "allowlist": {},
    }
    exts = set(base_cfg["binary_extensions"])
    allow = {p: s for p, s in sorted(tree_sizes(repo, rev).items()) if s > base_cfg["threshold_bytes"] and is_binary(p, exts)}
    return {**base_cfg, "allowlist": allow}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    chk = sub.add_parser("check")
    chk.add_argument("--repo", default=".")
    chk.add_argument("--base", help="base ref or SHA; enables the shrink-only and budget rules")
    chk.add_argument("--head", default="HEAD")
    chk.add_argument("--config", default=DEFAULT_CONFIG)
    gen = sub.add_parser("generate")
    gen.add_argument("--repo", default=".")
    gen.add_argument("--rev", default="HEAD")
    gen.add_argument("--config", default=DEFAULT_CONFIG)
    args = parser.parse_args(argv)
    try:
        if args.cmd == "generate":
            print(json.dumps(generate(args.repo, args.rev, args.config), indent=2) + "\n", end="")
            return 0
        errors, notes = check(args.repo, args.base, args.head, args.config)
    except GuardError as exc:
        print(f"size-guard: cannot run: {exc}", file=sys.stderr)
        return 2
    for note in notes:
        print(f"size-guard: {note}")
    for err in errors:
        print(f"::error title=size-guard::{err}" if _in_actions() else f"size-guard: FAIL {err}")
    if errors:
        print(f"size-guard: {len(errors)} violation(s)", file=sys.stderr)
        return 1
    print("size-guard: ok")
    return 0


def _in_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS") == "true"


if __name__ == "__main__":
    sys.exit(main())
