"""Unit tests for connector_research_guard.py (RT-1455). Stdlib only; temp git repos, no network."""
import contextlib
import io
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import connector_research_guard as guard  # noqa: E402

C = "integrations/erpnext-connector/"
HOME_FILE = "docs/research/erpnext-connector/rt-1/proof.py"
CLEAN = [
    C + "pyproject.toml",
    C + "retail_tower_erpnext_connector/hooks.py",
    C + "docs/runbooks/staging-install.md",
    C + "docs/assets/readme/hero.svg",
    C + "specs/001-frappe-app-foundation/research.md",  # a spec-kit file, not a research directory
    "docs/research/erpnext-connector/rt-1449-finance-report-role/finance_report_role_proof.py",
    "apps/pos/docs/research/notes.md",  # another product's tree is not this guard's business
]


class ViolationsTests(unittest.TestCase):
    def test_clean_tree_passes(self):
        self.assertEqual(guard.violations(CLEAN), [])

    def test_the_old_research_paths_fail(self):
        for path in (
            C + "docs/research/rt-1449-finance-report-role/finance_report_role_proof.py",
            C + "docs/research/rt-1340-od11/README.md",
            C + "docs/research/rt-482-frappe-ecosystem-research.md",
        ):
            with self.subTest(path=path):
                self.assertEqual(len(guard.violations([path])), 1)

    def test_research_directory_at_any_depth_or_case_fails(self):
        for path in (C + "research/x.md", C + "retail_tower_erpnext_connector/research/x.py",
                     C + "docs/Research/x.md", C + "docs/a/RESEARCH/b/c.txt"):
            with self.subTest(path=path):
                self.assertEqual(len(guard.violations([path])), 1)

    def test_a_file_named_research_is_not_a_research_directory(self):
        self.assertEqual(guard.violations([C + "docs/research.md", C + "specs/004-x/research.md"]), [])

    def test_a_similar_directory_name_is_not_flagged(self):
        self.assertEqual(guard.violations([C + "docs/researchers/a.md", C + "docs/pre-research/a.md"]), [])

    def test_script_under_docs_fails_markdown_and_assets_do_not(self):
        for name in ("a.py", "b.sh", "c.js", "d.mjs", "e.cjs", "f.ts", "g.ps1", "h.bash", "UP.PY", "i.ipynb",
                     "j.bat", "k.cmd", "l.zsh", "m.rb", "n.pl", "o.sql"):
            with self.subTest(name=name):
                self.assertEqual(len(guard.violations([C + "docs/runbooks/" + name])), 1)
        self.assertEqual(guard.violations([C + "docs/a.md", C + "docs/b.svg", C + "docs/c.json"]), [])

    def test_a_script_outside_docs_is_allowed(self):
        self.assertEqual(guard.violations([C + "deploy/lab/restore.py", C + "bench-proof.sh"]), [])

    def test_each_problem_names_the_path_and_the_new_home(self):
        (problem,) = guard.violations([C + "docs/research/x/y.py"])
        self.assertIn(C + "docs/research/x/y.py", problem)
        self.assertIn(guard.HOME, problem)


def git(cwd, *args):
    subprocess.run(["git", "-C", cwd, *args], check=True, capture_output=True,
                   env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"})


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = self.tmp.name
        git(self.repo, "init", "-q", "-b", "main")
        self.add("integrations/erpnext-connector/pyproject.toml")
        self.add(HOME_FILE)

    def add(self, rel, text="x\n"):
        path = os.path.join(self.repo, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as handle:
            handle.write(text)

    def run_check(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = guard.main(["check", "--repo", self.repo])
        return code, out.getvalue()

    def test_clean_repo_exits_zero(self):
        code, out = self.run_check()
        self.assertEqual((code, "OK" in out), (0, True))

    def test_untracked_research_file_exits_one_with_an_annotation(self):
        self.add(C + "docs/research/rt-9999/proof.py")
        code, out = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("::error::connector research guard " + C + "docs/research/rt-9999/proof.py", out)

    def test_tracked_research_file_exits_one(self):
        self.add(C + "docs/research/rt-9999/README.md")
        git(self.repo, "add", C + "docs/research/rt-9999/README.md")
        self.assertEqual(self.run_check()[0], 1)

    def test_gitignored_file_is_not_counted(self):
        self.add(".gitignore", C + "docs/research/\n")
        self.add(C + "docs/research/rt-9999/proof.py")
        self.assertEqual(self.run_check()[0], 0)

    def test_no_connector_files_exits_two_not_ok(self):
        with tempfile.TemporaryDirectory() as bare:
            git(bare, "init", "-q", "-b", "main")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = guard.main(["check", "--repo", bare])
        self.assertEqual((code, "OK" in out.getvalue()), (2, False))

    def test_not_a_git_repo_exits_two(self):
        with tempfile.TemporaryDirectory() as empty:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = guard.main(["check", "--repo", empty])
        self.assertEqual(code, 2)


class RealTreeTests(unittest.TestCase):
    def test_this_repository_is_clean(self):
        repo = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        self.assertEqual(guard.check(repo), [])


if __name__ == "__main__":
    unittest.main()
