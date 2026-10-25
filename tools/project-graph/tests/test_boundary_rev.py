"""RT-873: `boundary --rev` reads blobs at the rev through git plumbing, never
the working tree, and a stale ratchet entry fails the command."""

import io
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout

from pgraph import boundary as bd
from pgraph import cli

import support

BAD = "import x from '../../../../services/backend-core/apps/api/src/x';\n"
GOOD = "export const a = 1;\n"


def _git(repo, *args):
    env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
               GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t.invalid",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t.invalid")
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, check=True,
                          env=env).stdout.decode().strip()


class BoundaryRevTests(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = self.tmp.name
        _git(self.repo, "init", "-q", "-b", "main")
        self._write("apps/pos/src/main/a.ts", BAD)
        self._write("apps/pos/src/main/link.ts", GOOD)
        _git(self.repo, "add", "apps")
        _git(self.repo, "commit", "-q", "-m", "bad")
        self.bad = _git(self.repo, "rev-parse", "HEAD")
        self._write("apps/pos/src/main/a.ts", GOOD)
        _git(self.repo, "commit", "-q", "-am", "good")
        self.good = _git(self.repo, "rev-parse", "HEAD")

    def tearDown(self):
        self.tmp.cleanup()

    def _write(self, path, text):
        full = os.path.join(self.repo, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as fh:
            fh.write(text)

    def _boundary(self, rev):
        out = io.StringIO()
        with redirect_stdout(out):
            code = cli.main(["boundary", "--repo", self.repo, "--rev", rev,
                             "--graph", str(support.GRAPH_PATH)])
        return code, out.getvalue()

    def test_reads_contents_at_rev_not_worktree(self):
        self.assertEqual(self._boundary(self.bad)[0], 1)    # worktree is clean, the rev is not
        self._write("apps/pos/src/main/a.ts", BAD)          # dirty worktree, clean rev
        self.assertEqual(self._boundary(self.good)[0], 0)

    def test_read_rev_files_skips_symlinks_and_reports_oversize(self):
        blob = subprocess.run(["git", "-C", self.repo, "hash-object", "-w", "--stdin"], input=BAD.encode(),
                              capture_output=True, check=True).stdout.decode().strip()
        _git(self.repo, "update-index", "--add", "--cacheinfo", f"120000,{blob},apps/pos/src/main/sym.ts")
        self._write("apps/pos/src/main/big.ts", "//" + "x" * (bd.MAX_FILE_BYTES + 1))
        _git(self.repo, "add", "apps/pos/src/main/big.ts")
        _git(self.repo, "commit", "-q", "-m", "sym")
        files, unscanned = bd.read_rev_files(self.repo, "HEAD")
        self.assertEqual(set(files), {"apps/pos/src/main/a.ts", "apps/pos/src/main/link.ts"})
        self.assertEqual(files["apps/pos/src/main/a.ts"], GOOD)
        self.assertEqual(unscanned, ["apps/pos/src/main/big.ts"])

    def test_stale_ratchet_entry_fails(self):
        self._write(bd.RATCHET_PATH, "- {rule: import, from: apps/pos/src/main/a.ts, "
                    "to: services/backend-core/apps/api/src/x, ticket: RT-000}\n")
        _git(self.repo, "add", bd.RATCHET_PATH)
        _git(self.repo, "commit", "-q", "-m", "ratchet")
        code, out = self._boundary("HEAD")
        self.assertEqual(code, 1)
        self.assertIn("stale_ratchet", out)
        self.assertIn('"ok": false', out)


if __name__ == "__main__":
    unittest.main()
