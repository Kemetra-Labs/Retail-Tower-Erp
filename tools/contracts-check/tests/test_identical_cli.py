import io
import pathlib
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

from contracts_check import cli, identical
from contracts_check.findings import FAIL, OK, Finding, markdown_report, text_report

from support import REPO_ROOT, TempRepo


class Identical(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.group = {"name": "OBS-1", "paths": ["a/v.json", "b/v.json", "c/v.json"]}

    def write_all(self, contents):
        for path, content in zip(self.group["paths"], contents):
            self.repo.write(path, content)

    def test_identical_copies_pass(self):
        self.write_all([b"{}\n"] * 3)
        self.assertEqual([f.status for f in identical.check_group(self.repo.root, self.group)], [OK])

    def test_one_diverged_copy_fails(self):
        self.write_all([b"{}\n", b"{}\n", b"{} \n"])
        [f] = identical.check_group(self.repo.root, self.group)
        self.assertEqual(f.status, FAIL)
        self.assertIn("c/v.json", f.message)

    def test_missing_copy_fails(self):
        self.write_all([b"{}\n", b"{}\n"])
        [f] = identical.check_group(self.repo.root, self.group)
        self.assertEqual(f.status, FAIL)

    def test_single_path_fails(self):
        [f] = identical.check_group(self.repo.root, {"name": "x", "paths": ["a"]})
        self.assertEqual(f.status, FAIL)


class Reports(unittest.TestCase):
    def test_markdown_escapes_pipes_and_orders_failures_first(self):
        md = markdown_report([Finding("pins", "a|b", OK, "x"), Finding("pins", "c", FAIL, "y|z")])
        self.assertLess(md.index("### Failures"), md.index("### Compared"))
        self.assertIn("a\\|b", md)
        self.assertIn("**FAILED**", md)

    def test_text_report_verdict(self):
        self.assertIn("passed: 0 fail", text_report([Finding("pins", "a", OK, "x")]))


class Cli(unittest.TestCase):
    def call(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_real_tree_connector_and_identical_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary = pathlib.Path(tmp) / "summary.md"
            code, out, _ = self.call("--repo", str(REPO_ROOT), "--only", "connector", "--only", "identical",
                                     "--summary", str(summary))
            self.assertEqual(code, 0, out)
            self.assertIn("## contracts/check", summary.read_text(encoding="utf-8"))

    def test_bad_config_exits_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = pathlib.Path(tmp) / "c.yaml"
            config.write_text("contracts_root: x\n", encoding="utf-8")
            code, _, err = self.call("--repo", str(REPO_ROOT), "--config", str(config))
            self.assertEqual(code, 2)
            self.assertIn("configuration error", err)

    def test_missing_oasdiff_fails(self):
        code, out, _ = self.call("--repo", str(REPO_ROOT), "--only", "pins", "--oasdiff", "/nonexistent/oasdiff")
        self.assertEqual(code, 1)
        self.assertIn("FAIL", out)


if __name__ == "__main__":
    unittest.main()
