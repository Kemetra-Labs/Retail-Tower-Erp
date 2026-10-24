"""Structural checks on the staged gate workflow (RT-711 S5 / RT-721).

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

GATE = pathlib.Path(__file__).resolve().parents[3] / ".github" / "workflows" / "gate.yml"


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


if __name__ == "__main__":
    unittest.main()
