"""RT-1554 P1: observe-only evidence for a behavioral-tier diff.

The checker reuses graph.yaml tiers. It warns when those paths change and the
same diff has no discovered test and no `coverage-evidence: RT-N` line. Report
mode never fails the job. A changed test file is a signal, not proof.
"""

import pathlib
import unittest

import yaml

import support
from pgraph.coverage_evidence import judge
from pgraph.evaluate import Change
from pgraph.graph import Graph, load_graph

GRAPH = Graph(load_graph(support.trusted_text()))
REPO = pathlib.Path(__file__).resolve().parents[3]
WORKFLOW = REPO / ".github" / "workflows" / "project-graph.yml"

SALE = "services/backend-core/apps/api/src/catalog/sales/capture.ts"
POS_MONEY = "apps/pos/src/shared/money.ts"
POS_TEST = "apps/pos/src/shared/money.test.ts"
DOCS = "apps/pos/docs/cashier.md"
LOCK = "apps/pos/package-lock.json"
PRELOAD = "apps/pos/src/preload/index.ts"
GENERATED = "apps/pos/src/shared/api-types.ts"


def _added(*paths):
    return tuple(Change("A", path) for path in paths)


class CoverageEvidenceTests(unittest.TestCase):

    def test_sales_tier_source_without_a_test_warns(self):
        report = judge(GRAPH, _added(SALE), "")
        self.assertEqual(report.warnings, (SALE,))
        self.assertEqual(report.needs_review, ())
        self.assertEqual(report.not_executed, ())
        self.assertIn("not proof", report.warning_note)

    def test_discovered_test_in_the_same_diff_is_quiet(self):
        report = judge(GRAPH, _added(POS_MONEY, POS_TEST), "")
        self.assertEqual(report.warnings, ())
        self.assertEqual(report.needs_review, ())
        self.assertEqual(report.not_executed, ())

    def test_deleting_a_test_does_not_silence_the_warning(self):
        report = judge(GRAPH, (Change("M", POS_MONEY), Change("D", POS_TEST)), "")
        self.assertEqual(report.warnings, (POS_MONEY,))

    def test_docs_only_diff_is_quiet(self):
        report = judge(GRAPH, _added(DOCS), "")
        self.assertEqual(report.warnings, ())
        self.assertEqual(report.needs_review, ())

    def test_lockfile_only_diff_is_quiet(self):
        report = judge(GRAPH, _added(LOCK), "")
        self.assertEqual(report.warnings, ())

    def test_preload_wire_and_generated_client_are_quiet(self):
        report = judge(GRAPH, _added(PRELOAD, GENERATED), "")
        self.assertEqual(report.warnings, ())

    def test_evidence_line_is_recorded_as_not_executed(self):
        report = judge(GRAPH, _added(SALE), "coverage-evidence: RT-302\n")
        self.assertEqual(report.warnings, ())
        self.assertEqual(report.not_executed, ("RT-302",))
        self.assertEqual(report.needs_review, ())

    def test_malformed_evidence_line_needs_review_and_does_not_raise(self):
        report = judge(GRAPH, _added(SALE), "coverage-evidence: nope\n")
        self.assertTrue(report.needs_review)
        self.assertEqual(report.not_executed, ())
        self.assertEqual(report.warnings, (SALE,))

    def test_ambiguous_path_needs_review(self):
        class Ambiguous:
            def classify(self, path):
                from pgraph.graph import Classification
                return Classification("ambiguous", ("a", "b"), ())

        report = judge(Ambiguous(), _added(SALE), "")
        self.assertTrue(report.needs_review)
        self.assertEqual(report.warnings, ())


class CoverageEvidenceWorkflowTests(unittest.TestCase):

    def test_boundary_check_runs_report_mode_on_the_existing_diff(self):
        data = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
        data["on"] = data.pop(True, data.get("on"))
        job = data["jobs"]["boundary-check"]
        checkout = next(step for step in job["steps"] if str(step.get("uses", "")).startswith("actions/checkout@"))
        self.assertEqual(checkout["with"]["fetch-depth"], 2)
        step = next(step for step in job["steps"] if "coverage-evidence" in step.get("run", ""))
        self.assertIn("--mode report", step["run"])
        self.assertIn("HEAD^1", step["run"])
        self.assertIn("HEAD", step["run"])
        self.assertNotIn("exit 1", step["run"])
        self.assertEqual(step["env"]["COVERAGE_EVIDENCE_BODY"], "${{ github.event.pull_request.body }}")


if __name__ == "__main__":
    unittest.main()
