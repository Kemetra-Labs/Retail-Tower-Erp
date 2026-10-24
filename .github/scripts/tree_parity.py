#!/usr/bin/env python3
"""Shadow apps/pos equals the pinned POS source tree, apart from an exact Shadow-only allowlist (RT-711 item 2).

  tree_parity.py compare SOURCE_LS SHADOW_LS [--shadow-only PATH]... [--shadow-modified PATH=SOURCE_OID]...
                                     exit 0 equal, 1 a difference, 2 unreadable listing or bad argument

Each listing is `git ls-tree -r -z` output (source: `HEAD` of the source checkout; Shadow:
`HEAD:apps/pos`), so every entry carries mode, type and object id and the comparison is as strict as
the old tree-hash equality, minus empty directories, which git does not record either way.

The allowlist exists for files Shadow must carry and the source does not, such as the RT-710 license
and NOTICE files. Every allowlisted path must be present in Shadow as a regular file (100644 or
100755), and must be absent from the source: once upstream has the file it is compared like any other,
so the entry has to be removed. Paths match exactly, never as a prefix.

--shadow-modified is for a file both trees carry that Shadow edited (RT-710 extended POS's NOTICE). The
pin is the source object id: the source must still hold exactly that regular file, so an upstream edit
fails until the Shadow edit is re-reviewed and re-pinned; Shadow must hold a regular file that differs
from it (an equal one makes the pin stale). Any other difference fails. Stdlib only.
"""
import argparse
import re
import sys

OID_RE = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
ENTRY_RE = re.compile(r"(\d{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t(.+)", re.S)
REGULAR = {("100644", "blob"), ("100755", "blob")}


class TreeError(Exception):
    pass


def parse(data):
    """{path: (mode, type, oid)} from `git ls-tree -r -z` bytes."""
    entries = {}
    for raw in data.split(b"\0"):
        if not raw:
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise TreeError(f"entry is not UTF-8: {raw[:60]!r}") from exc
        m = ENTRY_RE.fullmatch(text)
        if not m:
            raise TreeError(f"not a ls-tree entry: {text[:80]!r}")
        mode, kind, oid, path = m.groups()
        if path in entries:
            raise TreeError(f"duplicate path: {path}")
        entries[path] = (mode, kind, oid)
    return entries


def _show(entry):
    mode, kind, oid = entry
    return f"{mode} {kind} {oid[:12]}"


def _check_shadow_only(source, shadow, path):
    if path in source:
        return f"allowlisted Shadow-only path also exists in source: {path}"
    if path not in shadow:
        return f"allowlisted Shadow-only path not in Shadow: {path}"
    if shadow[path][:2] not in REGULAR:
        mode, kind, _ = shadow[path]
        return f"allowlisted Shadow-only path is not a regular file: {path} ({mode} {kind})"
    return None


def _check_shadow_modified(source, shadow, path, pin):
    if path not in source:
        return f"Shadow-modified path not in source: {path}"
    if source[path][:2] not in REGULAR or source[path][2] != pin:
        return f"Shadow-modified path changed in source: {path} (pinned {pin[:12]}, source {_show(source[path])})"
    if path not in shadow:
        return f"Shadow-modified path not in Shadow: {path}"
    if shadow[path][:2] not in REGULAR:
        mode, kind, _ = shadow[path]
        return f"Shadow-modified path is not a regular file in Shadow: {path} ({mode} {kind})"
    if shadow[path][0] != source[path][0]:
        return f"Shadow-modified path changed mode: {path} (source {source[path][0]}, Shadow {shadow[path][0]})"
    if shadow[path] == source[path]:
        return f"Shadow-modified path equals source, drop the pin: {path}"
    return None


def compare(source, shadow, shadow_only=(), shadow_modified=None):
    """Problems (empty when equal) between two parsed listings.

    shadow_only: paths only Shadow carries; shadow_modified: {path: pinned source oid}.
    """
    if not source:
        return ["source tree is empty: nothing was compared"]
    only, modified = set(shadow_only), dict(shadow_modified or {})
    problems = [f"path is both Shadow-only and Shadow-modified: {p}" for p in sorted(only & set(modified))]
    for path in sorted(only - set(modified)):
        problem = _check_shadow_only(source, shadow, path)
        if problem:
            problems.append(problem)
    for path, pin in sorted(modified.items()):
        problem = _check_shadow_modified(source, shadow, path, pin)
        if problem:
            problems.append(problem)
    # Excepted paths leave the general comparison; one that broke its own rule is already reported.
    excepted = only | set(modified)
    src = {p: e for p, e in source.items() if p not in excepted}
    rest = {p: e for p, e in shadow.items() if p not in excepted}
    for path in sorted(set(src) | set(rest)):
        if path not in rest:
            problems.append(f"only in source: {path}")
        elif path not in src:
            problems.append(f"only in Shadow: {path}")
        elif src[path] != rest[path]:
            problems.append(f"differs: {path} (source {_show(src[path])}, Shadow {_show(rest[path])})")
    return problems


def _pin(value):
    path, sep, oid = value.partition("=")
    if not sep or not path or not OID_RE.fullmatch(oid):
        raise TreeError(f"--shadow-modified wants PATH=<full source object id>, got {value!r}")
    return path, oid


def _read(path):
    try:
        with open(path, "rb") as fh:
            return parse(fh.read())
    except OSError as exc:
        raise TreeError(f"{path}: {exc}") from exc


def main(argv=None):
    parser = argparse.ArgumentParser(prog="tree_parity")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_cmp = sub.add_parser("compare")
    p_cmp.add_argument("source_ls")
    p_cmp.add_argument("shadow_ls")
    p_cmp.add_argument("--shadow-only", action="append", default=[], metavar="PATH",
                       help="exact path (relative to the product root) that only Shadow carries (repeatable)")
    p_cmp.add_argument("--shadow-modified", action="append", default=[], metavar="PATH=SOURCE_OID",
                       help="exact path Shadow edited, pinned to the source object id (repeatable)")
    args = parser.parse_args(argv)
    try:
        pins = {}
        for path, oid in map(_pin, args.shadow_modified):
            if path in pins:
                raise TreeError(f"--shadow-modified given twice for {path}")
            pins[path] = oid
        source, shadow = _read(args.source_ls), _read(args.shadow_ls)
    except TreeError as exc:
        print(f"tree_parity: {exc}", file=sys.stderr)
        return 2
    problems = compare(source, shadow, args.shadow_only, pins)
    if problems:
        print(f"tree parity failed ({len(problems)}):")
        for line in problems:
            print(f"  {line}")
        return 1
    for path in sorted(set(args.shadow_only)):
        print(f"Shadow-only: {path}\t{_show(shadow[path])}")
    for path in sorted(pins):
        print(f"Shadow-modified: {path}\tsource {_show(source[path])}, Shadow {_show(shadow[path])}")
    same = len(source) - len(pins)
    print(f"{same} entries identical; {len(set(args.shadow_only))} Shadow-only, {len(pins)} Shadow-modified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
