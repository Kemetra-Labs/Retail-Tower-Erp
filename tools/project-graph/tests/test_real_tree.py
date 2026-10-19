"""Acceptance checks against this repository's committed tree (HEAD).

Every tracked path must classify, and the layer-1 boundary must be clean.
Static rule 5 is expected to FAIL today: no root .github/workflows define the
product jobs yet. That is a recorded gap (README), asserted here so it cannot
silently disappear or grow."""

import pathlib
import subprocess
import unittest

from pgraph import boundary as bd
from pgraph import gitio
from pgraph.graph import Graph, validate_graph

import support

REPO = str(pathlib.Path(__file__).resolve().parents[3])


def _in_git_repo():
    try:
        subprocess.run(["git", "-C", REPO, "rev-parse", "HEAD"], capture_output=True, check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


@unittest.skipUnless(_in_git_repo(), "not inside the Shadow git checkout")
class RealTreeTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.data = support.load_graph(support.trusted_text())
        cls.graph = Graph(cls.data)
        cls.paths = gitio.list_tree(REPO, "HEAD")

    def test_every_tracked_path_classifies(self):
        bad = [(p, self.graph.classify(p).kind) for p in sorted(self.paths)
               if self.graph.classify(p).kind in ("unknown", "ambiguous")]
        self.assertEqual(bad, [])

    def test_static_rules_only_gap_is_rule5(self):
        errors = validate_graph(self.data, tree_paths=self.paths,
                                workflow_jobs=gitio.workflow_jobs(REPO, "HEAD"))
        self.assertTrue(errors)
        self.assertEqual({e.split(":", 1)[0] for e in errors}, {"CI_JOB_MISSING"})

    def test_root_and_staged_workflows_keep_privilege_invariants(self):
        from pgraph.privileges import scan_repo, workflow_files
        self.assertTrue(any(f.name == "gate.yml.staged" for f in workflow_files(REPO)))
        self.assertEqual(scan_repo(REPO), [])

    def test_boundary_layer1_is_clean(self):
        files, unscanned = bd.read_worktree_files(REPO, self.paths)
        result = bd.scan(self.graph, files, bd.load_ratchet(REPO), unscanned=unscanned)
        self.assertEqual(result["violations"], [])


if __name__ == "__main__":
    unittest.main()
