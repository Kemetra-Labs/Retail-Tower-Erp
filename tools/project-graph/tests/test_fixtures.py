"""Runs every fixture in fixtures/ (P01-P19, X01-X07) against the real
evaluator, aggregator and boundary check. Expectations are hand-written in the
fixture files, never computed by the code under test."""

import unittest

from pgraph import aggregate as ag
from pgraph import boundary as bd
from pgraph import evaluate as ev
from pgraph.graph import Graph, load_graph

import support

PRODUCTS = {"pos", "admin-console", "backend-core", "erpnext-connector"}


class FixtureTests(unittest.TestCase):

    def test_all_fixture_cases(self):
        files = support.fixture_files()
        ids = sorted(support.load_fixture(f)["id"] for f in files)
        expected_ids = [f"P{n:02d}" for n in range(1, 20)] + [f"X{n:02d}" for n in range(1, 9)]
        self.assertEqual(ids, expected_ids)
        for path in files:
            fx = support.load_fixture(path)
            for case in fx["cases"]:
                with self.subTest(fixture=fx["id"], case=case["name"]):
                    self._run_case(case)

    def _run_case(self, case):
        kind = case.get("kind", "plan")
        if kind == "boundary":
            return self._boundary_case(case)
        if kind == "fingerprint":
            return self._fingerprint_case(case)
        if kind == "aggregate":
            plan = None if case["plan"] == "missing" else case["plan"]
            graph = load_graph(support.trusted_text())
            result = ag.aggregate(plan, [], [], graph)
            return self._check_required(case["expect_required"], result)

        inp = support.eval_input(case)
        plan = ev.evaluate(inp)
        if "expect_plan" in case:
            self._check_plan(case["expect_plan"], plan)
        if "expect_required" in case:
            graph = load_graph(inp.trusted_text)
            result = ag.aggregate(
                plan,
                support.check_runs(case, plan, graph),
                support.approvals(case, plan),
                graph,
                deadline_passed=case.get("deadline_passed", False),
            )
            self._check_required(case["expect_required"], result)

    def _check_plan(self, want, plan):
        selected = {p for p, v in plan["products"].items() if v["run"]}
        if want["select"] == "all":
            self.assertTrue(plan["select_all"], plan["graph_validation"])
            self.assertEqual(selected, PRODUCTS)
        elif want["select"] == "nothing":
            # An invalid TRUSTED graph cannot place any job: nothing is needed, and the
            # workflows' plan job fails, so `required` fails with GRAPH_VALIDATION_FAILED.
            self.assertTrue(plan["select_all"], plan["graph_validation"])
            self.assertEqual((selected, plan["needed_jobs"]), (set(), []))
        else:
            self.assertFalse(plan["select_all"], plan["graph_validation"])
            self.assertEqual(selected, set(want["select"]))
        self.assertEqual(plan["graph_validation"]["status"], want["graph_validation"])
        self.assertEqual(set(plan["graph_validation"]["reasons"]), set(want["reasons"]))
        for key in ("policy_change", "boundary_review"):
            if key in want:
                self.assertEqual(plan[key], want[key], key)
        if "e2e" in want:
            self.assertEqual(plan["e2e"]["run"], want["e2e"])
        for text in want.get("details_contain", []):
            details = [d for ds in plan["graph_validation"]["details"].values() for d in ds]
            self.assertTrue(any(text in d for d in details), details)
        if "notes" in want:
            self.assertEqual(set(plan["notes"]), set(want["notes"]))
        for product, tiers in want.get("product_tiers", {}).items():
            self.assertTrue(set(tiers) <= set(plan["products"][product]["tiers"]), plan["products"][product])
        paths = {p["path"]: p for p in plan["paths"]}
        for path, tiers in want.get("path_tiers", {}).items():
            self.assertIn(path, paths)
            self.assertEqual(set(paths[path]["tiers"]), set(tiers), paths[path])
        for path, tiers in want.get("path_trusted_tiers", {}).items():
            self.assertEqual(set(paths[path]["trusted"]["tiers"]), set(tiers), paths[path])

    def _check_required(self, want, result):
        self.assertEqual(result["conclusion"], want["conclusion"], result)
        self.assertEqual(set(result["reasons"]), set(want["reasons"]), result)
        if "ignored" in want:
            self.assertEqual(len(result["ignored"]), want["ignored"], result["ignored"])
        for problem in want.get("approval_problems", []):
            self.assertIn(problem, result["approval"]["problems"], result["approval"])

    def _boundary_case(self, case):
        graph = Graph(load_graph(support.trusted_text()))
        result = bd.scan(graph, case["files"], case.get("ratchet", []))
        got = {(v["from"], v["to_product"], v["rule"]) for v in result["violations"]}
        want = {(v["from"], v["to_product"], v["rule"]) for v in case["expect_violations"]}
        self.assertEqual(got, want, result["violations"])
        if "expect_ratcheted" in case:
            self.assertEqual(len(result["ratcheted"]), case["expect_ratcheted"])
        self.assertEqual(len(result["stale_ratchet"]), case.get("expect_stale", 0))
        self.assertEqual(result["ok"], not want and not case.get("expect_stale", 0))

    def _fingerprint_case(self, case):
        fa = ev.policy_fingerprint(support.BASE, "t", "p", support.changes(case["a"]))
        fb = ev.policy_fingerprint(support.BASE, "t", "p", support.changes(case["b"]))
        self.assertEqual(fa == fb, case["expect_equal"])


if __name__ == "__main__":
    unittest.main()
