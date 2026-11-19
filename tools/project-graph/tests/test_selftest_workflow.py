"""RT-1467 CI-06: project-graph-selftest.yml must not repeat what a gated job already runs.

`boundary-check` (project-graph.yml, an always job) runs `pgraph boundary`, and `contracts/check`
(contracts.yml) runs the release tooling's offline specs, so the advisory selftest runs neither. It
only runs when a path it tests changes (its unit tests also read .circleci/ and .depot/ files).
`evaluate` already fails closed with UNKNOWN_PATH for a changed path no class owns, so the tree-wide
`classify-tree` step is not the only guard for new paths."""

import pathlib
import unittest

import yaml

REPO = pathlib.Path(__file__).resolve().parents[3]
WORKFLOWS = REPO / ".github" / "workflows"


def _load(name):
    data = yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))
    data["on"] = data.pop(True, data.get("on"))      # PyYAML reads the bare key `on` as True
    return data


def _run_lines(workflow):
    for job in workflow["jobs"].values():
        for step in job.get("steps", []):
            if "run" in step:
                yield from step["run"].splitlines()


class SelftestWorkflowTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.selftest = _load("project-graph-selftest.yml")

    def test_selftest_does_not_repeat_the_boundary_check(self):
        self.assertFalse([l for l in _run_lines(self.selftest) if "pgraph boundary" in l])

    def test_selftest_does_not_repeat_the_release_specs(self):
        self.assertNotIn("release-selftest", self.selftest["jobs"])
        self.assertFalse([l for l in _run_lines(self.selftest) if ".github/release" in l])

    def test_the_gated_jobs_still_run_what_the_selftest_dropped(self):
        boundary = "\n".join(_run_lines(_load("project-graph.yml")))
        contracts = "\n".join(_run_lines(_load("contracts.yml")))
        self.assertIn("pgraph boundary", boundary)
        self.assertIn("node --test .github/release/compat-gate.test.cjs", contracts)
        self.assertIn("unittest discover -s .github/release", contracts)

    def test_selftest_runs_only_when_a_path_it_tests_changes(self):
        for event in ("pull_request", "push"):
            with self.subTest(event=event):
                self.assertEqual(sorted(self.selftest["on"][event]["paths"]),
                                 [".circleci/**", ".depot/**", ".github/**", "tools/project-graph/**"])


if __name__ == "__main__":
    unittest.main()
