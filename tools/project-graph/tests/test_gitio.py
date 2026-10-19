"""Integration tests for the git adapter against a real temporary repository.
Only git plumbing is used: nothing from the head side is checked out."""

import os
import subprocess
import tempfile
import unittest

from pgraph import gitio


def _git(repo, *args, stdin=None):
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
               GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t.invalid",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t.invalid")
    return subprocess.run(["git", "-C", repo, *args], input=stdin, capture_output=True,
                          check=True, env=env).stdout.decode().strip()


class GitIoTests(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = self.tmp.name
        _git(self.repo, "init", "-q", "-b", "main")
        os.makedirs(os.path.join(self.repo, "apps/pos/src"))
        with open(os.path.join(self.repo, "apps/pos/src/a.ts"), "w") as f:
            f.write("export const a = 1;\n" * 20)
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "base")
        self.base = _git(self.repo, "rev-parse", "HEAD")

    def tearDown(self):
        self.tmp.cleanup()

    def test_rename_and_symlink_are_reported_with_modes(self):
        _git(self.repo, "mv", "apps/pos/src/a.ts", "apps/pos/src/b.ts")
        blob = _git(self.repo, "hash-object", "-w", "--stdin", stdin=b"target")
        _git(self.repo, "update-index", "--add", "--cacheinfo", f"120000,{blob},apps/pos/link")
        _git(self.repo, "commit", "-q", "-m", "head")
        head = _git(self.repo, "rev-parse", "HEAD")

        changes = gitio.read_changes(self.repo, self.base, head)
        by_path = {c.path: c for c in changes}
        self.assertEqual(by_path["apps/pos/src/b.ts"].status, "R")
        self.assertEqual(by_path["apps/pos/src/b.ts"].old_path, "apps/pos/src/a.ts")
        self.assertEqual(by_path["apps/pos/link"].mode, "120000")
        self.assertEqual(by_path["apps/pos/link"].blob, blob)

    def test_unresolvable_head_raises(self):
        with self.assertRaises(gitio.DiffUnavailable):
            gitio.read_changes(self.repo, self.base, "f" * 40)

    def test_read_blob_and_tree(self):
        self.assertIn("export const a", gitio.read_text(self.repo, self.base, "apps/pos/src/a.ts"))
        self.assertIsNone(gitio.read_text(self.repo, self.base, "missing.yaml"))
        self.assertEqual(gitio.list_tree(self.repo, self.base), {"apps/pos/src/a.ts"})

    def test_workflow_jobs_reads_root_workflows_at_rev(self):
        os.makedirs(os.path.join(self.repo, ".github/workflows"))
        with open(os.path.join(self.repo, ".github/workflows/pos.yml"), "w") as f:
            f.write("on: pull_request\njobs:\n  static:\n    name: pos/static\n    runs-on: x\n  test:\n    runs-on: x\n")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "wf")
        rev = _git(self.repo, "rev-parse", "HEAD")
        self.assertEqual(gitio.workflow_jobs(self.repo, rev),
                         {"pos/static": ".github/workflows/pos.yml", "test": ".github/workflows/pos.yml"})
        self.assertEqual(gitio.workflow_jobs(self.repo, self.base), {})


if __name__ == "__main__":
    unittest.main()
