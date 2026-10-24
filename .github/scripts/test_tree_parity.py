"""Unit tests for tree_parity.py (RT-711 scope item 2, Shadow apps/pos equals the pinned POS source
apart from an exact allowlist of Shadow-only files). Stdlib only: listings are synthetic
`git ls-tree -r -z` output, so no repository is needed.
"""
import contextlib
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tree_parity as tp  # noqa: E402

A = "a" * 40
B = "b" * 40
C = "c" * 40


def ls(*rows):
    """rows: (path, sha) or (path, sha, mode, type) -> `git ls-tree -r -z` bytes."""
    out = b""
    for row in rows:
        path, sha = row[0], row[1]
        mode = row[2] if len(row) > 2 else "100644"
        kind = row[3] if len(row) > 3 else "blob"
        out += f"{mode} {kind} {sha}\t{path}".encode() + b"\0"
    return out


SOURCE = ls(("package.json", A), ("src/main.ts", B))
NOTICE = "NOTICE"


class Compare(unittest.TestCase):
    def compare(self, source, shadow, allow=()):
        return tp.compare(tp.parse(source), tp.parse(shadow), allow)

    def test_identical_trees_pass(self):
        self.assertEqual(self.compare(SOURCE, SOURCE), [])

    def test_allowlisted_shadow_only_file_passes(self):
        self.assertEqual(self.compare(SOURCE, SOURCE + ls((NOTICE, C)), [NOTICE]), [])

    def test_shadow_only_file_not_allowlisted_fails(self):
        self.assertEqual(self.compare(SOURCE, SOURCE + ls((NOTICE, C))),
                         [f"only in Shadow: {NOTICE}"])

    def test_source_only_file_fails(self):
        self.assertEqual(self.compare(SOURCE + ls(("extra.ts", C)), SOURCE), ["only in source: extra.ts"])

    def test_content_difference_fails(self):
        self.assertEqual(self.compare(SOURCE, ls(("package.json", A), ("src/main.ts", C))),
                         ["differs: src/main.ts (source 100644 blob bbbbbbbbbbbb, Shadow 100644 blob cccccccccccc)"])

    def test_mode_difference_fails(self):
        problems = self.compare(SOURCE, ls(("package.json", A), ("src/main.ts", B, "100755")))
        self.assertEqual(len(problems), 1)
        self.assertIn("differs: src/main.ts", problems[0])

    def test_allowlisted_path_present_upstream_fails(self):
        # Upstream gained the file: the Shadow copy is no longer Shadow-only, drop it from the list.
        problems = self.compare(SOURCE + ls((NOTICE, C)), SOURCE + ls((NOTICE, C)), [NOTICE])
        self.assertEqual(problems, [f"allowlisted Shadow-only path also exists in source: {NOTICE}"])

    def test_allowlisted_path_missing_from_shadow_fails(self):
        self.assertEqual(self.compare(SOURCE, SOURCE, [NOTICE]),
                         [f"allowlisted Shadow-only path not in Shadow: {NOTICE}"])

    def test_allowlisted_path_must_be_regular_file(self):
        for mode, kind in (("120000", "blob"), ("160000", "commit")):
            with self.subTest(mode=mode):
                problems = self.compare(SOURCE, SOURCE + ls((NOTICE, C, mode, kind)), [NOTICE])
                self.assertEqual(problems, [f"allowlisted Shadow-only path is not a regular file: {NOTICE} ({mode} {kind})"])

    def test_allowlist_is_exact_not_prefix(self):
        problems = self.compare(SOURCE, SOURCE + ls(("NOTICE.extra", C)), [NOTICE])
        self.assertIn("only in Shadow: NOTICE.extra", problems)

    def modified(self, source, shadow, pins):
        return tp.compare(tp.parse(source), tp.parse(shadow), (), pins)

    def test_pinned_shadow_modified_file_passes(self):
        self.assertEqual(self.modified(SOURCE + ls((NOTICE, A)), SOURCE + ls((NOTICE, C)), {NOTICE: A}), [])

    def test_shadow_modified_source_moved_fails(self):
        # Upstream changed the file: re-review the Shadow edit and re-pin.
        problems = self.modified(SOURCE + ls((NOTICE, B)), SOURCE + ls((NOTICE, C)), {NOTICE: A})
        self.assertEqual(problems, [f"Shadow-modified path changed in source: {NOTICE} (pinned aaaaaaaaaaaa, source 100644 blob bbbbbbbbbbbb)"])

    def test_shadow_modified_missing_upstream_fails(self):
        problems = self.modified(SOURCE, SOURCE + ls((NOTICE, C)), {NOTICE: A})
        self.assertEqual(problems, [f"Shadow-modified path not in source: {NOTICE}"])

    def test_shadow_modified_missing_in_shadow_fails(self):
        problems = self.modified(SOURCE + ls((NOTICE, A)), SOURCE, {NOTICE: A})
        self.assertEqual(problems, [f"Shadow-modified path not in Shadow: {NOTICE}"])

    def test_shadow_modified_equal_to_source_is_stale(self):
        problems = self.modified(SOURCE + ls((NOTICE, A)), SOURCE + ls((NOTICE, A)), {NOTICE: A})
        self.assertEqual(problems, [f"Shadow-modified path equals source, drop the pin: {NOTICE}"])

    def test_shadow_modified_must_be_regular_file(self):
        problems = self.modified(SOURCE + ls((NOTICE, A)), SOURCE + ls((NOTICE, C, "120000")), {NOTICE: A})
        self.assertEqual(problems, [f"Shadow-modified path is not a regular file in Shadow: {NOTICE} (120000 blob)"])

    def test_path_in_both_lists_fails(self):
        problems = tp.compare(tp.parse(SOURCE + ls((NOTICE, A))), tp.parse(SOURCE + ls((NOTICE, C))),
                              [NOTICE], {NOTICE: A})
        self.assertIn(f"path is both Shadow-only and Shadow-modified: {NOTICE}", problems)

    def test_empty_source_fails(self):
        self.assertEqual(self.compare(b"", SOURCE), ["source tree is empty: nothing was compared"])


class Parse(unittest.TestCase):
    def test_path_with_tab_and_newline(self):
        entries = tp.parse(ls(("a\tb\nc.ts", A)))
        self.assertEqual(list(entries), ["a\tb\nc.ts"])

    def test_malformed_entry_raises(self):
        with self.assertRaises(tp.TreeError):
            tp.parse(b"100644 blob nothex\tx\0")
        with self.assertRaises(tp.TreeError):
            tp.parse(b"garbage\0")

    def test_duplicate_path_raises(self):
        with self.assertRaises(tp.TreeError):
            tp.parse(ls(("x", A), ("x", B)))


class Cli(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)

    def write(self, name, data):
        path = os.path.join(self._td.name, name)
        with open(path, "wb") as fh:
            fh.write(data)
        return path

    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = tp.main(argv)
        return rc, out.getvalue(), err.getvalue()

    def test_pass(self):
        src, sh = self.write("s", SOURCE), self.write("h", SOURCE + ls((NOTICE, C)))
        rc, out, _ = self.run_main(["compare", src, sh, "--shadow-only", NOTICE])
        self.assertEqual(rc, 0)
        self.assertIn("2 entries identical; 1 Shadow-only, 0 Shadow-modified", out)

    def test_fail_exit_1(self):
        src, sh = self.write("s", SOURCE), self.write("h", SOURCE + ls((NOTICE, C)))
        rc, out, _ = self.run_main(["compare", src, sh])
        self.assertEqual(rc, 1)
        self.assertIn(f"only in Shadow: {NOTICE}", out)

    def test_unreadable_exit_2(self):
        src, sh = self.write("s", b"garbage\0"), self.write("h", SOURCE)
        rc, _, err = self.run_main(["compare", src, sh])
        self.assertEqual(rc, 2)
        self.assertIn("tree_parity:", err)

    def test_shadow_modified_flag(self):
        src, sh = self.write("s", SOURCE + ls((NOTICE, A))), self.write("h", SOURCE + ls((NOTICE, C)))
        rc, out, _ = self.run_main(["compare", src, sh, "--shadow-modified", f"{NOTICE}={A}"])
        self.assertEqual(rc, 0)
        self.assertIn("1 Shadow-modified", out)

    def test_shadow_modified_flag_needs_full_oid(self):
        src, sh = self.write("s", SOURCE), self.write("h", SOURCE)
        for bad in (NOTICE, f"{NOTICE}=abc", f"={A}"):
            with self.subTest(bad=bad):
                rc, _, _ = self.run_main(["compare", src, sh, "--shadow-modified", bad])
                self.assertEqual(rc, 2)

    def test_missing_file_exit_2(self):
        rc, _, _ = self.run_main(["compare", os.path.join(self._td.name, "nope"), self.write("h", SOURCE)])
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
