"""Acceptance checks against this repository's committed tree (HEAD).

Every tracked path must classify, and the layer-1 boundary must be clean.
Static rule 5 (every graph job is defined by a root workflow) holds since the last
job, e2e/smoke (RT-851), landed; it is asserted here so a job cannot go missing again.
The RT-867 plan-guard rule is asserted the same way: no graph job can run unselected."""

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

    def test_static_rules_have_no_gap(self):
        workflows = gitio.workflow_definitions(REPO, "HEAD")
        errors = validate_graph(self.data, tree_paths=self.paths,
                                workflow_jobs=gitio.workflow_jobs(REPO, "HEAD", workflows),
                                workflows=workflows)
        self.assertEqual(errors, [])

    def test_root_workflows_keep_privilege_invariants(self):
        from pgraph.privileges import scan_repo, workflow_files
        self.assertTrue(any(f.name == "gate.yml" for f in workflow_files(REPO)))
        self.assertEqual(scan_repo(REPO), [])

    def test_boundary_layer1_is_clean(self):
        files, unscanned = bd.read_rev_files(REPO, "HEAD")
        result = bd.scan(self.graph, files, bd.load_ratchet(REPO, "HEAD"), unscanned=unscanned)
        self.assertEqual(result["violations"], [])
        self.assertEqual(result["stale_ratchet"], [])


if __name__ == "__main__":
    unittest.main()
