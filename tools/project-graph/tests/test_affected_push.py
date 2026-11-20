"""RT-1471 Phase 3: affected-only CI on a push to main.

A push is classified by its first-parent diff (`parent..sha`) with the same rules as a pull request.
Every uncertainty selects FULL: no parent, a base that is not the first parent, a diff that cannot be read,
an empty diff, and every existing fail-closed rule (unknown path, invalid graph, policy change).
The nightly `schedule` and an owner-pinned `workflow_dispatch` stay FULL.

Offline only: the evaluator in memory, the CLI and the plan action's commit-resolution step in throwaway
git repositories. Nothing is dispatched."""

import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

import yaml

import support
from pgraph import evaluate as ev
from pgraph.graph import load_graph

REPO_ROOT = support.PG_ROOT.parents[1]
ACTION = REPO_ROOT / ".github/actions/pgraph-plan/action.yml"
BASH = shutil.which("bash")
GIT = shutil.which("git")
GRAPH = load_graph(support.trusted_text())
ALWAYS = set(GRAPH["always_jobs"])
E2E = GRAPH["e2e_job"]


def _plan(event, paths, base=support.BASE, head=support.HEAD, diff_error=False):
    return ev.evaluate(ev.EvalInput(
        event=event, base_sha=base, head_sha=head,
        changes=support.changes([{"status": "M", "path": p} for p in paths]),
        trusted_text=support.trusted_text(), diff_error=diff_error,
        workflow_jobs=dict(GRAPH["jobs"]),
    ))


def _product_jobs(name):
    return set(GRAPH["products"][name]["ci_jobs"])


class PushSelectionTests(unittest.TestCase):

    def test_a_one_product_push_runs_that_product_the_always_jobs_and_e2e_only(self):
        plan = _plan("push", ["apps/pos/src/main/index.ts"])
        self.assertFalse(plan["select_all"], plan["select_all_reasons"])
        self.assertEqual(plan["graph_validation"]["status"], "pass")
        self.assertEqual([p for p, v in plan["products"].items() if v["run"]], ["pos"])
        others = set(GRAPH["jobs"]) - _product_jobs("pos") - ALWAYS - {E2E}
        self.assertEqual(set(plan["needed_jobs"]) & others, set())
        self.assertTrue(set(plan["needed_jobs"]) <= _product_jobs("pos") | ALWAYS | {E2E})
        self.assertIn("PUSH_FIRST_PARENT_DIFF", plan["notes"])
        self.assertNotIn("FULL_RUN_EVENT", plan["notes"])

    def test_a_push_selects_exactly_what_the_same_diff_selects_on_a_pull_request(self):
        for paths in (["apps/pos/src/main/index.ts"],
                      ["apps/admin-console/src/x.ts", "integrations/erpnext-connector/x.py"],
                      ["services/backend-core/packages/contracts/openapi/x.yaml"],
                      ["apps/pos/docs/a.md"], ["README.md"]):
            with self.subTest(paths=paths):
                push, pr = _plan("push", paths), _plan("pull_request", paths)
                self.assertEqual(sorted(push["needed_jobs"]), sorted(pr["needed_jobs"]))
                self.assertEqual(push["select_all"], pr["select_all"])

    def test_schedule_and_dispatch_stay_full_whatever_the_diff(self):
        for event in ("schedule", "workflow_dispatch"):
            with self.subTest(event):
                plan = _plan(event, ["apps/pos/docs/a.md"])
                self.assertTrue(plan["select_all"])
                self.assertIn("FULL_RUN_EVENT", plan["select_all_reasons"])
                self.assertEqual(sorted(plan["needed_jobs"]), sorted(GRAPH["jobs"]))


class PushFailClosedTests(unittest.TestCase):
    """Each uncertainty selects every graph job."""

    def _assert_full(self, plan, reason):
        self.assertTrue(plan["select_all"])
        self.assertIn(reason, plan["select_all_reasons"])
        self.assertEqual(sorted(plan["needed_jobs"]), sorted(GRAPH["jobs"]))

    def test_no_parent_is_full(self):
        # the plan action passes base == head when it cannot prove a single-commit first-parent push
        self._assert_full(_plan("push", ["apps/pos/docs/a.md"], base=support.HEAD), "PUSH_NO_PARENT")

    def test_an_empty_diff_is_full(self):
        self._assert_full(_plan("push", []), "PUSH_EMPTY_DIFF")

    def test_an_unreadable_diff_is_full(self):
        self._assert_full(_plan("push", [], diff_error=True), "DIFF_UNAVAILABLE")

    def test_an_unknown_path_is_full(self):
        self._assert_full(_plan("push", ["NEW-TOP-LEVEL/x"]), "UNKNOWN_PATH")

    def test_a_policy_path_is_full(self):
        self._assert_full(_plan("push", ["tools/project-graph/graph.yaml"]), "CLASS_POLICY")

    def test_an_invalid_trusted_graph_is_full(self):
        plan = ev.evaluate(ev.EvalInput(
            event="push", base_sha=support.BASE, head_sha=support.HEAD,
            changes=support.changes([{"status": "M", "path": "apps/pos/docs/a.md"}]),
            trusted_text=support.trusted_text(), workflow_jobs={}))
        self.assertTrue(plan["select_all"])
        self.assertIn("GRAPH_INVALID", plan["graph_validation"]["reasons"])


def _git(cwd, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid")
    return subprocess.run([GIT, *args], cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout.strip()


@unittest.skipUnless(BASH and GIT, "bash and git are required")
class PlanActionPushRefsTests(unittest.TestCase):
    """The plan action's commit resolution for push, run for real: base is the first parent only for a
    single-commit, non-forced push to main whose `before` is that parent; otherwise base == head (FULL)."""

    @classmethod
    def setUpClass(cls):
        step = [s for s in yaml.safe_load(ACTION.read_text(encoding="utf-8"))["runs"]["steps"]
                if s.get("id") == "refs"][0]
        cls.script = step["run"]
        cls.repo = tempfile.mkdtemp()
        _git(cls.repo, "init", "-q", "-b", "main")
        shas = []
        for i in range(3):
            pathlib.Path(cls.repo, "f").write_text(str(i), encoding="utf-8")
            _git(cls.repo, "add", "f")
            _git(cls.repo, "commit", "-q", "-m", str(i))
            shas.append(_git(cls.repo, "rev-parse", "HEAD"))
        cls.root, cls.parent, cls.sha = shas

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.repo, ignore_errors=True)

    def _run(self, **env):
        out = pathlib.Path(self.repo, "out.txt")
        out.write_text("", encoding="utf-8")
        base = {"PATH": os.environ["PATH"], "GITHUB_OUTPUT": str(out), "PR_BASE": "", "PR_HEAD": "",
                "SHA": self.sha, "REF": "refs/heads/main", "EXPECTED_SHA": "", "EVENT": "push",
                "BEFORE": self.parent, "FORCED": "false"}
        base.update(env)
        proc = subprocess.run([BASH, "-c", self.script], cwd=self.repo, env=base, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        return dict(line.split("=", 1) for line in out.read_text(encoding="utf-8").splitlines())

    def test_a_single_commit_push_uses_the_first_parent(self):
        self.assertEqual(self._run(), {"base": self.parent, "head": self.sha})

    def test_every_uncertain_push_falls_back_to_full(self):
        for label, env in (("multi-commit push", {"BEFORE": self.root}),
                           ("new branch", {"BEFORE": "0" * 40}),
                           ("missing before", {"BEFORE": ""}),
                           ("junk before", {"BEFORE": "main; rm -rf /"}),
                           ("forced", {"FORCED": "true"}),
                           ("forced unknown", {"FORCED": ""}),
                           ("not main", {"REF": "refs/heads/feature"}),
                           ("root commit", {"SHA": self.root, "BEFORE": "0" * 40})):
            with self.subTest(label):
                got = self._run(**env)
                self.assertEqual(got["base"], got["head"])
                self.assertEqual(got["head"], env.get("SHA", self.sha))


@unittest.skipUnless(GIT, "git is required")
class CliFirstParentTests(unittest.TestCase):
    """`cli.changes_for` trusts a push base only if it is the head's first parent. Run on a throwaway
    repository (CI checks this repository out at depth 1), with a true merge commit:

        root - a ------- m        m = merge of b into a, first parent a
                \       /
                 b ----
    """

    @classmethod
    def setUpClass(cls):
        from pgraph import cli, gitio
        cls.cli, cls.gitio = cli, gitio
        cls.repo = tempfile.mkdtemp()
        r = cls.repo
        _git(r, "init", "-q", "-b", "main")

        def commit(name, text):
            pathlib.Path(r, name).write_text(text, encoding="utf-8")
            _git(r, "add", name)
            _git(r, "commit", "-q", "-m", name)
            return _git(r, "rev-parse", "HEAD")
        cls.root = commit("root.txt", "r")
        cls.a = commit("a.txt", "a")
        _git(r, "checkout", "-q", "-b", "side", cls.root)
        cls.b = commit("b.txt", "b")
        _git(r, "checkout", "-q", "main")
        _git(r, "merge", "-q", "--no-ff", "-m", "merge", "side")
        cls.m = _git(r, "rev-parse", "HEAD")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.repo, ignore_errors=True)

    def _paths(self, base, head):
        _, changes = self.cli.changes_for(self.repo, "push", base, head)
        return sorted(c.path for c in changes)

    def test_a_first_parent_base_gives_its_diff(self):
        self.assertEqual(self._paths(self.root, self.a), ["a.txt"])

    def test_a_merge_is_judged_on_everything_it_brings_to_its_first_parent(self):
        self.assertEqual(self._paths(self.a, self.m), ["b.txt"])

    def test_any_other_base_is_refused(self):
        for label, base, head in (("second parent", self.b, self.m), ("grandparent", self.root, self.m),
                                  ("unknown base", "f" * 40, self.a), ("root head", self.a, self.root),
                                  ("unknown head", self.a, "e" * 40)):
            with self.subTest(label):
                with self.assertRaises(self.gitio.DiffUnavailable):
                    self.cli.changes_for(self.repo, "push", base, head)

    def test_base_equal_to_head_is_left_to_the_evaluator(self):
        # the plan action's "not one first-parent commit" signal: an empty diff, PUSH_NO_PARENT in evaluate
        self.assertEqual(self._paths(self.m, self.m), [])

    def test_pull_requests_are_unchanged(self):
        diff_base, _ = self.cli.changes_for(self.repo, "pull_request", self.a, self.b)
        self.assertEqual(diff_base, self.root)


SONAR = REPO_ROOT / ".github/workflows/sonar.yml"
SELECTED_STEP = "Did the plan select the coverage job on this push?"
COVERAGE_JOBS = {"pos": "pos/test", "admin-console": "admin/build-test",
                 "backend-core": "bc/db-integration", "erpnext-connector": "connector/unit-tests-and-lint"}


class SonarConfigTests(unittest.TestCase):
    """Owner decision 2026-11-20 (RT-1471): with affected-only pushes, Sonar skips a product whose coverage
    job the plan did not select, instead of failing it. Triggers, secrets and the wait job are unchanged."""

    def setUp(self):
        self.wf = yaml.safe_load(SONAR.read_text(encoding="utf-8"))
        self.scan = self.wf["jobs"]["scan"]

    def test_triggers_and_jobs_are_unchanged(self):
        on = self.wf.get("on", self.wf.get(True))
        self.assertEqual(sorted(on), ["push", "workflow_dispatch"])
        self.assertEqual(sorted(self.wf["jobs"]), ["scan", "wait"])

    def test_each_product_names_the_job_that_uploads_its_coverage(self):
        got = {e["product"]: e["coverage_job"] for e in self.scan["strategy"]["matrix"]["include"]}
        self.assertEqual(got, COVERAGE_JOBS)

    def test_every_step_after_the_decision_runs_only_when_it_says_scan(self):
        names = [s.get("name") for s in self.scan["steps"]]
        after = self.scan["steps"][names.index(SELECTED_STEP) + 1:]
        self.assertTrue(after)
        for step in after:
            with self.subTest(step=step.get("name")):
                self.assertEqual(step.get("if"), "steps.selected.outputs.scan == 'true'")

    def test_the_token_is_only_read_after_the_decision_by_the_scanner(self):
        names = [s.get("name") for s in self.scan["steps"]]
        cut = names.index(SELECTED_STEP)
        for step in self.scan["steps"][:cut]:
            if "secrets" in json.dumps(step):
                self.assertEqual(step["name"], "Check the project token secret exists")


@unittest.skipUnless(BASH, "bash is required")
class SonarSelectedStepTests(unittest.TestCase):
    """The decision step, run for real with a fake `gh` that prints the product run's jobs."""

    @classmethod
    def setUpClass(cls):
        scan = yaml.safe_load(SONAR.read_text(encoding="utf-8"))["jobs"]["scan"]
        cls.script = [s for s in scan["steps"] if s.get("name") == SELECTED_STEP][0]["run"]
        cls.tmp = tempfile.mkdtemp()
        fake = pathlib.Path(cls.tmp, "gh")
        fake.write_text('#!/bin/bash\n[ -n "${FAKE_GH_FAIL:-}" ] && exit 1\nprintf "%b" "$FAKE_JOBS"\n',
                        encoding="utf-8")
        fake.chmod(0o755)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _run(self, jobs, **extra):
        out = pathlib.Path(self.tmp, "out.txt")
        out.write_text("", encoding="utf-8")
        env = {"PATH": f"{self.tmp}{os.pathsep}{os.environ['PATH']}", "GITHUB_OUTPUT": str(out),
               "GH_TOKEN": "x", "REPO": "o/r", "RUN_ID": "1", "COVERAGE_JOB": "pos/test",
               "FAKE_JOBS": "".join(f"{n}\\t{c}\\n" for n, c in jobs)}
        env.update(extra)
        proc = subprocess.run([BASH, "-c", self.script], env=env, capture_output=True, text=True)
        return proc, out.read_text(encoding="utf-8")

    def test_a_job_the_plan_did_not_select_is_skipped_not_failed(self):
        proc, out = self._run([("plan", "success"), ("pos/static", "skipped"), ("pos/test", "skipped")])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(out.strip(), "scan=false")
        self.assertIn("::notice::", proc.stdout)

    def test_everything_else_still_scans_and_so_fails_on_a_missing_artifact(self):
        for label, jobs in (("selected and green", [("plan", "success"), ("pos/test", "success")]),
                            ("selected and red", [("plan", "success"), ("pos/test", "failure")]),
                            ("plan failed", [("plan", "failure"), ("pos/test", "skipped")]),
                            ("plan cancelled", [("plan", "cancelled"), ("pos/test", "skipped")]),
                            ("no plan job", [("pos/test", "skipped")]),
                            ("no coverage job", [("plan", "success")]),
                            ("two plan rows", [("plan", "success"), ("plan", "failure"), ("pos/test", "skipped")]),
                            ("cancelled job", [("plan", "success"), ("pos/test", "cancelled")]),
                            # a failed shard leaves pos/test skipped too: that is not "not selected"
                            ("failed shard", [("plan", "success"), ("pos/test-shard-2", "failure"),
                                              ("pos/test", "skipped")]),
                            ("cancelled shard", [("plan", "success"), ("pos/test-shard-1", "cancelled"),
                                                 ("pos/test", "skipped")]),
                            ("still running", [("plan", "success"), ("pos/static", "none"),
                                               ("pos/test", "skipped")])):
            with self.subTest(label):
                proc, out = self._run(jobs)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertEqual(out.strip(), "scan=true")

    def test_an_api_error_fails_the_job(self):
        proc, out = self._run([], FAKE_GH_FAIL="1")
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(out, "")


if __name__ == "__main__":
    unittest.main()
