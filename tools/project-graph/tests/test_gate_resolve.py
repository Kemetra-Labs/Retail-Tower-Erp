"""RT-888: the gate's "Resolve pull request (metadata only)" step, run for real.

A product workflow can complete after its head stopped being the live head of a PR: the PR
was merged or closed (run 40294944004 for merged PR #26, run 40286808845), or the PR was
pushed again. The step used to exit 5 ("head SHA is not unique to one open PR") and turn
the gate run red. Such a late `workflow_run` is now "not applicable": the step succeeds
with resolution=not_applicable and no head_sha, every later step is skipped and `post`
publishes no `required` at all. Every other unresolved shape still fails closed.

These tests execute the committed `run:` script of the `pr` step with bash, the way
GitHub runs it, against a stubbed `gh` that serves the `commits/<sha>/pulls` payload
(jq is the runner's own). They then evaluate `post`'s `if:` on the resulting outputs."""

import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
GATE = REPO_ROOT / ".github" / "workflows" / "gate.yml"
REPO = "Kemetra-Labs/Retail-Tower-Erp"

SHA = "a" * 40       # the head SHA the event is about
NEWER = "b" * 40     # a newer head of the same PR
BASE = "c" * 40
MERGED_AT = "2026-10-26T08:51:36Z"

FAKE_GH = """\
#!{python}
import json, os, sys
with open(os.environ["FAKE_GH_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
if sys.argv[1:] != ["api", os.environ["FAKE_GH_EXPECT"]]:
    sys.stderr.write("fake gh: unexpected call\\n")
    sys.exit(99)
if os.environ.get("FAKE_GH_EXIT", "0") != "0":
    sys.stderr.write("gh: HTTP 502\\n")
    sys.exit(int(os.environ["FAKE_GH_EXIT"]))
with open(os.environ["FAKE_GH_BODY"], encoding="utf-8") as body:
    sys.stdout.write(body.read())
"""


def pr(number, state, head, base_ref="main", merged=False):
    return {"number": number, "state": state, "head": {"sha": head},
            "base": {"ref": base_ref, "sha": BASE}, "merged_at": MERGED_AT if merged else None}


def _workflow():
    return yaml.safe_load(GATE.read_text(encoding="utf-8"))


def _evaluate_steps():
    return _workflow()["jobs"]["evaluate"]["steps"]


def _pr_step():
    steps = [s for s in _evaluate_steps() if s.get("id") == "pr"]
    assert len(steps) == 1
    return steps[0]


def _can_run():
    return os.name == "posix" and shutil.which("bash") and shutil.which("jq")


class Result:
    def __init__(self, proc, outputs, summary, gh_calls):
        self.code = proc.returncode
        self.stdout = proc.stdout
        self.stderr = proc.stderr
        self.outputs = outputs
        self.summary = summary
        self.gh_calls = gh_calls


def run_step(event, pulls=None, *, sha=SHA, pr_number="", raw=None, gh_exit=0):
    """Run the committed `pr` step script; return its exit code, outputs and diagnostics."""
    step = _pr_step()
    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        bindir = tmp / "bin"
        bindir.mkdir()
        gh = bindir / "gh"
        gh.write_text(FAKE_GH.format(python=sys.executable), encoding="utf-8")
        gh.chmod(0o755)
        body = tmp / "pulls.json"
        body.write_text(raw if raw is not None else json.dumps(pulls if pulls is not None else []),
                        encoding="utf-8")
        script = tmp / "step.sh"
        script.write_text(step["run"], encoding="utf-8")
        out, summary, log = tmp / "out", tmp / "summary", tmp / "gh.log"
        for f in (out, summary, log):
            f.write_text("", encoding="utf-8")
        env = {
            "PATH": f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}",
            "GITHUB_OUTPUT": str(out), "GITHUB_STEP_SUMMARY": str(summary),
            "FAKE_GH_BODY": str(body), "FAKE_GH_LOG": str(log), "FAKE_GH_EXIT": str(gh_exit),
            "FAKE_GH_EXPECT": f"repos/{REPO}/commits/{sha}/pulls",
            # The step's own env block, with the event values the expressions would yield.
            "GH_TOKEN": "fake-token", "REPO": REPO, "EVENT": event,
            "PR_NUMBER": str(pr_number) if event == "pull_request_target" else "",
            "PR_HEAD_SHA": sha if event == "pull_request_target" else "",
            "RUN_HEAD_SHA": sha if event == "workflow_run" else "",
        }
        assert set(step["env"]) <= set(env), "the step reads an env var this harness does not set"
        # GitHub's `shell: bash` default on Linux.
        proc = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", str(script)],
                              env=env, capture_output=True, text=True, timeout=60)
        outputs = dict(line.split("=", 1) for line in out.read_text(encoding="utf-8").splitlines() if line)
        calls = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line]
        return Result(proc, outputs, summary.read_text(encoding="utf-8"), calls)


def post_runs(evaluate_outputs, cancelled=False):
    """Evaluate `post`'s `if:` for the given evaluate outputs. Accepts only the term shapes
    it knows, so a reworded condition fails here instead of being misread."""
    cond = str(_workflow()["jobs"]["post"]["if"]).strip()
    m = re.fullmatch(r"\$\{\{(.*)\}\}", cond, re.S)
    cond = m.group(1) if m else cond
    for term in (t.strip() for t in cond.split("&&")):
        if term == "!cancelled()":
            ok = not cancelled
        else:
            t = re.fullmatch(r"needs\.evaluate\.outputs\.(\w+)\s*(==|!=)\s*'([^']*)'", term)
            if not t:
                raise AssertionError(f"post condition term not understood: {term!r}")
            value = evaluate_outputs.get(t.group(1), "")
            ok = (value == t.group(3)) if t.group(2) == "==" else (value != t.group(3))
        if not ok:
            return False
    return True


def job_outputs(step_outputs):
    """evaluate's job outputs as GitHub derives them from the `pr` step's outputs."""
    mapped = {}
    for key, expr in _workflow()["jobs"]["evaluate"]["outputs"].items():
        m = re.fullmatch(r"\$\{\{\s*steps\.pr\.outputs\.(\w+)\s*\}\}", str(expr))
        if m:
            mapped[key] = step_outputs.get(m.group(1), "")
    return mapped


@unittest.skipUnless(_can_run(), "needs bash and jq (POSIX)")
class LateWorkflowRunNotApplicableTests(unittest.TestCase):
    """The false-red shapes: succeed, publish nothing, explain why."""

    def assert_not_applicable(self, r, reason, number):
        self.assertEqual(r.code, 0, r.stderr)
        self.assertEqual(r.outputs.get("resolution"), "not_applicable")
        self.assertEqual(r.outputs.get("not_applicable_reason"), reason)
        self.assertEqual(r.outputs.get("number"), str(number))
        self.assertNotIn("head_sha", r.outputs)
        self.assertNotIn("base_sha", r.outputs)
        self.assertIn("::notice title=gate not applicable::", r.stdout)
        self.assertIn(f"PR #{number}", r.stdout)
        self.assertIn(f"PR #{number}", r.summary)
        self.assertFalse(post_runs(job_outputs(r.outputs)), "post must not publish any `required`")

    def test_late_event_after_merged_pr(self):
        r = run_step("workflow_run", [pr(26, "closed", SHA, merged=True)])
        self.assert_not_applicable(r, "closed", 26)
        self.assertIn("already merged", r.stdout)

    def test_late_event_after_closed_unmerged_pr(self):
        r = run_step("workflow_run", [pr(27, "closed", SHA)])
        self.assert_not_applicable(r, "closed", 27)
        self.assertIn("already closed-unmerged", r.stdout)

    def test_closed_pr_on_main_wins_over_unrelated_closed_prs(self):
        r = run_step("workflow_run", [pr(5, "closed", NEWER), pr(26, "closed", SHA, merged=True)])
        self.assert_not_applicable(r, "closed", 26)

    def test_late_event_for_superseded_head_of_open_pr(self):
        r = run_step("workflow_run", [pr(30, "open", NEWER)])
        self.assert_not_applicable(r, "superseded", 30)
        self.assertIn(NEWER, r.stdout, "the notice names the PR's current head")
        self.assertIn(f"superseded head {SHA}", r.stdout)

    def test_superseded_ignores_closed_prs_alongside(self):
        r = run_step("workflow_run", [pr(30, "open", NEWER), pr(12, "closed", SHA, merged=True)])
        self.assert_not_applicable(r, "superseded", 30)


@unittest.skipUnless(_can_run(), "needs bash and jq (POSIX)")
class LivePullRequestResolvesTests(unittest.TestCase):
    """Unchanged: exactly one open PR with this head, on main, binds head and base SHA."""

    def assert_resolved(self, r, number):
        self.assertEqual(r.code, 0, r.stderr)
        self.assertEqual(r.outputs, {"resolution": "pr", "number": str(number),
                                     "head_sha": SHA, "base_sha": BASE})
        self.assertNotIn("not applicable", r.stdout)
        self.assertTrue(post_runs(job_outputs(r.outputs)))

    def test_workflow_run_for_active_pr(self):
        self.assert_resolved(run_step("workflow_run", [pr(30, "open", SHA)]), 30)

    def test_pull_request_target_for_active_pr(self):
        self.assert_resolved(run_step("pull_request_target", [pr(30, "open", SHA)], pr_number=30), 30)

    def test_open_pr_whose_head_equals_sha_resolves_normally_despite_closed_prs(self):
        r = run_step("workflow_run", [pr(12, "closed", SHA, merged=True), pr(30, "open", SHA)])
        self.assert_resolved(r, 30)

    def test_post_still_runs_when_evaluate_fails_after_resolving(self):
        # A crash after the `pr` step leaves no conclusion; post then posts `required` = failure.
        self.assertTrue(post_runs({"resolution": "pr", "head_sha": SHA}))
        self.assertFalse(post_runs({"resolution": "pr", "head_sha": SHA}, cancelled=True))
        self.assertFalse(post_runs({}), "a crash inside `pr` posts nothing (fail-closed: missing)")


@unittest.skipUnless(_can_run(), "needs bash and jq (POSIX)")
class StillFailsClosedTests(unittest.TestCase):
    """Anything that is neither a live PR nor an unambiguous late event fails with no outputs,
    so `post` is skipped and `required` stays missing (or keeps its last real verdict)."""

    def assert_fails(self, r):
        self.assertNotEqual(r.code, 0, r.stdout)
        self.assertEqual(r.outputs, {}, "a failed resolution must write no output")
        self.assertFalse(post_runs(job_outputs(r.outputs)))

    def test_zero_prs_workflow_run(self):
        self.assert_fails(run_step("workflow_run", []))

    def test_zero_prs_pull_request_target(self):
        self.assert_fails(run_step("pull_request_target", [], pr_number=30))

    def test_duplicate_open_prs_with_this_head(self):
        for event in ("workflow_run", "pull_request_target"):
            with self.subTest(event=event):
                self.assert_fails(run_step(event, [pr(30, "open", SHA), pr(31, "open", SHA)], pr_number=30))

    def test_two_open_prs_neither_at_this_head_is_ambiguous(self):
        self.assert_fails(run_step("workflow_run", [pr(30, "open", NEWER), pr(31, "open", "d" * 40)]))

    def test_suspicious_association_closed_pr_head_differs(self):
        self.assert_fails(run_step("workflow_run", [pr(26, "closed", NEWER, merged=True)]))

    def test_closed_pr_with_unexpected_base(self):
        self.assert_fails(run_step("workflow_run", [pr(26, "closed", SHA, base_ref="release", merged=True)]))

    def test_superseded_open_pr_with_unexpected_base(self):
        self.assert_fails(run_step("workflow_run", [pr(30, "open", NEWER, base_ref="release")]))

    def test_superseded_open_pr_with_malformed_head(self):
        for head in (None, "not-a-sha", NEWER.upper()):
            with self.subTest(head=head):
                self.assert_fails(run_step("workflow_run", [pr(30, "open", head)]))

    def test_live_pr_with_unexpected_base(self):
        for event in ("workflow_run", "pull_request_target"):
            with self.subTest(event=event):
                self.assert_fails(run_step(event, [pr(30, "open", SHA, base_ref="release")], pr_number=30))

    def test_pull_request_target_with_only_a_closed_pr(self):
        self.assert_fails(run_step("pull_request_target", [pr(26, "closed", SHA, merged=True)], pr_number=26))

    def test_pull_request_target_is_never_superseded(self):
        self.assert_fails(run_step("pull_request_target", [pr(30, "open", NEWER)], pr_number=30))

    def test_pull_request_target_number_mismatch(self):
        self.assert_fails(run_step("pull_request_target", [pr(30, "open", SHA)], pr_number=31))

    def test_unknown_events(self):
        for event in ("merge_group", "push", "pull_request", ""):
            with self.subTest(event=event):
                r = run_step(event, [pr(30, "open", SHA)])
                self.assert_fails(r)
                self.assertEqual(r.gh_calls, [], "an unknown event must fail before any API call")

    def test_malformed_sha(self):
        self.assert_fails(run_step("workflow_run", [pr(30, "open", "A" * 40)], sha="A" * 40))

    def test_api_error(self):
        self.assert_fails(run_step("workflow_run", [pr(26, "closed", SHA, merged=True)], gh_exit=1))

    def test_api_error_object_instead_of_list(self):
        self.assert_fails(run_step("workflow_run", raw='{"message": "Not Found"}'))

    def test_invalid_json(self):
        self.assert_fails(run_step("workflow_run", raw="[{"))

    def test_malformed_pr_number(self):
        bad = pr(26, "closed", SHA, merged=True)
        bad["number"] = "26; echo pwned"
        self.assert_fails(run_step("workflow_run", [bad]))


class GateNotApplicableWiringTests(unittest.TestCase):
    """Structure that the behaviour above relies on (no bash or jq needed)."""

    def test_every_step_after_pr_requires_a_resolved_pr(self):
        steps = _evaluate_steps()
        idx = next(i for i, s in enumerate(steps) if s.get("id") == "pr")
        self.assertEqual(idx, 0, "the PR is resolved before anything is checked out")
        for step in steps[idx + 1:]:
            with self.subTest(step=step.get("name") or step.get("uses")):
                self.assertRegex(str(step.get("if", "")),
                                 r"^\$\{\{\s*steps\.pr\.outputs\.resolution == 'pr'\s*\}\}$")

    def test_post_excludes_not_applicable(self):
        cond = str(_workflow()["jobs"]["post"]["if"])
        self.assertIn("needs.evaluate.outputs.resolution == 'pr'", cond)
        self.assertFalse(post_runs({"resolution": "not_applicable", "number": "26"}))
        # Even a stray head_sha cannot make a not-applicable run post.
        self.assertFalse(post_runs({"resolution": "not_applicable", "head_sha": SHA}))

    def test_evaluate_exposes_resolution(self):
        self.assertEqual(str(_workflow()["jobs"]["evaluate"]["outputs"]["resolution"]).replace(" ", ""),
                         "${{steps.pr.outputs.resolution}}")

    def test_pr_step_takes_event_values_from_env_only(self):
        run = _pr_step()["run"]
        self.assertNotIn("${{", run, "event values must reach the shell via env vars")

    def test_not_applicable_is_workflow_run_only(self):
        run = _pr_step()["run"]
        late = run.index('if [ "$EVENT" = "workflow_run" ]; then')
        self.assertLess(late, run.index("resolution=not_applicable"))


if __name__ == "__main__":
    unittest.main()
