"""R5 / T-A static privilege invariants for workflows that PR code can reach."""

import textwrap
import unittest

from pgraph.privileges import scan_workflow


def _codes(text):
    return {p["code"] for p in scan_workflow("wf.yml", textwrap.dedent(text))}


GOOD_PR = """
on: pull_request
permissions: {contents: read}
jobs:
  t:
    runs-on: x
    steps:
      - uses: actions/checkout@abc
"""


class PrivilegeTests(unittest.TestCase):

    def test_read_only_pr_workflow_passes(self):
        self.assertEqual(_codes(GOOD_PR), set())

    def test_write_permission_on_pr_trigger_fails(self):
        self.assertIn("PERM_WRITE", _codes(GOOD_PR.replace("contents: read", "contents: write")))
        self.assertIn("PERM_WRITE", _codes(GOOD_PR.replace("{contents: read}", "write-all")))

    def test_job_level_write_fails(self):
        text = GOOD_PR.replace("    runs-on: x", "    runs-on: x\n    permissions: {checks: write}")
        self.assertIn("PERM_WRITE", _codes(text))

    def test_missing_permissions_fails_closed(self):
        self.assertIn("PERMISSIONS_MISSING", _codes(GOOD_PR.replace("permissions: {contents: read}\n", "")))

    def test_secret_outside_ci_gate_environment_fails(self):
        text = GOOD_PR + "        with: {token: '${{ secrets.DEPLOY_KEY }}'}\n"
        self.assertIn("SECRET_OUTSIDE_ENV", _codes(text))

    def test_secret_inside_ci_gate_environment_is_allowed(self):
        text = """
        on: pull_request_target
        permissions: {contents: read}
        jobs:
          gate:
            runs-on: x
            environment: ci-gate
            steps:
              - uses: actions/checkout@abc
                with: {ref: '${{ steps.pr.outputs.base_sha }}'}
              - uses: actions/create-github-app-token@abc
                with: {private-key: '${{ secrets.CI_GATE_APP_PRIVATE_KEY }}'}
        """
        self.assertEqual(_codes(text), set())

    def test_privileged_head_checkout_fails(self):
        for ref in ("${{ github.event.pull_request.head.sha }}", "refs/pull/1/merge",
                    "${{ github.event.workflow_run.head_sha }}"):
            with self.subTest(ref=ref):
                text = f"""
                on: pull_request_target
                permissions: {{contents: read}}
                jobs:
                  g:
                    runs-on: x
                    steps:
                      - uses: actions/checkout@abc
                        with: {{ref: '{ref}'}}
                """
                self.assertIn("HEAD_CHECKOUT_PRIVILEGED", _codes(text))

    def test_cache_and_artifacts_in_privileged_workflow_fail(self):
        text = """
        on: {workflow_run: {workflows: [x], types: [completed]}}
        permissions: {contents: read}
        jobs:
          g:
            runs-on: x
            steps:
              - uses: actions/cache@abc
              - uses: actions/download-artifact@abc
        """
        self.assertEqual(_codes(text), {"CACHE_IN_PRIVILEGED", "ARTIFACT_IN_PRIVILEGED"})

    def test_push_only_workflow_is_out_of_scope(self):
        self.assertEqual(_codes("on: {push: {branches: [main]}}\npermissions: write-all\njobs: {}\n"), set())

    def test_unparsable_workflow_fails(self):
        self.assertIn("WORKFLOW_INVALID", _codes("on: [\n"))


if __name__ == "__main__":
    unittest.main()
