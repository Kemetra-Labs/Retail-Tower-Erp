#!/usr/bin/env python3
"""`app.asar` file-list parity for the POS Windows package (RT-711 scope item 2).

  asar_parity.py list ASAR                         one line per entry: path, kind, unpacked, size, sha256
  asar_parity.py compare A B [--strict-content]    exit 0 identical, 1 differ, 2 unreadable input

Reads only the asar header (Chromium Pickle: u32 4, u32 pickle size, u32 payload size, u32 JSON
length, JSON), never the file bodies. The verdict is the file list: the set of paths, whether each is
unpacked, and each link target. File content (the per-file SHA-256 in the header) is compared only
with --strict-content. Stdlib only. Every unclear situation (truncated or malformed archive, both
sides empty) is a failure: this check must not pass because nothing was compared.
"""
import argparse
import json
import struct
import sys


class AsarError(Exception):
    """The archive cannot be read or is malformed (always a failing exit)."""


def read_header(path):
    try:
        with open(path, "rb") as fh:
            prefix = fh.read(16)
            if len(prefix) < 16:
                raise AsarError(f"{path}: shorter than the 16-byte asar prefix")
            size_pickle, pickle_size, payload_size, json_len = struct.unpack("<4I", prefix)
            if size_pickle != 4:
                raise AsarError(f"{path}: not an asar archive (size prefix {size_pickle}, expected 4)")
            if payload_size != pickle_size - 4 or json_len > payload_size - 4:
                raise AsarError(f"{path}: inconsistent header sizes ({pickle_size}, {payload_size}, {json_len})")
            raw = fh.read(json_len)
    except OSError as exc:
        raise AsarError(f"{path}: {exc}") from exc
    if len(raw) != json_len:
        raise AsarError(f"{path}: truncated header ({len(raw)} of {json_len} bytes)")
    try:
        header = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise AsarError(f"{path}: header is not JSON: {exc}") from exc
    if not isinstance(header, dict):
        raise AsarError(f"{path}: header is not an object")
    return header


def _walk(node, prefix, out, path):
    files = node.get("files")
    if not isinstance(files, dict):
        raise AsarError(f"{path}: directory entry '{prefix or '.'}' has no 'files' object")
    for name, child in files.items():
        if name in ("", ".", "..") or "/" in name or "\\" in name:
            raise AsarError(f"{path}: unsafe entry name {name!r} under '{prefix or '.'}'")
        rel = f"{prefix}{name}"
        if not isinstance(child, dict):
            raise AsarError(f"{path}: entry '{rel}' is not an object")
        if "files" in child:
            _walk(child, rel + "/", out, path)
        elif "link" in child:
            out[rel] = {"kind": "link", "link": child["link"], "unpacked": bool(child.get("unpacked")),
                        "size": None, "sha256": None}
        else:
            integrity = child.get("integrity") or {}
            out[rel] = {"kind": "file", "link": None, "unpacked": bool(child.get("unpacked")),
                        "size": child.get("size"), "sha256": integrity.get("hash")}


def entries(path):
    """{posix path: {kind, link, unpacked, size, sha256}} for every file and link in the archive."""
    out = {}
    _walk(read_header(path), "", out, path)
    return out


def manifest(path):
    found = entries(path)
    return [
        "\t".join([rel, e["kind"] if e["link"] is None else f"link->{e['link']}",
                   "unpacked" if e["unpacked"] else "packed", str(e["size"]), str(e["sha256"])])
        for rel, e in sorted(found.items())
    ]


def compare(a, b, strict_content=False):
    if not a and not b:
        return ["both archives are empty: nothing was compared"]
    problems = [f"only in A: {p}" for p in sorted(set(a) - set(b))]
    problems += [f"only in B: {p}" for p in sorted(set(b) - set(a))]
    for rel in sorted(set(a) & set(b)):
        x, y = a[rel], b[rel]
        if x["kind"] != y["kind"]:
            problems.append(f"kind differs: {rel} ({x['kind']} vs {y['kind']})")
        elif x["link"] != y["link"]:
            problems.append(f"link differs: {rel} ({x['link']} vs {y['link']})")
        elif x["unpacked"] != y["unpacked"]:
            problems.append(f"unpacked differs: {rel} ({x['unpacked']} vs {y['unpacked']})")
        elif strict_content and (x["sha256"], x["size"]) != (y["sha256"], y["size"]):
            problems.append(f"content differs: {rel}")
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser(prog="asar_parity")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_list = sub.add_parser("list")
    p_list.add_argument("asar")
    p_cmp = sub.add_parser("compare")
    p_cmp.add_argument("a")
    p_cmp.add_argument("b")
    p_cmp.add_argument("--strict-content", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.cmd == "list":
            print("\n".join(manifest(args.asar)))
            return 0
        a, b = entries(args.a), entries(args.b)
    except AsarError as exc:
        print(f"asar_parity: {exc}", file=sys.stderr)
        return 2
    problems = compare(a, b, args.strict_content)
    if problems:
        print(f"asar file lists differ ({len(problems)}):")
        for line in problems:
            print(f"  {line}")
        return 1
    print(f"asar file lists identical ({len(a)} entries)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
