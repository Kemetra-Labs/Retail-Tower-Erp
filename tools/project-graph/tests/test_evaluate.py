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


if __name__ == "__main__":
    unittest.main()
