"""RT-1471 Phase 2 (POS and POS Pilot): the release CI guard wiring of release-pos.yml and release-pos-pilot.yml.

The guard logic itself is specified in ci-check-gate.test.cjs. This file checks the workflows around it:
the guard job is read-only and dispatches nothing, signing, manifest and publish wait for it, publish proves the
SHA again after the environment approval, and the shell steps work end to end (bash, jq and node) against
realistic GitHub API payloads. Runs in `python -m unittest discover -s .github/release`.
"""

import itertools
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_console_lab_workflow import BASH, HAVE_BASH, ROOT, WORKFLOWS, job, read, step_script  # noqa: E402
from test_pos_release_workflow import git, job_if, needs_of, step  # noqa: E402

GATE = ROOT / ".github" / "release" / "ci-check-gate.cjs"
SHA = "a" * 40
REPO = "o/r"
POS_WORKFLOW = ".github/workflows/pos.yml"
REQUIRED = [{"name": name, "workflow": POS_WORKFLOW}
            for name in ("pos/static", "pos/test", "pos/package-windows", "pos/e2e-electron")]
WORKFLOW_FILES = ("release-pos.yml", "release-pos-pilot.yml")
READ_STEP = "Read the check runs and workflow runs of the release SHA"
GATE_STEP = "Release CI guard"
RECHECK_STEP = "Re-check the release CI guard before publishing"

# Stands in for `gh api [--paginate] <path> --jq EXPR`: answers the two read endpoints from fixtures in
# $FAKE_GH_DATA (the raw GitHub shapes, so the workflow's jq projection is exercised) and refuses anything else.
FAKE_GH = """#!/usr/bin/env bash
set -euo pipefail
[ "$1" = api ] || exit 2
shift
[ "${1:-}" = --paginate ] && shift
path="$1"; shift
[ "$1" = --jq ] || exit 2
expr="$2"
case "$path" in
  "repos/$REPO/commits/$SHA/check-runs?per_page=100&filter=all") file="$FAKE_GH_DATA/check-runs.json" ;;
  "repos/$REPO/actions/runs?head_sha=$SHA&per_page=100") file="$FAKE_GH_DATA/runs.json" ;;
  "repos/$REPO/actions/runs/"*"/jobs?per_page=100&filter=all")
    id="${path#"repos/$REPO/actions/runs/"}"; id="${id%%/*}"; file="$FAKE_GH_DATA/jobs-$id.json" ;;
  *) echo "fake gh: unexpected request $path" >&2; exit 2 ;;
esac
[ -f "$file" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
jq -c "$expr" "$file"
"""


def required_checks(text: str) -> list[list[dict]]:
    return [json.loads(m) for m in re.findall(r"REQUIRED_CHECKS: '(\[.*\])'", text)]


def step_block(text: str, name: str) -> str:
    return step(text, name)


JOB_IDS = itertools.count(7000)


def check_run(name: str, run_id: int, **over) -> dict:
    job_id = next(JOB_IDS)
    run = {"id": job_id, "name": name, "status": "completed", "conclusion": "success", "app": {"slug": "github-actions"},
           "started_at": "2026-11-20T10:00:00Z", "head_sha": SHA,
           "details_url": f"https://github.com/{REPO}/actions/runs/{run_id}/job/{job_id}"}
    run.update(over)
    return run


def job_for(check: dict) -> dict:
    """The Actions job GitHub reports for a check run (`GET actions/runs/<id>/jobs`)."""
    match = re.search(r"/actions/runs/(\d+)/job/(\d+)", check.get("details_url", ""))
    return {"id": int(match.group(2)) if match else check["id"], "run_id": int(match.group(1)) if match else None,
            "name": check["name"], "status": check["status"], "conclusion": check["conclusion"],
            "head_sha": check.get("head_sha"), "check_run_url": f"https://api.github.com/repos/{REPO}/check-runs/{check['id']}"}


def workflow_run(run_id: int, **over) -> dict:
    run = {"id": run_id, "path": POS_WORKFLOW, "event": "push", "head_branch": "main", "head_sha": SHA,
           "repository": {"full_name": REPO}, "head_repository": {"full_name": REPO}}
    run.update(over)
    return run


def per_workflow(fn):
    """Runs the test once for each release workflow, naming it in a failure."""

    def wrapper(self):
        for name, text in self.texts.items():
            with self.subTest(workflow=name):
                fn(self, text)

    wrapper.__name__ = fn.__name__
    return wrapper


class ReleaseCiGuardWiring(unittest.TestCase):
    texts = {name: read(WORKFLOWS / name) for name in WORKFLOW_FILES}

    @per_workflow
    def test_the_guard_job_is_read_only_secret_free_and_environment_free(self, text):
        guard = job(text, "guard")
        self.assertEqual(needs_of(guard), ["resolve"])
        block = re.search(r"^    permissions:\n((?:      .*\n)+)", guard, re.M)
        self.assertIsNotNone(block)
        self.assertEqual([re.sub(r"\s+#.*$", "", line.strip()) for line in block.group(1).splitlines()],
                         ["contents: read", "checks: read", "actions: read"])
        self.assertNotIn(": write", guard)
        self.assertNotIn("environment:", guard)
        self.assertNotIn("secrets.", guard)
        self.assertIn("persist-credentials: false", guard)

    @per_workflow
    def test_no_workflow_is_dispatched_and_no_job_may_write_actions(self, text):
        for forbidden in (r"gh workflow run", r"/dispatches", r"actions: write", r"--method\s+POST", r"-X\s+POST",
                          r"workflow_dispatch\s*\(", r"gh run rerun"):
            self.assertNotRegex(text, forbidden)

    @per_workflow
    def test_required_checks_are_the_four_pos_ci_jobs_from_the_pos_workflow(self, text):
        found = required_checks(text)
        self.assertEqual(len(found), 2, "the guard job and the publish re-check")
        for required in found:
            self.assertEqual(required, REQUIRED)

    @per_workflow
    def test_the_guard_reads_both_check_runs_and_workflow_runs_of_the_exact_sha(self, text):
        script = step_script(job(text, "guard"), READ_STEP)
        # filter=all: the default (latest) can hide a queued re-run attempt behind an older completed one.
        self.assertIn('commits/$SHA/check-runs?per_page=100&filter=all', script)
        self.assertIn('actions/runs?head_sha=$SHA&per_page=100', script)
        self.assertIn('actions/runs/$id/jobs?per_page=100&filter=all', script)
        self.assertEqual(script.count("--paginate"), 3)
        self.assertIn("details_url", script)
        self.assertIn("check_run_url", script)
        self.assertIn("set -euo pipefail", script)
        self.assertRegex(job(text, "guard"), r"SHA: \$\{\{ needs\.resolve\.outputs\.sha \}\}")

    @per_workflow
    def test_the_gate_gets_the_exact_sha_and_repository(self, text):
        guard = step_script(job(text, "guard"), GATE_STEP)
        publish = step_script(job(text, "publish"), RECHECK_STEP)
        for script in (guard, publish):
            self.assertIn(".github/release/ci-check-gate.cjs", script)
            for flag in ('--checks "$RUNNER_TEMP/check-runs.json"', '--runs "$RUNNER_TEMP/workflow-runs.json"',
                         '--jobs "$RUNNER_TEMP/jobs.json"', '--required "$REQUIRED_CHECKS"', '--sha "$SHA"',
                         '--repo "$REPO"'):
                self.assertIn(flag, script)

    @per_workflow
    def test_signing_manifest_and_publish_wait_for_the_guard(self, text):
        # The Windows build and the ephemeral dry-run signing stay independent of it (a dry run still proves the
        # build); everything that signs for real, records or publishes needs a green guard.
        self.assertEqual(needs_of(job(text, "build")), ["resolve"])
        self.assertEqual(needs_of(job(text, "sign-dry-run")), ["resolve", "build"])
        self.assertEqual(sorted(needs_of(job(text, "sign-release"))), ["build", "guard", "resolve"])
        self.assertEqual(sorted(needs_of(job(text, "manifest"))), ["build", "guard", "resolve", "sign-dry-run", "sign-release"])
        self.assertEqual(sorted(needs_of(job(text, "publish"))), ["guard", "manifest", "resolve", "sign-release"])
        for name in ("manifest", "publish"):
            condition = " ".join(job_if(job(text, name)).split())
            self.assertTrue(condition.startswith("!cancelled() && "), name)
            self.assertIn("needs.guard.result == 'success'", condition, name)
            self.assertNotIn("always()", condition, name)

    @per_workflow
    def test_publish_proves_the_sha_again_after_the_approval_and_before_anything_irreversible(self, text):
        publish = job(text, "publish")
        names = re.findall(r"^      - name: (.+)$", publish, re.M)
        position = {n.split(" (")[0]: i for i, n in enumerate(names)}
        recheck = position[RECHECK_STEP]
        protect = next(i for n, i in position.items() if n.startswith("Refuse unless the release environment"))
        self.assertLess(protect, recheck, "after the environment protection check")
        for later in ("Attest build provenance", "Create the GitHub release"):
            self.assertLess(recheck, position[later], later)
        for download in (n for n in names if n.startswith("Download")):
            self.assertLess(recheck, names.index(download), download)
        self.assertRegex(publish, r"checks: read")
        self.assertRegex(publish, r"actions: read")
        script = step_script(publish, RECHECK_STEP)
        # An empty environment: the privileged job's OIDC and token variables never reach the script.
        self.assertIn('env -i PATH="$PATH" node .github/release/ci-check-gate.cjs', script)
        self.assertNotIn("GH_TOKEN", step_block(publish, RECHECK_STEP).split("run: |")[0].replace("GH_TOKEN: ${{ github.token }}", ""))

    @per_workflow
    def test_publish_runs_only_the_one_guard_file_from_the_repository(self, text):
        publish = job(text, "publish")
        checkouts = re.findall(r"^      - name: .*\n        uses: actions/checkout@.*\n(?:        .*\n)+", publish, re.M)
        self.assertEqual(len(checkouts), 1)
        self.assertIn("persist-credentials: false", checkouts[0])
        self.assertIn("sparse-checkout-cone-mode: false", checkouts[0])
        self.assertRegex(checkouts[0], r"sparse-checkout: \|\n\s+/\.github/release/ci-check-gate\.cjs\n")
        self.assertEqual(re.findall(r"^\s+/\S+$", checkouts[0], re.M), ["            /.github/release/ci-check-gate.cjs"])
        self.assertNotIn("setup-node", publish)

    @per_workflow
    def test_the_guard_checkout_covers_every_file_its_steps_read(self, text):
        guard = job(text, "guard")
        patterns = re.findall(r"^\s+(/\S+)$", re.search(r"sparse-checkout: \|\n((?:\s+/\S+\n)+)", guard).group(1), re.M)
        # Non-cone mode includes no root file on its own: setup-node reads .nvmrc, the gate is the script.
        self.assertEqual(patterns, ["/.github/release/ci-check-gate.cjs", "/.nvmrc"])
        self.assertIn("node-version-file: .nvmrc", guard)
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            files = [".github/release/ci-check-gate.cjs", ".github/release/manifest.py", ".nvmrc", "apps/pos/package.json"]
            for name in files:
                (repo / name).parent.mkdir(parents=True, exist_ok=True)
                (repo / name).write_text("x", encoding="utf-8")
            git(repo, "init", "-q")
            git(repo, "add", *files)
            git(repo, "commit", "-q", "-m", "x")
            git(repo, "sparse-checkout", "set", "--no-cone", *patterns)
            present = sorted(p.relative_to(repo).as_posix() for p in repo.rglob("*")
                             if p.is_file() and ".git" not in p.relative_to(repo).parts)
            self.assertEqual(present, [".github/release/ci-check-gate.cjs", ".nvmrc"])

    @per_workflow
    def test_the_guard_refuses_the_whole_release_not_only_the_publish(self, text):
        script = step_script(job(text, "guard"), GATE_STEP)
        self.assertIn('[ "$status" -eq 0 ] || {', script)
        self.assertIn("exit 1", script)


@unittest.skipUnless(HAVE_BASH and shutil.which("jq") and shutil.which("node"), "bash, jq and node are needed")
class ReleaseCiGuardSteps(unittest.TestCase):
    """The two shell steps of the guard job, run for real against fake `gh` answers."""

    texts = {name: read(WORKFLOWS / name) for name in WORKFLOW_FILES}

    def run_guard(self, text: str, checks: list, runs: list | None, *, sha: str = SHA, jobs: list | None = None):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "bin").mkdir()
            gh = base / "bin" / "gh"
            gh.write_text(FAKE_GH, encoding="utf-8", newline="\n")
            gh.chmod(0o755)
            data = base / "data"
            data.mkdir()
            if checks is not None:
                (data / "check-runs.json").write_text(json.dumps({"total_count": len(checks), "check_runs": checks}), encoding="utf-8")
            if runs is not None:
                (data / "runs.json").write_text(json.dumps({"total_count": len(runs), "workflow_runs": runs}), encoding="utf-8")
                all_jobs = jobs if jobs is not None else [job_for(c) for c in (checks or [])]
                for r in runs:
                    mine = [j for j in all_jobs if j["run_id"] == r["id"]]
                    (data / f"jobs-{r['id']}.json").write_text(json.dumps({"total_count": len(mine), "jobs": mine}), encoding="utf-8")
            work = base / "work"
            (work / ".github" / "release").mkdir(parents=True)
            shutil.copy(GATE, work / ".github" / "release" / "ci-check-gate.cjs")
            runner = base / "runner"
            runner.mkdir()
            output = base / "out.txt"
            summary = base / "summary.md"
            env = {"PATH": f"{base / 'bin'}{os.pathsep}{os.environ.get('PATH', '')}", "REPO": REPO, "SHA": sha,
                   "GH_TOKEN": "x", "FAKE_GH_DATA": data.as_posix(), "RUNNER_TEMP": runner.as_posix(),
                   "GITHUB_OUTPUT": output.as_posix(), "GITHUB_STEP_SUMMARY": summary.as_posix(),
                   "GITHUB_SHA": sha}
            guard = job(text, "guard")
            read_step = step_script(guard, READ_STEP)
            env["REQUIRED_CHECKS"] = json.dumps(REQUIRED)  # the job-level env of the workflow
            first = subprocess.run([BASH, "-c", read_step], capture_output=True, text=True, check=False, env=env, cwd=work)
            if first.returncode != 0:
                return first, None
            gate_script = step_script(guard, GATE_STEP)
            gate_env = dict(env)
            second = subprocess.run([BASH, "-c", gate_script], capture_output=True, text=True, check=False, env=gate_env, cwd=work)
            verdict = output.read_text(encoding="utf-8") if output.exists() else ""
            return first, (second, verdict)

    def green(self):
        return [check_run(r["name"], 100) for r in REQUIRED], [workflow_run(100)]

    def test_every_required_check_green_from_a_push_run_passes(self):
        for name, text in self.texts.items():
            with self.subTest(workflow=name):
                checks, runs = self.green()
                first, second = self.run_guard(text, checks, runs)
                self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
                result, verdict = second
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("verdict=PASS", verdict)

    def test_the_guard_step_refuses_each_negative_case(self):
        cases = {}
        checks, runs = self.green()
        cases["missing pos/test"] = ([c for c in checks if c["name"] != "pos/test"], runs, "pos/test")
        cases["failed pos/static"] = ([{**c, "conclusion": "failure"} if c["name"] == "pos/static" else c for c in checks], runs, "pos/static")
        cases["cancelled"] = ([{**c, "conclusion": "cancelled"} if c["name"] == "pos/test" else c for c in checks], runs, "pos/test")
        cases["skipped"] = ([{**c, "conclusion": "skipped"} if c["name"] == "pos/package-windows" else c for c in checks], runs, "pos/package-windows")
        cases["pending"] = ([{**c, "status": "in_progress", "conclusion": None} if c["name"] == "pos/e2e-electron" else c for c in checks], runs, "pos/e2e-electron")
        cases["wrong-SHA check"] = ([{**c, "head_sha": "b" * 40} if c["name"] == "pos/static" else c for c in checks], runs, "pos/static")
        cases["untrusted app"] = ([{**c, "app": {"slug": "circleci-checks"}} if c["name"] == "pos/static" else c for c in checks], runs, "pos/static")
        cases["pull_request run"] = (checks, [workflow_run(100, event="pull_request", head_branch="feature")], "event")
        cases["other workflow"] = (checks, [workflow_run(100, path=".github/workflows/evil.yml")], "workflow")
        cases["run on another branch"] = (checks, [workflow_run(100, head_branch="claude/x")], "branch")
        cases["fork run"] = (checks, [workflow_run(100, head_repository={"full_name": "attacker/r"})], "repository")
        cases["run not listed"] = (checks, [], "run 100")
        real_test = next(c for c in checks if c["name"] == "pos/test")
        forged = check_run("pos/test", 100, started_at="2026-11-20T11:00:00Z")
        forged["details_url"] = real_test["details_url"]  # a forged check run pointing at a real, trusted job
        cases["forged check run"] = ([*checks, forged], runs, "its id", [job_for(c) for c in checks])
        edited = next(c for c in checks if c["name"] == "pos/static")
        cases["job did not succeed"] = (checks, runs, "pos/static", [{**job_for(c), "conclusion": "failure"} if c is edited else job_for(c) for c in checks])
        cases["job missing"] = (checks, runs, "job", [job_for(c) for c in checks if c is not edited])
        for name, text in self.texts.items():
            for label, case in cases.items():
                case_checks, case_runs, expect, *rest = case
                with self.subTest(workflow=name, case=label):
                    first, second = self.run_guard(text, case_checks, case_runs, jobs=rest[0] if rest else None)
                    self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
                    result, verdict = second
                    self.assertNotEqual(result.returncode, 0, "the guard accepted a bad case")
                    self.assertIn("verdict=REFUSED", verdict)
                    self.assertIn(expect, result.stdout + result.stderr)

    def test_the_publish_recheck_step_passes_and_refuses_for_real(self):
        for name, text in self.texts.items():
            publish = job(text, "publish")
            script = step_script(publish, RECHECK_STEP)
            for label, bad in (("green", False), ("a failed check", True)):
                with self.subTest(workflow=name, case=label), tempfile.TemporaryDirectory() as tmp:
                    base = Path(tmp)
                    (base / "bin").mkdir()
                    gh = base / "bin" / "gh"
                    gh.write_text(FAKE_GH, encoding="utf-8", newline="\n")
                    gh.chmod(0o755)
                    data = base / "data"
                    data.mkdir()
                    checks = [check_run(r["name"], 100, **({"conclusion": "failure"} if bad and r["name"] == "pos/test" else {})) for r in REQUIRED]
                    (data / "check-runs.json").write_text(json.dumps({"check_runs": checks}), encoding="utf-8")
                    (data / "runs.json").write_text(json.dumps({"workflow_runs": [workflow_run(100)]}), encoding="utf-8")
                    (data / "jobs-100.json").write_text(json.dumps({"jobs": [job_for(c) for c in checks]}), encoding="utf-8")
                    work = base / "work"
                    (work / ".github" / "release").mkdir(parents=True)
                    shutil.copy(GATE, work / ".github" / "release" / "ci-check-gate.cjs")
                    runner = base / "runner"
                    runner.mkdir()
                    env = {"PATH": f"{base / 'bin'}{os.pathsep}{os.environ.get('PATH', '')}", "REPO": REPO, "SHA": SHA,
                           "GH_TOKEN": "x", "FAKE_GH_DATA": data.as_posix(), "RUNNER_TEMP": runner.as_posix(),
                           "REQUIRED_CHECKS": json.dumps(REQUIRED)}
                    result = subprocess.run([BASH, "-c", script], capture_output=True, text=True, check=False, env=env, cwd=work)
                    if bad:
                        self.assertNotEqual(result.returncode, 0, "the publish re-check accepted a failed check")
                        self.assertIn("pos/test", result.stdout + result.stderr)
                    else:
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        self.assertIn("PASS", result.stdout)

    def test_a_missing_check_prints_the_manual_proof_and_runs_nothing(self):
        checks, runs = self.green()
        for name, text in self.texts.items():
            with self.subTest(workflow=name):
                _, second = self.run_guard(text, [], runs)
                result, _ = second
                self.assertIn(f"gh workflow run pos.yml --ref main -f expected_sha={SHA}", result.stdout)
                self.assertIn("dispatches nothing", result.stdout)

    def test_an_api_failure_refuses_the_release(self):
        checks, runs = self.green()
        for name, text in self.texts.items():
            with self.subTest(workflow=name):
                first, second = self.run_guard(text, checks, None)  # the workflow-run list answers 404
                self.assertNotEqual(first.returncode, 0)
                self.assertIsNone(second)
                first, second = self.run_guard(text, None, runs)  # the check-run list answers 404
                self.assertNotEqual(first.returncode, 0)

    def test_an_empty_answer_is_a_refusal_not_a_pass(self):
        for name, text in self.texts.items():
            with self.subTest(workflow=name):
                first, second = self.run_guard(text, [], [])
                self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
                self.assertNotEqual(second[0].returncode, 0)

    def test_a_bad_release_sha_is_refused_before_anything_is_trusted(self):
        checks, runs = self.green()
        for name, text in self.texts.items():
            with self.subTest(workflow=name):
                first, second = self.run_guard(text, checks, runs, sha="ABC")
                # The request for a malformed SHA finds nothing (the read step fails), or the gate refuses it.
                self.assertTrue(first.returncode != 0 or second[0].returncode != 0)


if __name__ == "__main__":
    unittest.main()
