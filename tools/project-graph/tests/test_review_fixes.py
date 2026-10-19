"""Regression tests for the 2026-10-19 code and security review findings.
Each test reproduces a scenario that was proven to slip through before."""

import os
import subprocess
import tempfile
import time
import unittest

from pgraph import aggregate as ag
from pgraph import boundary as bd
from pgraph import evaluate as ev
from pgraph import github, gitio
from pgraph.globs import GlobError, compile_glob
from pgraph.graph import Graph, GraphError, load_graph, validate_graph
from pgraph.privileges import scan_workflow

import support


def _codes(text):
    return {p["code"] for p in scan_workflow("wf.yml", text)}


PRT = "on: pull_request_target\npermissions: {contents: read}\n"


class PrivilegeEvasionTests(unittest.TestCase):

    def test_top_level_env_secret(self):
        text = PRT + "env: {T: '${{ secrets.X }}'}\njobs: {j: {runs-on: x, steps: [{run: echo}]}}\n"
        self.assertIn("SECRET_OUTSIDE_ENV", _codes(text))

    def test_secrets_inherit_and_bracket_and_tojson(self):
        for job in ("{uses: ./.github/workflows/x.yml, secrets: inherit}",
                    "{runs-on: x, steps: [{run: \"echo ${{ toJSON(secrets) }}\"}]}",
                    "{runs-on: x, steps: [{run: \"echo ${{ secrets['X'] }}\"}]}"):
            with self.subTest(job=job):
                self.assertIn("SECRET_OUTSIDE_ENV", _codes(PRT + f"jobs: {{j: {job}}}\n"))

    def test_untrusted_checkout_ref_or_repository(self):
        for with_ in ("{ref: '${{ github.head_ref }}'}", "{ref: '${{ env.R }}'}",
                      "{repository: '${{ github.event.pull_request.head.repo.full_name }}'}"):
            with self.subTest(with_=with_):
                text = PRT + f"jobs: {{j: {{runs-on: x, steps: [{{uses: actions/checkout@a, with: {with_}}}]}}}}\n"
                self.assertIn("HEAD_CHECKOUT_PRIVILEGED", _codes(text))

    def test_checkout_case_and_run_step_checkout(self):
        text = PRT + "jobs: {j: {runs-on: x, steps: [{uses: Actions/Checkout@a, with: {ref: refs/pull/1/head}}]}}\n"
        self.assertIn("HEAD_CHECKOUT_PRIVILEGED", _codes(text))
        text = PRT + "jobs: {j: {runs-on: x, steps: [{run: gh pr checkout 1}]}}\n"
        self.assertIn("HEAD_CHECKOUT_PRIVILEGED", _codes(text))

    def test_base_sha_checkout_is_allowed(self):
        text = PRT + "jobs: {j: {runs-on: x, steps: [{uses: actions/checkout@a, with: {ref: '${{ steps.pr.outputs.base_sha }}'}}]}}\n"
        self.assertEqual(_codes(text), set())

    def test_any_non_allow_listed_trigger_is_in_scope(self):
        for trig in ("issue_comment", "pull_request_review", "check_run", "workflow_call"):
            with self.subTest(trig=trig):
                self.assertIn("PERM_WRITE", _codes(f"on: {trig}\npermissions: write-all\njobs: {{}}\n"))
        self.assertEqual(_codes("on: [push, schedule, workflow_dispatch]\npermissions: write-all\njobs: {}\n"), set())


class BoundaryUnscannedTests(unittest.TestCase):

    def test_oversize_file_is_reported_not_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = "apps/pos/src/big.ts"
            os.makedirs(os.path.join(tmp, "apps/pos/src"))
            with open(os.path.join(tmp, path), "w") as fh:
                fh.write("//" + "x" * (bd.MAX_FILE_BYTES + 10))
            files, unscanned = bd.read_worktree_files(tmp, {path})
        self.assertEqual(files, {})
        graph = Graph(load_graph(support.trusted_text()))
        result = bd.scan(graph, files, [], unscanned=unscanned)
        self.assertEqual([(v["from"], v["rule"]) for v in result["violations"]], [(path, "unscanned-file")])


class AggregatorUnknownJobTests(unittest.TestCase):

    def test_job_without_trusted_workflow_is_never_green(self):
        plan = {"schema": "retail-tower/plan@1", "graph_validation": {"status": "pass"},
                "needed_jobs": ["ghost"], "head_sha": "h", "base_sha": "b", "policy_fingerprint": "f",
                "approval_required": False, "job_event": "pull_request"}
        graph = {"trusted_check_producer": {"app_id": 15368}, "jobs": {}, "policy_approvers": []}
        run = {"name": "ghost", "app_id": 15368, "workflow_path": None, "head_sha": "h", "event": "pull_request",
               "run_id": 1, "run_attempt": 1, "status": "completed", "conclusion": "success"}
        result = ag.aggregate(plan, [run], [], graph)
        self.assertEqual((result["conclusion"], result["reasons"]), ("failure", ["UNKNOWN_JOB"]))


class GraphCrashClassTests(unittest.TestCase):

    def test_hostile_yaml_raises_graph_error(self):
        for text in ("? [a]\n: 1\n", "a: " + "[" * 5000 + "]" * 5000 + "\n"):
            with self.subTest(text=text[:20]):
                with self.assertRaises(GraphError):
                    load_graph(text)

    def test_invalid_edge_and_generated_globs_are_validation_errors(self):
        g = load_graph(support.trusted_text())
        g["edges"][0]["via"] = ["/abs/**"]
        g["generated"][0]["sources"] = ["a/**x"]
        codes = {e.split(":", 1)[0] for e in validate_graph(g, tree_paths=set(), workflow_jobs=dict(g["jobs"]))}
        self.assertIn("GLOB_INVALID", codes)

    def test_bad_selects_and_non_string_keys(self):
        g = load_graph(support.trusted_text())
        g["shared_classes"]["docs"]["selects"] = ["e2ee"]
        self.assertIn("SCHEMA", {e.split(":", 1)[0] for e in validate_graph(g, workflow_jobs=dict(g["jobs"]))})
        g = load_graph(support.trusted_text())
        g["products"][1] = g["products"]["pos"]
        self.assertIn("SCHEMA", {e.split(":", 1)[0] for e in validate_graph(g)})

    def test_binary_and_set_tags_in_proposed_graph_fail_closed(self):
        for extra in ("x: !!binary aGk=\n", "x: !!set {a, b}\n"):
            with self.subTest(extra=extra):
                inp = support.eval_input({"changes": [{"status": "M", "path": "tools/project-graph/graph.yaml"}]})
                inp = ev.EvalInput(**{**inp.__dict__, "proposed_text": support.trusted_text() + extra})
                plan = ev.evaluate(inp)
                self.assertIn("GRAPH_INVALID", plan["graph_validation"]["reasons"])


class GlobHardeningTests(unittest.TestCase):

    def test_expansion_and_double_star_caps(self):
        for bad in ("{a,b}/" * 8 + "x", "/".join(["**"] * 5) + "/x", "a" * 600):
            with self.subTest(bad=bad[:30]):
                with self.assertRaises(GlobError):
                    compile_glob(bad)

    def test_expansion_cap_applies_within_group_cap(self):
        with self.assertRaises(GlobError):
            compile_glob("{a,b,c}/{a,b,c}/{a,b,c}/{a,b,c}")    # 4 groups, 81 > 64 patterns
        compile_glob("{a,b}/{a,b}/{a,b}/{a,b}/{a,b}/{a,b}")       # 6 groups, 64 patterns: allowed

    def test_allowed_double_stars_match_fast(self):
        g = compile_glob("a/**/b/**/c/**")
        start = time.monotonic()
        g.match("/".join(["a"] + ["x"] * 40))
        self.assertLess(time.monotonic() - start, 0.5)

    def test_newlines_in_paths(self):
        self.assertTrue(compile_glob("apps/pos/**").match("apps/pos/a\nb"))
        self.assertFalse(compile_glob("docs/*.md").match("docs/a.md\n"))


class ApprovalStateTests(unittest.TestCase):

    def test_only_approved_reviews_count(self):
        body = "policy-change-approved: base=" + "1" * 40 + " fingerprint=" + "a" * 64
        review = {"user": {"login": "h", "type": "User"}, "body": body, "commit_id": "2" * 40}
        self.assertEqual(len(github.approvals_from_reviews([{**review, "state": "APPROVED"}])), 1)
        self.assertEqual(github.approvals_from_reviews([{**review, "state": "COMMENTED"}]), [])


class GitIoRobustnessTests(unittest.TestCase):

    def test_non_utf8_and_oversize_graph_read_as_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            def run(*a):
                subprocess.run(["git", "-C", tmp, *a], check=True, capture_output=True)
            run("init", "-q")
            with open(os.path.join(tmp, "bad.yaml"), "wb") as fh:
                fh.write(b"a: \xff\xfe\n")
            with open(os.path.join(tmp, "big.yaml"), "w") as fh:
                fh.write("a: " + "x" * (gitio.MAX_TEXT_BYTES + 1))
            run("add", "-A")
            run("-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "-m", "x")
            self.assertIsNone(gitio.read_text(tmp, "HEAD", "bad.yaml"))
            self.assertIsNone(gitio.read_text(tmp, "HEAD", "big.yaml"))


if __name__ == "__main__":
    unittest.main()
