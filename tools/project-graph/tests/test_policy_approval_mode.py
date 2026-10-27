"""RT-721 / RT-866: the `policy_approval` mode of the `required` gate.

`required` (the default, and the meaning of any value other than exactly `observe`) keeps `required` red
until a listed approver attests. `observe` still evaluates and reports the approval but never fails or
delays `required` for its absence. The mode is read from the TRUSTED graph only. Observe must hide nothing
else: a failed or pending job, an invalid graph and a missing plan are judged exactly as before."""

import copy
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

import yaml

from pgraph import aggregate as ag
from pgraph import evaluate as ev
from pgraph.graph import POLICY_APPROVAL_MODES, load_graph, validate_graph

import support

POLICY_CHANGE = [{"status": "M", "path": ".github/workflows/pos.yml"}]
GRAPH_CHANGE = [{"status": "M", "path": "tools/project-graph/graph.yaml"}]
ABSENT = object()


def _result(mode, approved=False, **extra):
    """Evaluate a policy-change PR against a trusted graph with `mode`, then aggregate."""
    overrides = {"policy_approval": "required" if mode is ABSENT else mode}
    if approved:
        overrides["policy_approvers"] = ["test-human"]
    case = {"trusted_overrides": overrides, "changes": POLICY_CHANGE, "checks": "auto", **extra}
    if approved:
        case["approvals"] = [{"login": "test-human"}]
    inp = support.eval_input(case)
    plan = ev.evaluate(inp)
    graph = load_graph(inp.trusted_text)
    if mode is ABSENT:
        graph.pop("policy_approval")
    result = ag.aggregate(plan, support.check_runs(case, plan, graph), support.approvals(case, plan), graph)
    return plan, result


class PolicyApprovalModeTests(unittest.TestCase):

    def test_absent_key_is_required_and_fails_without_approval(self):
        _, result = _result(ABSENT)
        self.assertEqual(result["conclusion"], "failure")
        self.assertEqual(result["reasons"], ["POLICY_APPROVAL_REQUIRED"])
        self.assertEqual(result["approval"]["mode"], "required")

    def test_explicit_required_fails_without_approval(self):
        _, result = _result("required")
        self.assertEqual((result["conclusion"], result["reasons"]), ("failure", ["POLICY_APPROVAL_REQUIRED"]))

    def test_observe_without_approval_is_green_and_still_reports_it(self):
        plan, result = _result("observe")
        self.assertEqual((result["conclusion"], result["reasons"]), ("success", []))
        self.assertEqual(result["approval"], {"required": True, "valid": False, "problems": ["NO_APPROVAL"],
                                              "mode": "observe"})
        # a policy change still selects every job and still carries the attestation fingerprint
        self.assertTrue(plan["select_all"] and plan["policy_change"] and plan["approval_required"])

    def test_observe_with_a_valid_approval_reports_it_valid(self):
        _, result = _result("observe", approved=True)
        self.assertEqual((result["conclusion"], result["reasons"]), ("success", []))
        self.assertTrue(result["approval"]["valid"])

    def test_required_with_a_valid_approval_is_green(self):
        _, result = _result("required", approved=True)
        self.assertEqual((result["conclusion"], result["reasons"]), ("success", []))

    def test_observe_does_not_mask_a_failed_job(self):
        _, result = _result("observe", check_overrides={"pos/static": [{"conclusion": "failure"}]})
        self.assertEqual(result["conclusion"], "failure")
        self.assertEqual(result["reasons"], ["JOB_FAILED"])

    def test_observe_does_not_turn_a_pending_job_green(self):
        _, result = _result("observe", check_overrides={"pos/static": [{"status": "in_progress", "conclusion": None}]})
        self.assertEqual((result["conclusion"], result["reasons"]), ("pending", ["JOB_PENDING"]))

    def test_observe_does_not_mask_an_invalid_proposed_graph(self):
        _, result = _result("observe", changes=GRAPH_CHANGE, proposed={"text": "schema: [unclosed\n"})
        self.assertEqual(result["conclusion"], "failure")
        self.assertEqual(result["reasons"], ["GRAPH_VALIDATION_FAILED"])

    def test_observe_does_not_mask_a_missing_plan(self):
        result = ag.aggregate(None, [], [], {"policy_approval": "observe"})
        self.assertEqual((result["conclusion"], result["reasons"]), ("failure", ["NO_PLAN"]))

    def test_a_pr_cannot_relax_its_own_approval(self):
        """The trusted graph says `required`; the PR's proposed graph sets `observe`. Only the trusted one counts."""
        _, result = _result("required", changes=GRAPH_CHANGE,
                            proposed={"patch": [{"op": "set", "path": ["policy_approval"], "value": "observe"}]})
        self.assertEqual((result["conclusion"], result["reasons"]), ("failure", ["POLICY_APPROVAL_REQUIRED"]))
        self.assertEqual(result["approval"]["mode"], "required")

    def test_anything_but_exactly_observe_is_required(self):
        for bad in ("off", "", "OBSERVE", " observe", "observe ", True, None, 1, ["observe"], {"mode": "observe"}):
            with self.subTest(value=bad):
                graph = load_graph(support.trusted_text())
                graph["policy_approval"] = bad
                self.assertEqual(ag.policy_approval_mode(graph), "required")
        self.assertEqual(ag.policy_approval_mode({}), "required")
        self.assertEqual(ag.policy_approval_mode({"policy_approval": "observe"}), "observe")


class PolicyApprovalSchemaTests(unittest.TestCase):

    def _schema_errors(self, **edit):
        graph = copy.deepcopy(load_graph(support.trusted_text()))
        graph.update(edit)
        return [e for e in validate_graph(graph, workflow_jobs=dict(graph["jobs"])) if e.startswith("SCHEMA")]

    def test_the_two_modes_validate(self):
        for mode in POLICY_APPROVAL_MODES:
            with self.subTest(mode=mode):
                self.assertEqual(self._schema_errors(policy_approval=mode), [])

    def test_an_absent_key_validates(self):
        graph = copy.deepcopy(load_graph(support.trusted_text()))
        graph.pop("policy_approval", None)
        self.assertEqual([e for e in validate_graph(graph, workflow_jobs=dict(graph["jobs"]))
                          if e.startswith("SCHEMA")], [])

    def test_any_other_value_is_a_schema_error(self):
        for bad in ("off", "", "OBSERVE", " observe", True, False, None, 1, 0, ["observe"], {"mode": "observe"}):
            with self.subTest(value=bad):
                errs = self._schema_errors(policy_approval=bad)
                self.assertTrue(any("policy_approval" in e for e in errs), errs)

    def test_the_committed_graph_declares_a_valid_mode(self):
        """Pins validity, not the value: reverting to `required` is a one-line change with no test edit."""
        graph = load_graph(support.trusted_text())
        self.assertIn(graph.get("policy_approval", "required"), POLICY_APPROVAL_MODES)
        self.assertEqual(self._schema_errors(), [])


GATE = support.PG_ROOT.parents[1] / ".github" / "workflows" / "gate.yml"
GRAPH_REPO_PATH = "tools/project-graph/graph.yaml"


def _git(repo, *args):
    return subprocess.run(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t.invalid",
                           "-c", "commit.gpgsign=false", *args], check=True, capture_output=True, text=True).stdout.strip()


class TrustBoundaryCliTests(unittest.TestCase):
    """The mode is read from `--base`, not from the PR head. Runs the real `pgraph aggregate` command
    against a temp git repo whose base graph says `required` and whose head graph says `observe`."""

    def _commit_graph(self, repo, mode, message):
        graph = load_graph(support.trusted_text())
        graph["policy_approval"] = mode
        path = pathlib.Path(repo, GRAPH_REPO_PATH)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(yaml.safe_dump(graph, sort_keys=False), encoding="utf-8")
        _git(repo, "add", "--", GRAPH_REPO_PATH)
        _git(repo, "commit", "-q", "-m", message)
        return _git(repo, "rev-parse", "HEAD")

    def _aggregate(self, tmp, plan, repo, base):
        pathlib.Path(tmp, "plan.json").write_text(json.dumps(plan), encoding="utf-8")
        pathlib.Path(tmp, "checks.json").write_text("[]", encoding="utf-8")
        pathlib.Path(tmp, "approvals.json").write_text("[]", encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, "-m", "pgraph", "aggregate", "--plan", str(pathlib.Path(tmp, "plan.json")),
             "--checks", str(pathlib.Path(tmp, "checks.json")), "--approvals", str(pathlib.Path(tmp, "approvals.json")),
             "--repo", repo, "--base", base], cwd=support.PG_ROOT, capture_output=True, text=True)
        return json.loads(proc.stdout)

    def test_aggregate_takes_the_mode_from_the_base_graph_not_the_head(self):
        case = {"trusted_overrides": {"policy_approval": "required"}, "changes": POLICY_CHANGE}
        plan = ev.evaluate(support.eval_input(case))
        self.assertTrue(plan["approval_required"])
        with tempfile.TemporaryDirectory() as tmp:
            repo = str(pathlib.Path(tmp, "repo"))
            pathlib.Path(repo).mkdir()
            _git(repo, "init", "-q")
            base = self._commit_graph(repo, "required", "base: strict")
            head = self._commit_graph(repo, "observe", "head: a PR that relaxes its own approval")
            from_base = self._aggregate(tmp, plan, repo, base)
            from_head = self._aggregate(tmp, plan, repo, head)
        self.assertEqual(from_base["approval"]["mode"], "required")
        self.assertIn("POLICY_APPROVAL_REQUIRED", from_base["reasons"])
        # Only a graph the trusted base already contains (a merged change) can relax the gate.
        self.assertEqual(from_head["approval"]["mode"], "observe")
        self.assertNotIn("POLICY_APPROVAL_REQUIRED", from_head["reasons"])


class GateSummaryWordingTests(unittest.TestCase):

    def test_the_gate_summary_branches_on_the_trusted_mode_and_keeps_the_strict_wording(self):
        text = GATE.read_text(encoding="utf-8")
        self.assertIn('.approval.mode // "required"', text)       # a missing result stays strict
        self.assertIn("OBSERVE-ONLY", text)
        self.assertIn("approval status: valid=", text)             # observe still tells valid from missing/invalid
        self.assertIn("Policy change: approval must be an APPROVED review on this head commit", text)

    def test_the_aggregate_step_reads_the_graph_from_the_base_sha(self):
        text = GATE.read_text(encoding="utf-8")
        start = text.index("python -m pgraph aggregate")
        command = text[start:text.index("|| true", start)]
        self.assertIn('--base "$BASE_SHA"', command)


if __name__ == "__main__":
    unittest.main()
