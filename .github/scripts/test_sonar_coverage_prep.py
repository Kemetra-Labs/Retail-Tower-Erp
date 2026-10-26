"""Unit tests for sonar_coverage_prep.py (RT-901). Stdlib only; reports are written to a temp tree."""
import contextlib
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sonar_coverage_prep as scp  # noqa: E402

LCOV = "TN:\nSF:{path}\nDA:1,1\nLF:4\nLH:3\nend_of_record\n"
COBERTURA = (
    '<?xml version="1.0" ?><coverage lines-valid="10" lines-covered="7"><sources>'
    "<source>/runner/work/pkg</source></sources><packages><package><classes>"
    '<class filename="{path}"/></classes></package></packages></coverage>'
)


class Tree(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.base = os.path.join(self._tmp.name, "base")
        self.touch("apps/api/src/a.ts")
        self.touch("pkg/mod/b.py")

    def touch(self, rel):
        path = os.path.join(self.base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "w").close()

    def write(self, name, text):
        path = os.path.join(self._tmp.name, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def run_main(self, *argv):
        err = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            code = scp.main(list(argv))
        return code, err.getvalue()


class LcovTests(Tree):
    def test_prefix_is_applied_and_totals_are_read(self):
        report = self.write("in.info", LCOV.format(path="src/a.ts"))
        out = os.path.join(self._tmp.name, "out.info")
        files, missing, found, hit = scp.prep_lcov(report, out, self.base, "apps/api/")
        self.assertEqual((files, missing, found, hit), (1, [], 4, 3))
        with open(out, encoding="utf-8") as fh:
            self.assertIn("SF:apps/api/src/a.ts", fh.read())

    def test_windows_separators_are_normalised(self):
        report = self.write("in.info", LCOV.format(path="src\\a.ts"))
        out = os.path.join(self._tmp.name, "out.info")
        self.assertEqual(scp.prep_lcov(report, out, self.base, "apps/api/")[1], [])

    def test_absolute_path_under_base_is_made_relative(self):
        report = self.write("in.info", LCOV.format(path=os.path.join(self.base, "apps/api/src/a.ts")))
        out = os.path.join(self._tmp.name, "out.info")
        self.assertEqual(scp.prep_lcov(report, out, self.base)[:2], (1, []))

    def test_absolute_path_outside_base_is_unresolved(self):
        report = self.write("in.info", LCOV.format(path="/elsewhere/a.ts"))
        out = os.path.join(self._tmp.name, "out.info")
        self.assertEqual(scp.prep_lcov(report, out, self.base)[1], ["/elsewhere/a.ts"])

    def test_traversal_into_another_directory_is_unresolved(self):
        self.touch("../other/src/c.ts")
        report = self.write("in.info", LCOV.format(path="../other/src/c.ts"))
        out = os.path.join(self._tmp.name, "out.info")
        self.assertEqual(scp.prep_lcov(report, out, self.base)[:2], (0, ["../other/src/c.ts"]))

    def test_missing_file_fails_the_run(self):
        report = self.write("in.info", LCOV.format(path="src/gone.ts"))
        code, err = self.run_main("lcov", report, os.path.join(self._tmp.name, "o"), "--base", self.base,
                                  "--prefix", "apps/api/")
        self.assertEqual(code, 1)
        self.assertIn("unresolved: src/gone.ts", err)

    def test_wrong_prefix_fails_the_run(self):
        report = self.write("in.info", LCOV.format(path="src/a.ts"))
        code, _ = self.run_main("lcov", report, os.path.join(self._tmp.name, "o"), "--base", self.base)
        self.assertEqual(code, 1)

    def test_empty_report_fails_the_run(self):
        report = self.write("in.info", "")
        code, err = self.run_main("lcov", report, os.path.join(self._tmp.name, "o"), "--base", self.base)
        self.assertEqual(code, 1)
        self.assertIn("lists no files", err)

    def test_unreadable_report_exits_2(self):
        code, _ = self.run_main("lcov", os.path.join(self._tmp.name, "nope"), "o", "--base", self.base)
        self.assertEqual(code, 2)


class CoberturaTests(Tree):
    def test_filename_relative_to_the_package_is_rewritten_and_sources_dropped(self):
        report = self.write("in.xml", COBERTURA.format(path="mod/b.py"))
        out = os.path.join(self._tmp.name, "out.xml")
        files, missing, found, hit = scp.prep_cobertura(report, out, self.base, "pkg")
        self.assertEqual((files, missing, found, hit), (1, [], 10, 7))
        with open(out, encoding="utf-8") as fh:
            text = fh.read()
        self.assertIn('filename="pkg/mod/b.py"', text)
        self.assertNotIn("<sources>", text)

    def test_absolute_filename_outside_base_is_unresolved(self):
        outside = os.path.join(self._tmp.name, "other", "d.py")
        os.makedirs(os.path.dirname(outside))
        open(outside, "w").close()
        report = self.write("in.xml", COBERTURA.format(path=outside))
        out = os.path.join(self._tmp.name, "out.xml")
        self.assertEqual(scp.prep_cobertura(report, out, self.base, "pkg")[:2], (0, [outside]))

    def test_traversal_filename_is_unresolved(self):
        self.touch("../other/e.py")
        report = self.write("in.xml", COBERTURA.format(path="../other/e.py"))
        out = os.path.join(self._tmp.name, "out.xml")
        self.assertEqual(scp.prep_cobertura(report, out, self.base)[0], 0)

    def test_unresolved_filename_fails_the_run(self):
        report = self.write("in.xml", COBERTURA.format(path="mod/gone.py"))
        code, err = self.run_main("cobertura", report, os.path.join(self._tmp.name, "o"), "--base", self.base,
                                  "--source-subdir", "pkg")
        self.assertEqual(code, 1)
        self.assertIn("unresolved: mod/gone.py", err)

    def test_malformed_xml_exits_2(self):
        report = self.write("in.xml", "<coverage")
        code, _ = self.run_main("cobertura", report, "o", "--base", self.base)
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
