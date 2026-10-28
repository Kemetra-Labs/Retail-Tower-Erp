import unittest

import yaml

from pgraph import evaluate as ev
from pgraph.graph import load_graph

import support


class EvaluateDefenceInDepthTests(unittest.TestCase):

    def test_changed_proposed_graph_is_policy_change_even_if_diff_omits_it(self):
        data = load_graph(support.trusted_text())
        data["policy_approvers"] = ["intruder"]
        inp = ev.EvalInput(
            event="pull_request", base_sha=support.BASE, head_sha=support.HEAD,
            changes=support.changes([{"status": "M", "path": "apps/pos/docs/a.md"}]),
            trusted_text=support.trusted_text(),
            proposed_text=yaml.safe_dump(data, sort_keys=False),
            workflow_jobs=dict(data["jobs"]),
        )
        plan = ev.evaluate(inp)
        self.assertTrue(plan["policy_change"])
        self.assertEqual(plan["graph_validation"]["status"], "needs_approval")

    def test_invalid_trusted_graph_fails_everything(self):
        inp = ev.EvalInput(
            event="pull_request", base_sha=support.BASE, head_sha=support.HEAD,
            changes=support.changes([{"status": "M", "path": "apps/pos/docs/a.md"}]),
            trusted_text=support.trusted_text(),
            workflow_jobs={},  # rule 5 fails: no workflow defines the jobs
        )
        plan = ev.evaluate(inp)
        self.assertEqual(plan["graph_validation"]["status"], "fail")
        self.assertEqual(plan["graph_validation"]["reasons"], ["GRAPH_INVALID"])
        self.assertTrue(plan["select_all"])
        self.assertIn("CI_JOB_MISSING", plan["graph_validation"]["details"]["GRAPH_INVALID"][0])

    def test_diff_unavailable_fails_closed(self):
        inp = ev.EvalInput(
            event="pull_request", base_sha=support.BASE, head_sha=support.HEAD, changes=(),
            trusted_text=support.trusted_text(), diff_error=True,
            workflow_jobs=dict(load_graph(support.trusted_text())["jobs"]),
        )
        plan = ev.evaluate(inp)
        self.assertEqual(plan["graph_validation"]["reasons"], ["DIFF_UNAVAILABLE"])
        self.assertTrue(plan["select_all"])


class RootDocsSelectionTests(unittest.TestCase):
    """RT-578 PR-1: the root README.md and ARCHITECTURE.md select no product job."""

    def _plan(self, *paths):
        data = load_graph(support.trusted_text())
        inp = ev.EvalInput(
            event="pull_request", base_sha=support.BASE, head_sha=support.HEAD,
            changes=support.changes([{"status": "M", "path": p} for p in paths]),
            trusted_text=support.trusted_text(),
            workflow_jobs=dict(data["jobs"]),
        )
        return ev.evaluate(inp)

    def test_root_docs_select_nothing(self):
        for paths in (("README.md",), ("ARCHITECTURE.md",), ("README.md", "ARCHITECTURE.md", "docs/a.md")):
            with self.subTest(paths=paths):
                plan = self._plan(*paths)
                self.assertFalse(plan["select_all"], plan["graph_validation"])
                self.assertEqual(plan["graph_validation"]["status"], "pass")
                self.assertFalse(plan["policy_change"])
                self.assertEqual([p for p, v in plan["products"].items() if v["run"]], [])
                self.assertFalse(plan["e2e"]["run"])
                self.assertEqual(set(plan["needed_jobs"]) - set(load_graph(support.trusted_text())["always_jobs"]), set())

    def test_other_root_files_still_select_everything(self):
        for path in ("LICENSE", "NEWS.md", "SECURITY.md"):
            with self.subTest(path=path):
                self.assertTrue(self._plan(path)["select_all"])

    def test_root_docs_with_code_still_select_the_code_product(self):
        plan = self._plan("README.md", "apps/pos/src/main/payments/a.ts")
        self.assertTrue(plan["products"]["pos"]["run"])


if __name__ == "__main__":
    unittest.main()
