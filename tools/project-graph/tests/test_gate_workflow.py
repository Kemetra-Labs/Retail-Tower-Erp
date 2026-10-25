"""Structural checks on the gate workflow, .github/workflows/gate.yml (RT-711 S5 / RT-721).

The gate runs one evaluation per head SHA with `cancel-in-progress: true`, so a
newer `workflow_run` cancels an older evaluation that is still running. `always()`
keeps a job running through that cancellation: the `post` job then published the
cancelled evaluation's verdict. Observed on Kemetra/Retail-Tower-Shadow:
  - run 40095276874 (PR #33): `evaluate` cancelled before `aggregate`, `post` still ran
    and posted `required` = failure with an EMPTY summary (check-run 120876190379);
  - run 40093787904 (PR #32): `evaluate` cancelled, `post` still ran and posted the
    superseded `JOB_PENDING` snapshot (check-run 120871800160).
A superseded run must publish nothing: the run that superseded it normally posts (if that
one fails before the `pr` step, nothing is posted until a re-run: fail-closed)."""

import pathlib
import re
import unittest

import yaml

import support

REPO = pathlib.Path(__file__).resolve().parents[3]
GATE = REPO / ".github" / "workflows" / "gate.yml"


def _post_condition():
    workflow = yaml.safe_load(GATE.read_text(encoding="utf-8"))
    return str(workflow["jobs"]["post"]["if"])


class GatePostCancellationTests(unittest.TestCase):

    def test_post_does_not_run_through_cancellation(self):
        self.assertNotIn("always()", _post_condition(),
                         "always() runs post in a cancelled (superseded) run and publishes a stale verdict")

    def test_post_skips_cancelled_runs_explicitly(self):
        self.assertIn("!cancelled()", _post_condition())

    def test_post_still_runs_after_an_evaluate_crash(self):
        # !cancelled() is true when evaluate merely fails, so a crash still posts a failing `required`.
        self.assertTrue(re.search(r"needs\.evaluate\.outputs\.head_sha\s*!=\s*''", _post_condition()))


def _gate_triggers():
    workflow = yaml.safe_load(GATE.read_text(encoding="utf-8"))
    on = workflow.get("on", workflow.get(True))  # PyYAML reads a bare `on:` key as True
    return set(on["workflow_run"]["workflows"])


class GateWorkflowRunTriggerTests(unittest.TestCase):
    """The gate re-evaluates only when a listed workflow completes. A workflow that defines a
    graph job but is missing from the list can finish last and leave `required` at JOB_PENDING
    (RT-868: `contracts` was added without being listed)."""

    def test_every_graph_job_workflow_triggers_the_gate(self):
        jobs = support.load_graph(support.trusted_text())["jobs"]
        names = {}
        for key, path in jobs.items():
            name = yaml.safe_load((REPO / path).read_text(encoding="utf-8"))["name"]
            names.setdefault(name, []).append(key)
        missing = {name: keys for name, keys in names.items() if name not in _gate_triggers()}
        self.assertEqual(missing, {}, "workflows defining graph jobs are missing from "
                                      "gate.yml on.workflow_run.workflows")


class GatePostTokenTests(unittest.TestCase):
    """Owner decision (2026-10-25, after the RT-715 cutover): `post` writes `required` with the
    workflow's own GITHUB_TOKEN, scoped to checks:write, instead of a kemetra-ci-gate App token.
    The gate then needs no App installation, variable or secret."""

    def _post(self):
        return yaml.safe_load(GATE.read_text(encoding="utf-8"))["jobs"]["post"]

    def test_post_needs_no_app_variable_or_secret(self):
        text = yaml.safe_dump(self._post())
        for needle in ("create-github-app-token", "secrets.", "vars."):
            with self.subTest(needle=needle):
                self.assertNotIn(needle, text)

    def test_post_token_is_checks_write_only(self):
        self.assertEqual(self._post()["permissions"], {"checks": "write"})

    def test_evaluate_stays_read_only(self):
        workflow = yaml.safe_load(GATE.read_text(encoding="utf-8"))
        self.assertNotIn("permissions", workflow["jobs"]["evaluate"])
        self.assertNotIn("write", yaml.safe_dump(workflow["permissions"]))


if __name__ == "__main__":
    unittest.main()
