"""RT-1471 Phase 1: the nightly full CI and its manual twin.

Offline only. Parses the six root CI workflows and the shared plan action, and runs two of their
shell steps (the commit resolution of `.github/actions/pgraph-plan` and the oasdiff base resolution of
backend-core) in throwaway git repositories. No workflow is dispatched and nothing leaves the machine.

What is proved here, and what is not: the configuration (schedule, dispatch pin, FULL selection, coverage
upload conditions, fail-closed shell paths). That GitHub actually fires the schedule is proved only by the
first scheduled run, which the issue records separately."""

import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

import support
from pgraph import evaluate as ev
from pgraph.graph import load_graph

REPO_ROOT = support.PG_ROOT.parents[1]
WORKFLOWS = REPO_ROOT / ".github/workflows"
ACTION = REPO_ROOT / ".github/actions/pgraph-plan/action.yml"
BASH = shutil.which("bash")
GIT = shutil.which("git")
JQ = shutil.which("jq")
FULL_EVENTS = ("schedule", "workflow_dispatch")   # RT-1471 Phase 3: push is affected-only (test_affected_push)
GRAPH = load_graph(support.trusted_text())
# every workflow that defines a plan-guarded (non-always) graph job is a product workflow
NIGHTLY = sorted({path for key, path in GRAPH["jobs"].items() if key not in GRAPH["always_jobs"]})


def _load(path):
    return yaml.safe_load(pathlib.Path(path).read_text(encoding="utf-8"))


def _on(wf):
    on = wf.get("on", wf.get(True))      # PyYAML reads the key `on` as boolean True
    return on if isinstance(on, dict) else {}


def _step(job, name):
    found = [s for s in job["steps"] if s.get("name") == name]
    assert len(found) == 1, (name, len(found))
    return found[0]


def _eval_if(expr, event):
    """Evaluate the narrow `if:` expressions these steps use (no job outputs other than mode == github)."""
    py = (expr.replace("&&", " and ").replace("||", " or ").replace("!cancelled()", "True")
          .replace("steps.mode.outputs.mode", "'github'").replace("github.event_name", repr(event)))
    if re.search(r"[^\w\s'=!()]", py.replace("and", "").replace("or", "")):
        raise AssertionError(f"unsupported expression: {expr}")
    return bool(eval(py, {"__builtins__": {}}, {}))   # noqa: S307 - own constant strings, no input


def _minute_of_day(cron):
    minute, hour, dom, month, dow = cron.split()
    if not (minute.isdigit() and hour.isdigit()):
        return None
    return int(hour) * 60 + int(minute)


class ScheduleConfigTests(unittest.TestCase):

    def setUp(self):
        self.wfs = {p: _load(REPO_ROOT / p) for p in NIGHTLY}

    def test_the_nightly_set_is_the_six_product_workflows(self):
        self.assertEqual(NIGHTLY, [
            ".github/workflows/admin-console.yml", ".github/workflows/backend-core.yml",
            ".github/workflows/contracts.yml", ".github/workflows/e2e.yml",
            ".github/workflows/erpnext-connector.yml", ".github/workflows/pos.yml"])

    def test_each_has_one_daily_cron_and_keeps_its_pr_and_push_triggers(self):
        for path, wf in self.wfs.items():
            on = _on(wf)
            with self.subTest(path):
                self.assertEqual(sorted(on), ["pull_request", "push", "schedule", "workflow_dispatch"])
                self.assertEqual(on["pull_request"], {"branches": ["main"]})
                self.assertEqual(on["push"], {"branches": ["main"]})
                crons = [e["cron"] for e in on["schedule"]]
                self.assertEqual(len(crons), 1)
                minute, hour, dom, month, dow = crons[0].split()
                self.assertEqual((dom, month, dow), ("*", "*", "*"), "daily")
                self.assertTrue(minute.isdigit() and hour.isdigit(), crons[0])
                self.assertNotIn(int(minute), (0, 30), "GitHub delays runs at the top of the hour and half hour")

    def test_crons_are_distinct_and_one_window_so_all_six_run_the_same_commit(self):
        times = []
        for wf in self.wfs.values():
            times.append(_minute_of_day(_on(wf)["schedule"][0]["cron"]))
        self.assertEqual(len(set(times)), len(times), "distinct minutes")
        self.assertLessEqual(max(times) - min(times), 15, "one 15-minute window")

    def test_no_clash_with_any_other_schedule(self):
        ours = [_minute_of_day(_on(wf)["schedule"][0]["cron"]) for wf in self.wfs.values()]
        others = []
        for path in sorted(WORKFLOWS.glob("*.yml")):
            rel = f".github/workflows/{path.name}"
            if rel in NIGHTLY:
                continue
            for entry in _on(_load(path)).get("schedule") or []:
                minute = _minute_of_day(entry["cron"])
                if minute is not None:
                    others.append((rel, entry["cron"], minute))
        self.assertTrue(others, "the other nightlies are still found")
        for rel, cron, minute in others:
            for mine in ours:
                gap = min((minute - mine) % 1440, (mine - minute) % 1440)
                with self.subTest(other=rel, cron=cron):
                    self.assertGreaterEqual(gap, 60, f"{rel} {cron} is within an hour of a nightly full run")

    def test_dispatch_requires_the_expected_sha_pin(self):
        for path, wf in self.wfs.items():
            with self.subTest(path):
                inputs = _on(wf)["workflow_dispatch"]["inputs"]
                self.assertEqual(list(inputs), ["expected_sha"])
                self.assertIs(inputs["expected_sha"]["required"], True)
                self.assertEqual(inputs["expected_sha"]["type"], "string")

    def test_permissions_stay_read_only(self):
        for path, wf in self.wfs.items():
            with self.subTest(path):
                self.assertEqual(wf["permissions"], {"contents": "read"})

    def test_a_nightly_or_manual_run_never_shares_a_concurrency_group_with_a_push(self):
        for path, wf in self.wfs.items():
            group = wf["concurrency"]["group"]
            with self.subTest(path):
                self.assertNotIn("== 'push'", group)
                self.assertIn("github.event_name != 'pull_request'", group)
                self.assertIn("github.event_name, github.sha", group)
                self.assertIs(wf["concurrency"]["cancel-in-progress"], True)

    def test_the_gate_still_ignores_runs_on_main(self):
        gate = _on(_load(WORKFLOWS / "gate.yml"))["workflow_run"]
        self.assertEqual(gate["branches-ignore"], ["main"])
        for path in NIGHTLY:
            name = _load(REPO_ROOT / path)["name"]
            self.assertIn(name, gate["workflows"])

    def test_every_plan_guarded_job_is_selected_and_none_is_unguarded(self):
        selected = set(GRAPH["jobs"]) - set(GRAPH["always_jobs"])
        for path, wf in self.wfs.items():
            defined = {j["name"]: j for j in wf["jobs"].values() if "name" in j}
            for key in (k for k, p in GRAPH["jobs"].items() if p == path and k in selected):
                with self.subTest(job=key):
                    self.assertIn(key, defined)
                    self.assertIn(f"'{key}'", defined[key].get("if", ""))


class FullSelectionTests(unittest.TestCase):

    def _plan(self, event, changes=()):
        case = {"event": event, "changes": list(changes)}
        return ev.evaluate(support.eval_input(case))

    def test_schedule_and_dispatch_select_every_graph_job(self):
        every = sorted(GRAPH["jobs"])
        for event in FULL_EVENTS:
            plan = self._plan(event)
            with self.subTest(event):
                self.assertTrue(plan["select_all"])
                self.assertEqual(plan["graph_validation"]["status"], "pass")
                self.assertEqual(sorted(plan["needed_jobs"]), every)
                self.assertIn("FULL_RUN_EVENT", plan["notes"])

    def test_a_pull_request_still_selects_by_its_diff(self):
        plan = self._plan("pull_request", [{"status": "M", "path": "apps/pos/docs/a.md"}])
        self.assertFalse(plan["select_all"])
        self.assertLess(len(plan["needed_jobs"]), len(GRAPH["jobs"]))

    def test_an_unknown_event_is_not_a_valid_plan(self):
        plan = self._plan("repository_dispatch")
        self.assertEqual(plan["graph_validation"]["status"], "fail")
        self.assertIn("UNKNOWN_EVENT", plan["graph_validation"]["reasons"])


def _git(cwd, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid")
    return subprocess.run([GIT, *args], cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout.strip()


@unittest.skipUnless(BASH and GIT, "bash and git are required")
class PlanActionRefsTests(unittest.TestCase):
    """The commit-resolution step of the shared plan action, run for real in a one-commit repository."""

    @classmethod
    def setUpClass(cls):
        action = _load(ACTION)
        step = [s for s in action["runs"]["steps"] if s.get("id") == "refs"][0]
        cls.script = step["run"]
        cls.repo = tempfile.mkdtemp()
        _git(cls.repo, "init", "-q", "-b", "main")
        pathlib.Path(cls.repo, "f").write_text("x", encoding="utf-8")
        _git(cls.repo, "add", "f")
        _git(cls.repo, "commit", "-q", "-m", "one")
        cls.sha = _git(cls.repo, "rev-parse", "HEAD")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.repo, ignore_errors=True)

    def _run(self, **env):
        out = pathlib.Path(self.repo, "out.txt")
        out.write_text("", encoding="utf-8")
        base = {"PATH": os.environ["PATH"], "GITHUB_OUTPUT": str(out), "PR_BASE": "", "PR_HEAD": "",
                "SHA": self.sha, "REF": "refs/heads/main", "EXPECTED_SHA": "", "EVENT": ""}
        base.update(env)
        proc = subprocess.run([BASH, "-c", self.script], cwd=self.repo, env=base, capture_output=True, text=True)
        return proc, out.read_text(encoding="utf-8")

    def test_schedule_on_main_is_a_full_run_of_the_tip(self):
        proc, out = self._run(EVENT="schedule")
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        self.assertIn(f"base={self.sha}", out)
        self.assertIn(f"head={self.sha}", out)

    def test_dispatch_on_main_with_the_matching_sha_is_a_full_run(self):
        proc, out = self._run(EVENT="workflow_dispatch", EXPECTED_SHA=self.sha)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        self.assertIn(f"head={self.sha}", out)

    def test_dispatch_fails_closed_without_a_matching_pin(self):
        other = "f" * 40
        for label, pin in (("missing", ""), ("short", self.sha[:12]), ("upper", self.sha.upper()),
                           ("moved main", other), ("junk", "main; rm -rf /")):
            with self.subTest(label):
                proc, out = self._run(EVENT="workflow_dispatch", EXPECTED_SHA=pin)
                self.assertNotEqual(proc.returncode, 0)
                self.assertEqual(out, "", "no outputs on failure")
                self.assertIn("::error::", proc.stdout)

    def test_schedule_and_dispatch_fail_closed_off_main(self):
        for event in ("schedule", "workflow_dispatch"):
            for ref in ("refs/heads/feature/x", "refs/tags/v1", "refs/pull/7/merge", ""):
                with self.subTest(event=event, ref=ref):
                    proc, out = self._run(EVENT=event, REF=ref, EXPECTED_SHA=self.sha)
                    self.assertNotEqual(proc.returncode, 0)
                    self.assertEqual(out, "")

    def test_push_and_pull_request_are_unchanged(self):
        # a one-commit repository has no parent, so a push falls back to FULL (base == head); the
        # first-parent cases are in test_affected_push
        proc, out = self._run(EVENT="push", REF="refs/heads/main")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(f"base={self.sha}", out)
        proc, out = self._run(EVENT="pull_request", PR_BASE=self.sha, PR_HEAD=self.sha, REF="refs/pull/7/merge")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(f"head={self.sha}", out)

    def test_any_other_event_is_still_unsupported(self):
        for event in ("repository_dispatch", "workflow_run", "merge_group", ""):
            with self.subTest(event):
                proc, out = self._run(EVENT=event)
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn("unsupported event", proc.stdout)


@unittest.skipUnless(BASH and GIT and JQ, "bash, git and jq are required")
class PlanActionEvaluateTests(unittest.TestCase):
    """The evaluate step of the shared plan action, run end to end for each full event on this repository's
    HEAD: every graph job must come out selected, and an invalid selection must fail the step."""

    @classmethod
    def setUpClass(cls):
        try:
            cls.head = _git(str(REPO_ROOT), "rev-parse", "HEAD")
        except (OSError, subprocess.CalledProcessError):
            raise unittest.SkipTest("not inside a git checkout")
        step = [s for s in _load(ACTION)["runs"]["steps"] if s.get("id") == "plan"][0]
        cls.script = step["run"]
        cls.tmp = tempfile.mkdtemp()
        archive = subprocess.run([GIT, "-C", str(REPO_ROOT), "archive", cls.head, "tools/project-graph"],
                                 check=True, capture_output=True).stdout
        base_dir = pathlib.Path(cls.tmp, "pgraph-base")
        base_dir.mkdir()
        subprocess.run(["tar", "-x", "-C", str(base_dir)], input=archive, check=True)
        pybin = pathlib.Path(cls.tmp, "bin")
        pybin.mkdir()
        (pybin / "python").symlink_to(sys.executable)
        cls.path = f"{pybin}{os.pathsep}{os.environ['PATH']}"

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _run(self, event):
        out, summary = pathlib.Path(self.tmp, "out.txt"), pathlib.Path(self.tmp, "summary.md")
        out.write_text("", encoding="utf-8")
        summary.write_text("", encoding="utf-8")
        env = {"PATH": self.path, "RUNNER_TEMP": self.tmp, "GITHUB_WORKSPACE": str(REPO_ROOT),
               "GITHUB_OUTPUT": str(out), "GITHUB_STEP_SUMMARY": str(summary),
               "EVENT": event, "BASE_SHA": self.head, "HEAD_SHA": self.head}
        proc = subprocess.run([BASH, "-c", self.script], cwd=self.tmp, env=env, capture_output=True, text=True)
        return proc, out.read_text(encoding="utf-8"), summary.read_text(encoding="utf-8")

    def test_a_push_the_action_could_not_prove_still_selects_every_graph_job(self):
        # RT-1471 Phase 3: base == head is the refs step's "not one first-parent commit" signal
        import json
        proc, out, summary = self._run("push")
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        jobs = json.loads(re.search(r"^jobs=(.*)$", out, re.M).group(1))
        self.assertEqual(sorted(jobs), sorted(GRAPH["jobs"]))

    def test_every_full_event_selects_every_graph_job(self):
        import json
        for event in FULL_EVENTS:
            with self.subTest(event):
                proc, out, summary = self._run(event)
                self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
                jobs = json.loads(re.search(r"^jobs=(.*)$", out, re.M).group(1))
                self.assertEqual(sorted(jobs), sorted(GRAPH["jobs"]))
                self.assertIn(f"event: `{event}`", summary)
                self.assertIn(f"sha: `{self.head}`", summary)

    def test_an_invalid_nightly_selection_fails_the_step(self):
        # the evaluator reports select_all with a failed validation for an event it does not know; the nightly
        # branch of the step must not accept that, even though `repository_dispatch` never reaches it in practice
        script = self.script.replace("schedule|workflow_dispatch)", "schedule|workflow_dispatch|repository_dispatch)")
        out, summary = pathlib.Path(self.tmp, "o2.txt"), pathlib.Path(self.tmp, "s2.md")
        out.write_text("", encoding="utf-8")
        summary.write_text("", encoding="utf-8")
        env = {"PATH": self.path, "RUNNER_TEMP": self.tmp, "GITHUB_WORKSPACE": str(REPO_ROOT),
               "GITHUB_OUTPUT": str(out), "GITHUB_STEP_SUMMARY": str(summary),
               "EVENT": "repository_dispatch", "BASE_SHA": self.head, "HEAD_SHA": self.head}
        proc = subprocess.run([BASH, "-c", script], cwd=self.tmp, env=env, capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not a valid full selection", proc.stdout)
        self.assertEqual(out.read_text(encoding="utf-8"), "", "no job list is published")


class CoverageUploadTests(unittest.TestCase):
    """The artifacts hand-over for the Sonar scan: kept for every non-PR run, never for a PR."""

    def _uploads(self):
        found = {}
        for name in ("pos", "admin-console", "backend-core", "erpnext-connector"):
            wf = _load(WORKFLOWS / f"{name}.yml")
            for job in wf["jobs"].values():
                for step in job.get("steps", []):
                    use = str(step.get("uses", ""))
                    artifact = (step.get("with") or {}).get("name", "")
                    if use.startswith("actions/upload-artifact@") and str(artifact).startswith("sonar-coverage-"):
                        found[artifact] = step
        return found

    def test_the_four_coverage_artifacts_are_uploaded_on_every_non_pr_event(self):
        found = self._uploads()
        self.assertEqual(sorted(found), ["sonar-coverage-admin-console", "sonar-coverage-backend-core",
                                         "sonar-coverage-erpnext-connector", "sonar-coverage-pos"])
        for artifact, step in found.items():
            for event, expected in (("pull_request", False), ("push", True), ("schedule", True),
                                    ("workflow_dispatch", True)):
                with self.subTest(artifact=artifact, event=event):
                    self.assertIs(_eval_if(step["if"], event), expected)
            # the upload stays a best-effort hand-over that cannot change a job's result
            self.assertIs(step["continue-on-error"], True)
            self.assertEqual(step["with"]["retention-days"], 3)

    def test_pos_source_scope_guard_runs_exactly_one_of_fetch_or_pin_for_every_event(self):
        wf = _load(WORKFLOWS / "pos.yml")
        for key in ("pos-test-shard-1", "pos-test-shard-2", "pos-test-shard-3"):
            job = wf["jobs"][key]
            fetch = _step(job, "Fetch main tip for the source-scope guard")["if"]
            pin = _step(job, "Pin origin/main to the pushed commit (source-scope guard sees an empty diff)")["if"]
            for event in ("pull_request", "push", "schedule", "workflow_dispatch"):
                with self.subTest(job=key, event=event):
                    self.assertNotEqual(_eval_if(fetch, event), _eval_if(pin, event))
                    self.assertIs(_eval_if(fetch, event), event == "pull_request")


@unittest.skipUnless(BASH and GIT, "bash and git are required")
class OasdiffBaseTests(unittest.TestCase):
    """backend-core `bc/oasdiff` base resolution: a nightly or manual run compares the tip with its first parent,
    and every path that cannot name a real base with contracts still fails."""

    @classmethod
    def setUpClass(cls):
        wf = _load(WORKFLOWS / "backend-core.yml")
        cls.script = _step(wf["jobs"]["bc-oasdiff"], "Resolve the comparison base")["run"]
        cls.repo = tempfile.mkdtemp()
        _git(cls.repo, "init", "-q", "-b", "main")
        cls.bc = pathlib.Path(cls.repo, "services/backend-core")
        spec = cls.bc / "packages/contracts/openapi"
        spec.mkdir(parents=True)
        (spec / "a.yaml").write_text("v: 1\n", encoding="utf-8")
        _git(cls.repo, "add", ".")
        _git(cls.repo, "commit", "-q", "-m", "root")
        cls.root = _git(cls.repo, "rev-parse", "HEAD")
        (spec / "a.yaml").write_text("v: 2\n", encoding="utf-8")
        _git(cls.repo, "commit", "-q", "-am", "tip")
        cls.tip = _git(cls.repo, "rev-parse", "HEAD")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.repo, ignore_errors=True)

    def _run(self, sha=None, **env):
        out = pathlib.Path(self.repo, "out.txt")
        out.write_text("", encoding="utf-8")
        base = {"PATH": os.environ["PATH"], "GITHUB_OUTPUT": str(out), "GITHUB_SHA": sha or self.tip,
                "BASE_REF": "", "BEFORE": "", "EVENT": ""}
        base.update(env)
        proc = subprocess.run([BASH, "-c", self.script], cwd=self.bc, env=base, capture_output=True, text=True)
        return proc, out.read_text(encoding="utf-8")

    def test_schedule_and_dispatch_compare_the_tip_with_its_first_parent(self):
        for event in ("schedule", "workflow_dispatch"):
            with self.subTest(event):
                proc, out = self._run(EVENT=event)
                self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
                self.assertEqual(out.strip(), f"base={self.root}")

    def test_a_run_on_a_commit_without_a_parent_fails_instead_of_comparing_nothing(self):
        proc, out = self._run(sha=self.root, EVENT="schedule")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("has no first parent", proc.stdout + proc.stderr)
        self.assertEqual(out, "")

    def test_push_is_unchanged_and_still_needs_a_usable_before(self):
        proc, out = self._run(EVENT="push", BEFORE=self.root)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        self.assertEqual(out.strip(), f"base={self.root}")
        for before in ("", "0" * 40):
            with self.subTest(before=before):
                proc, out = self._run(EVENT="push", BEFORE=before)
                self.assertNotEqual(proc.returncode, 0)
                self.assertEqual(out, "")

    def test_any_other_event_is_still_unsupported(self):
        proc, out = self._run(EVENT="repository_dispatch")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("unsupported event", proc.stdout + proc.stderr)


if __name__ == "__main__":
    unittest.main()
