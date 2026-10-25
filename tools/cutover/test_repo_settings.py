"""Unit tests for the pure parts of repo_settings.py (no network). Run: python3 -m unittest tools/cutover/test_repo_settings.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import repo_settings as rs  # noqa: E402


def snapshot(**over):
    base = {"repo": {"allow_squash_merge": True}, "security": {"secret_scanning": "enabled"},
            "actions": {"enabled": True}, "workflow": {"default_workflow_permissions": "read"},
            "rulesets": [{"name": "main-pr-protection", "target": "branch", "enforcement": "active",
                          "conditions": {}, "bypass_actors": [], "rules": [{"type": "deletion"}]}],
            "environments": [{"name": "ci-gate", "deployment_branch_policy": {"custom_branch_policies": True},
                              "reviewers": [], "wait_timer": 0, "branch_policies": [{"name": "main", "type": "branch"}],
                              "secret_names": ["CI_GATE_APP_PRIVATE_KEY"], "variable_names": ["CI_GATE_APP_ID"]}],
            "secret_names": [], "variable_names": [], "app_integration_ids": [5373080]}
    base.update(over)
    return base


EMPTY = {"repo": {}, "security": {}, "actions": {}, "workflow": {}, "rulesets": [], "environments": [],
         "secret_names": [], "variable_names": [], "app_integration_ids": []}


class PlanTests(unittest.TestCase):
    def test_identical_target_needs_only_the_app_todo(self):
        s = snapshot()
        cur = dict(s, app_integration_ids=[])
        acts = rs.plan(s, cur)
        self.assertEqual([k for k, _ in acts], ["todo-owner"])

    def test_empty_target_creates_everything_and_never_carries_values(self):
        acts = rs.plan(snapshot(), EMPTY)
        kinds = [k for k, _ in acts]
        self.assertIn("ruleset-create", kinds)
        self.assertIn("env-create", kinds)
        todos = [d for k, d in acts if k == "todo-owner"]
        self.assertTrue(any("CI_GATE_APP_PRIVATE_KEY" in d and "value by the owner" in d for d in todos))
        self.assertTrue(any("5373080" in d for d in todos))

    def test_changed_ruleset_is_an_update(self):
        s = snapshot()
        cur = dict(s, rulesets=[dict(s["rulesets"][0], enforcement="disabled")])
        self.assertIn(("ruleset-update", "main-pr-protection"), rs.plan(s, cur))

    def test_target_defaults_are_not_a_difference(self):
        s = snapshot(rulesets=[{"name": "r", "rules": [{"type": "pull_request", "parameters": {"x": 1}}]}])
        cur = dict(s, rulesets=[{"name": "r", "rules": [{"type": "pull_request",
                                 "parameters": {"x": 1, "dismissal_restriction": {"enabled": False}}}]}],
                   app_integration_ids=[])
        self.assertNotIn("ruleset-update", [k for k, _ in rs.plan(s, cur)])
        cur["rulesets"][0]["rules"][0]["parameters"]["x"] = 2
        self.assertIn(("ruleset-update", "r"), rs.plan(s, cur))

    def test_normalize_drops_ids(self):
        out = rs.normalize_ruleset({"id": 1, "node_id": "x", "name": "n", "target": "branch", "enforcement": "active",
                                    "conditions": {}, "bypass_actors": [], "_links": {}, "source": "o/r",
                                    "rules": [{"type": "deletion", "parameters": None}]})
        self.assertEqual(sorted(out), ["bypass_actors", "conditions", "enforcement", "name", "rules", "target"])
        self.assertEqual(out["rules"], [{"type": "deletion"}])


if __name__ == "__main__":
    unittest.main()
