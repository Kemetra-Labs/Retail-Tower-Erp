"""Unit tests for asar_parity.py (RT-711 scope item 2, `app.asar` file list). Stdlib only.

Archives are synthesised here in the asar layout (Chromium Pickle header, then file bodies), so no
Electron toolchain is needed. `make_asar` is the writer under test's counterpart; the reader is
the code under test.
"""
import contextlib
import hashlib
import io
import json
import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import asar_parity as ap  # noqa: E402


def make_asar(tree, path):
    """tree: {"dir": {"file.js": b"..." | ("unpacked", size) | ("link", target)}} nested dicts."""
    body = bytearray()

    def node(entry):
        if isinstance(entry, dict):
            return {"files": {name: node(child) for name, child in sorted(entry.items())}}
        if isinstance(entry, tuple) and entry[0] == "link":
            return {"link": entry[1]}
        if isinstance(entry, tuple) and entry[0] == "unpacked":
            return {"size": entry[1], "unpacked": True, "offset": "0",
                    "integrity": {"algorithm": "SHA256", "hash": "0" * 64, "blockSize": 4194304, "blocks": ["0" * 64]}}
        data = entry
        offset = len(body)
        body.extend(data)
        digest = hashlib.sha256(data).hexdigest()
        return {"size": len(data), "offset": str(offset),
                "integrity": {"algorithm": "SHA256", "hash": digest, "blockSize": 4194304, "blocks": [digest]}}

    header = json.dumps(node(tree), separators=(",", ":")).encode()
    pad = (-len(header)) % 4
    pickle_payload = struct.pack("<I", len(header)) + header + b"\0" * pad
    pickle = struct.pack("<I", len(pickle_payload)) + pickle_payload
    with open(path, "wb") as fh:
        fh.write(struct.pack("<I", 4) + struct.pack("<I", len(pickle)) + pickle + bytes(body))


BASE_TREE = {
    "package.json": b'{"name":"pos"}',
    "dist": {"main": {"index.js": b"console.log(1)"}, "preload.js": b"x"},
    "node_modules": {"argon2": {"build": {"Release": {"argon2.node": ("unpacked", 9)}}}},
}


class Tmp(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.dir = self._td.name

    def asar(self, name, tree):
        path = os.path.join(self.dir, name)
        make_asar(tree, path)
        return path


class ReadTests(Tmp):
    def test_flatten_lists_files_with_posix_paths_sorted(self):
        entries = ap.entries(self.asar("a.asar", BASE_TREE))
        self.assertEqual(
            sorted(entries),
            ["dist/main/index.js", "dist/preload.js", "node_modules/argon2/build/Release/argon2.node", "package.json"],
        )

    def test_unpacked_flag_and_size_recorded(self):
        entries = ap.entries(self.asar("a.asar", BASE_TREE))
        node = entries["node_modules/argon2/build/Release/argon2.node"]
        self.assertTrue(node["unpacked"])
        self.assertEqual(node["size"], 9)
        self.assertFalse(entries["package.json"]["unpacked"])

    def test_links_are_listed_with_target(self):
        entries = ap.entries(self.asar("a.asar", {"bin": {"tool": ("link", "../x")}}))
        self.assertEqual(entries["bin/tool"]["link"], "../x")

    def test_manifest_lines_are_stable_text(self):
        lines = ap.manifest(self.asar("a.asar", {"a.txt": b"hi"}))
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("a.txt\t"))

    def test_empty_directory_tree_is_an_empty_list(self):
        self.assertEqual(ap.entries(self.asar("a.asar", {})), {})

    def test_truncated_file_is_an_error(self):
        path = self.asar("a.asar", BASE_TREE)
        with open(path, "rb") as fh:
            data = fh.read()
        with open(path, "wb") as fh:
            fh.write(data[:12])
        with self.assertRaises(ap.AsarError):
            ap.entries(path)

    def test_bad_magic_is_an_error(self):
        path = os.path.join(self.dir, "bad.asar")
        with open(path, "wb") as fh:
            fh.write(b"\x09\x00\x00\x00" + b"\0" * 64)
        with self.assertRaises(ap.AsarError):
            ap.entries(path)

    def test_header_that_is_not_json_is_an_error(self):
        path = os.path.join(self.dir, "bad.asar")
        junk = b"not json!"
        payload = struct.pack("<I", len(junk)) + junk + b"\0" * ((-len(junk)) % 4)
        pickle = struct.pack("<I", len(payload)) + payload
        with open(path, "wb") as fh:
            fh.write(struct.pack("<I", 4) + struct.pack("<I", len(pickle)) + pickle)
        with self.assertRaises(ap.AsarError):
            ap.entries(path)

    def test_missing_file_is_an_error(self):
        with self.assertRaises(ap.AsarError):
            ap.entries(os.path.join(self.dir, "nope.asar"))

    def test_path_traversal_name_in_header_is_rejected(self):
        with self.assertRaises(ap.AsarError):
            ap.entries(self.asar("a.asar", {"..": {"evil": b"x"}}))


class CompareTests(Tmp):
    def compare(self, a_tree, b_tree, **kw):
        return ap.compare(ap.entries(self.asar("a.asar", a_tree)), ap.entries(self.asar("b.asar", b_tree)), **kw)

    def test_identical_archives_have_no_problems(self):
        self.assertEqual(self.compare(BASE_TREE, BASE_TREE), [])

    def test_extra_file_on_one_side_is_reported(self):
        other = dict(BASE_TREE, **{"extra.js": b"1"})
        problems = self.compare(BASE_TREE, other)
        self.assertEqual(problems, ["only in B: extra.js"])

    def test_missing_file_is_reported_against_the_other_side(self):
        other = {k: v for k, v in BASE_TREE.items() if k != "package.json"}
        self.assertEqual(self.compare(BASE_TREE, other), ["only in A: package.json"])

    def test_unpacked_flag_difference_is_a_list_difference(self):
        other = {"package.json": b'{"name":"pos"}',
                 "dist": BASE_TREE["dist"],
                 "node_modules": {"argon2": {"build": {"Release": {"argon2.node": b"123456789"}}}}}
        problems = self.compare(BASE_TREE, other)
        self.assertEqual(len(problems), 1)
        self.assertIn("unpacked differs: node_modules/argon2/build/Release/argon2.node", problems[0])

    def test_link_target_difference_is_reported(self):
        problems = self.compare({"bin": {"t": ("link", "a")}}, {"bin": {"t": ("link", "b")}})
        self.assertEqual(len(problems), 1)
        self.assertIn("link differs: bin/t", problems[0])

    def test_content_difference_is_ignored_by_default(self):
        other = dict(BASE_TREE, **{"package.json": b'{"name":"xx"}'})
        self.assertEqual(self.compare(BASE_TREE, other), [])

    def test_content_difference_is_reported_when_strict(self):
        other = dict(BASE_TREE, **{"package.json": b'{"name":"xx"}'})
        problems = self.compare(BASE_TREE, other, strict_content=True)
        self.assertEqual(len(problems), 1)
        self.assertIn("content differs: package.json", problems[0])

    def test_empty_directory_difference_is_reported(self):
        a = dict(BASE_TREE, **{"emptydir": {}})
        problems = self.compare(a, BASE_TREE)
        self.assertEqual(problems, ["only in A: emptydir"])

    def test_require_reports_a_path_missing_on_either_side(self):
        a = ap.entries(self.asar("a.asar", BASE_TREE))
        b = ap.entries(self.asar("b.asar", {"dist": BASE_TREE["dist"]}))
        problems = ap.compare(a, b, require=["package.json", "dist/preload.js"])
        self.assertIn("required path missing in B: package.json", problems)
        self.assertFalse([p for p in problems if "dist/preload.js" in p and "required" in p])

    def test_require_passes_when_present_on_both_sides(self):
        self.assertEqual(self.compare(BASE_TREE, BASE_TREE, require=["package.json"]), [])

    def test_both_empty_is_a_problem(self):
        self.assertEqual(self.compare({}, {}), ["both archives are empty: nothing was compared"])


class CliTests(Tmp):
    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = ap.main(list(argv))
        return rc, out.getvalue(), err.getvalue()

    def test_list_prints_one_line_per_entry(self):
        rc, out, _ = self.run_cli("list", self.asar("a.asar", BASE_TREE))
        self.assertEqual(rc, 0)
        self.assertEqual(len(out.strip().splitlines()), 4)

    def test_compare_equal_exits_zero(self):
        a, b = self.asar("a.asar", BASE_TREE), self.asar("b.asar", BASE_TREE)
        rc, out, _ = self.run_cli("compare", a, b)
        self.assertEqual(rc, 0)
        self.assertIn("identical", out)

    def test_compare_diff_exits_one_and_names_the_file(self):
        a = self.asar("a.asar", BASE_TREE)
        b = self.asar("b.asar", dict(BASE_TREE, **{"extra.js": b"1"}))
        rc, out, err = self.run_cli("compare", a, b)
        self.assertEqual(rc, 1)
        self.assertIn("extra.js", out + err)

    def test_require_flag_fails_when_path_absent(self):
        a, b = self.asar("a.asar", {"x.js": b"1"}), self.asar("b.asar", {"x.js": b"1"})
        rc, out, _ = self.run_cli("compare", a, b, "--require", "package.json")
        self.assertEqual(rc, 1)
        self.assertIn("required path missing in A: package.json", out)

    def test_unreadable_input_exits_two(self):
        rc, _, err = self.run_cli("compare", os.path.join(self.dir, "x"), os.path.join(self.dir, "y"))
        self.assertEqual(rc, 2)
        self.assertIn("asar_parity", err)


if __name__ == "__main__":
    unittest.main()
