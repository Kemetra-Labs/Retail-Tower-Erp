"""Unit tests for native_abi.py (RT-711 scope item 2, every `.node` targets the Electron ABI). Stdlib only.

Archives come from test_asar_parity.make_asar; the `.node` bodies are synthetic bytes with the real
magic numbers and the NUL-terminated registration symbols a linker writes into the string table, so
no compiler or Electron is needed.
"""
import contextlib
import io
import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import native_abi as na  # noqa: E402
from test_asar_parity import make_asar  # noqa: E402

NAPI = b"\0napi_register_module_v1\0"


def pe(*symbols, machine=0x8664):
    head = bytearray(b"MZ" + b"\0" * 0x3E)
    struct.pack_into("<I", head, 0x3C, 0x40)
    return bytes(head) + b"PE\0\0" + struct.pack("<H", machine) + b"\0" * 18 + b"".join(symbols)


def elf(*symbols):
    return b"\x7fELF" + b"\0" * 60 + b"".join(symbols)


def macho(*symbols):
    return bytes.fromhex("cffaedfe") + b"\0" * 28 + b"".join(symbols)


def abi(n):
    return b"\0node_register_module_v%d\0" % n


SQLITE_EXT = "node_modules/better-sqlite3/build/Release/test_extension.node"


class Pkg(unittest.TestCase):
    """A package dir: resources/app.asar plus resources/app.asar.unpacked/<rel> bodies."""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.asar = os.path.join(self._td.name, "app.asar")

    def build(self, nodes, packed=(), skip_disk=()):
        """nodes: {rel: bytes}; rel in `packed` is stored inside the archive, in `skip_disk` not unpacked."""
        tree = {"package.json": b"{}"}
        for rel, data in nodes.items():
            cur = tree
            *dirs, name = rel.split("/")
            for d in dirs:
                cur = cur.setdefault(d, {})
            cur[name] = data if rel in packed else ("unpacked", len(data))
            if rel in packed or rel in skip_disk:
                continue
            target = os.path.join(self.asar + ".unpacked", *rel.split("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as fh:
                fh.write(data)
        make_asar(tree, self.asar)
        return self.asar

    def check(self, nodes, expected_abi=149, allow=(), **kw):
        rows, problems = na.check(self.build(nodes, **kw), expected_abi, allow)
        return {r["path"]: r for r in rows}, problems


class Classify(Pkg):
    def test_real_package_shape_passes(self):
        rows, problems = self.check({
            "node_modules/argon2/build/Release/argon2.node": pe(NAPI),
            "node_modules/argon2/prebuilds/linux-x64/argon2.glibc.node": elf(NAPI),
            "node_modules/argon2/prebuilds/darwin-x64/argon2.glibc.node": macho(b"\0_napi_register_module_v1\0"),
            "node_modules/better-sqlite3/build/Release/better_sqlite3.node": pe(abi(149)),
            SQLITE_EXT: pe(b"\0sqlite3_extension_init\0"),
        }, allow=[SQLITE_EXT])
        self.assertEqual(problems, [])
        self.assertEqual(rows["node_modules/argon2/build/Release/argon2.node"]["kind"], "napi")
        self.assertEqual(rows["node_modules/argon2/prebuilds/linux-x64/argon2.glibc.node"]["format"], "elf")
        self.assertEqual(rows["node_modules/argon2/prebuilds/darwin-x64/argon2.glibc.node"]["format"], "macho")
        self.assertEqual(rows["node_modules/better-sqlite3/build/Release/better_sqlite3.node"]["kind"], "abi-149")
        self.assertEqual(rows[SQLITE_EXT]["kind"], "non-addon (allowed)")
        self.assertEqual(rows["node_modules/argon2/build/Release/argon2.node"]["format"], "pe-x64")

    def test_abi_mismatch_fails(self):
        _, problems = self.check({"node_modules/m/m.node": pe(abi(137))})
        self.assertEqual(problems, ["node_modules/m/m.node: built for ABI 137, Electron is 149"])

    def test_abi_mismatch_fails_on_foreign_platform_too(self):
        _, problems = self.check({"node_modules/m/m.node": elf(abi(137))})
        self.assertEqual(len(problems), 1)

    def test_two_different_abis_fail(self):
        _, problems = self.check({"node_modules/m/m.node": pe(abi(149), abi(137))})
        self.assertEqual(len(problems), 1)
        self.assertIn("137", problems[0])

    def test_abi_symbol_wins_over_napi(self):
        # An addon that exports both is still bound to one ABI.
        rows, problems = self.check({"node_modules/m/m.node": pe(NAPI, abi(137))})
        self.assertEqual(len(problems), 1)

    def test_unregistered_pe_fails_unless_allowed(self):
        _, problems = self.check({SQLITE_EXT: pe(b"\0sqlite3_extension_init\0")})
        self.assertEqual(problems, [f"{SQLITE_EXT}: no Node addon registration symbol (N-API or ABI)"])

    def test_unanchored_symbol_text_does_not_count(self):
        # A message string that merely contains the symbol name is not an export.
        _, problems = self.check({"node_modules/m/m.node": pe(b"\0missing napi_register_module_v1 export\0")})
        self.assertEqual(len(problems), 1)

    def test_allowlisted_path_that_is_an_addon_is_classified_normally(self):
        rows, problems = self.check({SQLITE_EXT: pe(abi(137))}, allow=[SQLITE_EXT])
        self.assertEqual(len(problems), 1)

    def test_stale_allowlist_entry_fails(self):
        _, problems = self.check({"node_modules/m/m.node": pe(NAPI)}, allow=[SQLITE_EXT])
        self.assertEqual(problems, [f"allowed non-addon not shipped: {SQLITE_EXT}"])

    def test_unknown_format_fails(self):
        _, problems = self.check({"node_modules/m/m.node": b"#!/bin/sh\0napi_register_module_v1\0"})
        self.assertEqual(problems, ["node_modules/m/m.node: not a PE, ELF or Mach-O binary"])

    def test_truncated_pe_is_unknown(self):
        _, problems = self.check({"node_modules/m/m.node": b"MZ" + NAPI})
        self.assertEqual(len(problems), 1)


class Layout(Pkg):
    def test_packed_node_fails(self):
        _, problems = self.check({"node_modules/m/m.node": pe(NAPI)}, packed={"node_modules/m/m.node"})
        self.assertEqual(problems, ["node_modules/m/m.node: packed inside app.asar (Electron cannot load it)"])

    def test_missing_unpacked_file_fails(self):
        _, problems = self.check({"node_modules/m/m.node": pe(NAPI)}, skip_disk={"node_modules/m/m.node"})
        self.assertEqual(problems, ["node_modules/m/m.node: missing from app.asar.unpacked"])

    def test_no_node_files_fails(self):
        _, problems = self.check({})
        self.assertEqual(problems, ["no .node file in the archive: nothing was checked"])

    def test_only_node_suffix_is_checked(self):
        rows, problems = self.check({"node_modules/m/m.node": pe(NAPI), "node_modules/m/readme.node.md": b"x"})
        self.assertEqual(sorted(rows), ["node_modules/m/m.node"])
        self.assertEqual(problems, [])


class Cli(Pkg):
    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = na.main(argv)
        return rc, out.getvalue(), err.getvalue()

    def test_pass_prints_report(self):
        asar = self.build({"node_modules/m/m.node": pe(abi(149))})
        rc, out, _ = self.run_main(["check", asar, "--abi", "149"])
        self.assertEqual(rc, 0)
        self.assertIn("node_modules/m/m.node\tpe-x64\tabi-149", out)
        self.assertIn("1 .node files target Electron ABI 149", out)

    def test_fail_exit_1(self):
        asar = self.build({"node_modules/m/m.node": pe(abi(137))})
        rc, out, _ = self.run_main(["check", asar, "--abi", "149"])
        self.assertEqual(rc, 1)
        self.assertIn("built for ABI 137", out)

    def test_allow_flag(self):
        asar = self.build({SQLITE_EXT: pe()})
        rc, _, _ = self.run_main(["check", asar, "--abi", "149", "--allow-non-addon", SQLITE_EXT])
        self.assertEqual(rc, 0)

    def test_unreadable_archive_exit_2(self):
        with open(self.asar, "wb") as fh:
            fh.write(b"nope")
        rc, _, err = self.run_main(["check", self.asar, "--abi", "149"])
        self.assertEqual(rc, 2)
        self.assertIn("native_abi:", err)

    def test_abi_must_be_digits(self):
        asar = self.build({"node_modules/m/m.node": pe(NAPI)})
        for bad in ("", "14x", "-1", "0"):
            with self.subTest(bad=bad):
                rc, _, _ = self.run_main(["check", asar, "--abi", bad])
                self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
