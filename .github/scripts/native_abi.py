#!/usr/bin/env python3
"""Every shipped `.node` binary targets the Electron ABI (RT-711 scope item 2, POS Windows package).

  native_abi.py check ASAR --abi N [--pe-arch x64] [--allow-non-addon PATH]...
                                     exit 0 all pass, 1 a problem, 2 unreadable input or bad --abi

The `.node` list comes from the asar header (asar_parity.entries), not a directory walk, so it is
exactly what ships. Each entry must be unpacked (Electron cannot dlopen from inside the archive) and
present under `<asar>.unpacked/`. The ABI is read statically from the registration symbol the addon
exports, as a NUL-terminated string-table entry (Mach-O adds a leading `_`):

  napi_register_module_v1      N-API: ABI-stable, loads under any Electron with N-API
  node_register_module_v<N>    bound to NODE_MODULE_VERSION N, which must equal --abi

A binary with neither symbol is not a Node addon (for example a SQLite loadable extension) and fails
unless its exact path is passed with --allow-non-addon; an allowed path that does not ship fails, so
the allowlist cannot go stale. Foreign-platform prebuilds (ELF, Mach-O) are classified the same way:
they never load on Windows, but one bound to the wrong ABI is still a failure. A Windows (PE) binary
for another machine than --pe-arch fails, and so does a `.node` stored as an asar link. Loading the modules
is RT-830's native smoke, not this check. Stdlib only; every unclear case is a failure.
"""
import argparse
import os
import re
import struct
import sys

from asar_parity import AsarError, entries

NAPI_RE = re.compile(rb"\x00_?napi_register_module_v1\x00")
ABI_RE = re.compile(rb"\x00_?node_register_module_v([1-9]\d*)\x00")
PE_MACHINES = {0x8664: "x64", 0xAA64: "arm64", 0x14C: "ia32"}
MACHO_MAGICS = {bytes.fromhex(m) for m in ("cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe")}


def binary_format(data):
    if data[:2] == b"MZ" and len(data) >= 0x40:
        (pe_off,) = struct.unpack_from("<I", data, 0x3C)
        if data[pe_off:pe_off + 4] == b"PE\0\0" and len(data) >= pe_off + 6:
            (machine,) = struct.unpack_from("<H", data, pe_off + 4)
            return f"pe-{PE_MACHINES.get(machine, hex(machine))}"
        return None
    if data[:4] == b"\x7fELF":
        return "elf"
    if data[:4] in MACHO_MAGICS:
        return "macho"
    return None


def classify(rel, data, expected_abi, allowed, pe_arch="x64"):
    """(row, problem or None) for one unpacked `.node` file."""
    fmt = binary_format(data)
    row = {"path": rel, "format": fmt or "unknown", "kind": "unknown"}
    if fmt is None:
        return row, f"{rel}: not a PE, ELF or Mach-O binary"
    if fmt.startswith("pe-") and fmt != f"pe-{pe_arch}":
        return row, f"{rel}: Windows binary for {fmt[3:]}, the package is {pe_arch}"
    abis = sorted({int(n) for n in ABI_RE.findall(data)})
    if abis:
        row["kind"] = "abi-" + "+".join(map(str, abis))
        if abis != [expected_abi]:
            other = ", ".join(str(n) for n in abis if n != expected_abi) or str(abis)
            return row, f"{rel}: built for ABI {other}, Electron is {expected_abi}"
        return row, None
    if NAPI_RE.search(data):
        row["kind"] = "napi"
        return row, None
    if rel in allowed:
        row["kind"] = "non-addon (allowed)"
        return row, None
    return row, f"{rel}: no Node addon registration symbol (N-API or ABI)"


def check(asar, expected_abi, allow=(), pe_arch="x64"):
    """(rows, problems) for every `.node` entry in the archive header."""
    allowed = set(allow)
    nodes = {rel: e for rel, e in entries(asar).items() if rel.endswith(".node") and e["kind"] != "dir"}
    if not nodes:
        return [], ["no .node file in the archive: nothing was checked"]
    rows, problems = [], []
    for rel, e in sorted(nodes.items()):
        if e["kind"] == "link":
            rows.append({"path": rel, "format": "link", "kind": "unknown"})
            problems.append(f"{rel}: is a link to {e['link']} (not classified; refusing to pass)")
            continue
        if not e["unpacked"]:
            rows.append({"path": rel, "format": "packed", "kind": "unknown"})
            problems.append(f"{rel}: packed inside app.asar (Electron cannot load it)")
            continue
        disk = os.path.join(asar + ".unpacked", *rel.split("/"))
        try:
            with open(disk, "rb") as fh:
                data = fh.read()
        except FileNotFoundError:
            rows.append({"path": rel, "format": "missing", "kind": "unknown"})
            problems.append(f"{rel}: missing from app.asar.unpacked")
            continue
        except OSError as exc:
            raise AsarError(f"{disk}: {exc}") from exc
        row, problem = classify(rel, data, expected_abi, allowed, pe_arch)
        rows.append(row)
        if problem:
            problems.append(problem)
    problems += [f"allowed non-addon not shipped: {p}" for p in sorted(allowed - set(nodes))]
    return rows, problems


def main(argv=None):
    parser = argparse.ArgumentParser(prog="native_abi")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_check = sub.add_parser("check")
    p_check.add_argument("asar")
    p_check.add_argument("--abi", required=True, help="NODE_MODULE_VERSION of the shipped Electron")
    p_check.add_argument("--allow-non-addon", action="append", default=[], metavar="PATH",
                         help="exact archive path of a .node file that is not a Node addon (repeatable)")
    p_check.add_argument("--pe-arch", default="x64", choices=sorted(PE_MACHINES.values()),
                         help="machine every Windows (PE) .node must target (default x64)")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[1-9][0-9]*", args.abi):
        print(f"native_abi: --abi must be a positive integer, got {args.abi!r}", file=sys.stderr)
        return 2
    expected = int(args.abi)
    try:
        rows, problems = check(args.asar, expected, args.allow_non_addon, args.pe_arch)
    except AsarError as exc:
        print(f"native_abi: {exc}", file=sys.stderr)
        return 2
    for r in rows:
        print(f"{r['path']}\t{r['format']}\t{r['kind']}")
    if problems:
        print(f"native ABI check failed ({len(problems)}):")
        for line in problems:
            print(f"  {line}")
        return 1
    print(f"{len(rows)} .node files target Electron ABI {expected} (N-API or ABI {expected})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
