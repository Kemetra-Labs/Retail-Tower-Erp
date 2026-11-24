"""RT-1471 Phase 2: the release CI guard wiring of release-pos.yml, release-pos-pilot.yml,
release-admin-console.yml and release-erpnext-connector.yml.

The guard logic itself is specified in ci-check-gate.test.cjs. This file checks the workflows around it:
the guard job is read-only and dispatches nothing, everything that signs, records or publishes waits for it,
publish proves the SHA again after the environment approval (where a release has a privileged publish step),
and the shell steps work end to end (bash, jq and node) against realistic GitHub API payloads.
Runs in `python -m unittest discover -s .github/release`.
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
from typing import NamedTuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_console_lab_workflow import BASH, HAVE_BASH, ROOT, WORKFLOWS, job, read, step_script  # noqa: E402
from test_pos_release_workflow import git, job_if, needs_of, step  # noqa: E402

GATE = ROOT / ".github" / "release" / "ci-check-gate.cjs"
GRAPH = ROOT / "tools" / "project-graph" / "graph.yaml"
SHA = "a" * 40
REPO = "o/r"
READ_STEP = "Read the check runs and workflow runs of the release SHA"
GATE_STEP = "Release CI guard"
RECHECK_STEP = "Re-check the release CI guard before publishing"


class Product(NamedTuple):
    file: str  # the release workflow
    ci_workflow: str  # the root CI workflow whose jobs are the mandatory checks
    checks: tuple  # the mandatory check names, from tools/project-graph/graph.yaml
    scope: str  # how the guard names them in its refusal
    shape: str  # which job graph the release workflow has: pos (signing), admin (publish) or connector (publish disabled)
    recheck: bool  # has a privileged publish step that must re-check after the environment approval


POS_CHECKS = ("pos/static", "pos/test", "pos/package-windows", "pos/e2e-electron")
PRODUCTS = {
    "release-pos.yml": Product("release-pos.yml", ".github/workflows/pos.yml", POS_CHECKS, "pos/*", "pos", True),
    "release-pos-pilot.yml": Product("release-pos-pilot.yml", ".github/workflows/pos.yml", POS_CHECKS, "pos/*", "pos", True),
    "release-admin-console.yml": Product(
        "release-admin-console.yml", ".github/workflows/admin-console.yml", ("admin/build-test", "admin/e2e"), "admin/*", "admin", True),
    "release-erpnext-connector.yml": Product(
        "release-erpnext-connector.yml", ".github/workflows/erpnext-connector.yml",
        ("connector/unit-tests-and-lint", "connector/bench"), "connector/*", "connector", False),
}
TEXTS = {name: read(WORKFLOWS / name) for name in PRODUCTS}


def required_for(product: Product) -> list:
    return [{"name": name, "workflow": product.ci_workflow} for name in product.checks]


def required_checks(text: str) -> list:
    return [json.loads(m) for m in re.findall(r"REQUIRED_CHECKS: '(\[.*\])'", text)]


def step_block(text: str, name: str) -> str:
    return step(text, name)


def graph_jobs() -> dict:
    """job name -> root workflow, from the top-level `jobs:` map of graph.yaml (no YAML library in the selftest)."""
    block = re.search(r"^jobs:\n((?:  \S.*\n)+)", read(GRAPH), re.M)
    return dict(re.findall(r"^  (\S+): (\S+)$", block.group(1), re.M))


JOB_IDS = itertools.count(7000)

# Stands in for `gh api [--paginate] <path> --jq EXPR`: answers the three read endpoints from fixtures in
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


def workflow_run(run_id: int, path: str, **over) -> dict:
    run = {"id": run_id, "path": path, "event": "push", "head_branch": "main", "head_sha": SHA,
           "repository": {"full_name": REPO}, "head_repository": {"full_name": REPO}}
    run.update(over)
    return run


def per_product(*, shapes=None, recheck=None):
    """Runs the test once for each release workflow it applies to, naming it in a failure."""

    def decorate(fn):
        def wrapper(self):
            ran = 0
            for name, product in PRODUCTS.items():
                if (shapes is not None and product.shape not in shapes) or (recheck is not None and product.recheck != recheck):
                    continue
                ran += 1
                with self.subTest(workflow=name):
                    fn(self, product, TEXTS[name])
            self.assertGreater(ran, 0, "the selection matched no workflow")

        wrapper.__name__ = fn.__name__
        return wrapper

    return decorate


def offset(text: str, step_name: str) -> int:
    match = re.search(rf"^      - name: {re.escape(step_name)}", text, re.M)
    if not match:
        raise AssertionError(f"step {step_name} missing")
    return match.start()


class ReleaseCiGuardWiring(unittest.TestCase):
    @per_product()
    def test_the_guard_job_is_read_only_secret_free_and_environment_free(self, product, text):
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

    @per_product()
    def test_no_workflow_is_dispatched_and_no_job_may_write_actions(self, product, text):
        for forbidden in (r"gh workflow run", r"/dispatches", r"actions: write", r"--method\s+POST", r"-X\s+POST",
                          r"workflow_dispatch\s*\(", r"gh run rerun"):
            # The proof hint is printed by the guard script, never written into a release workflow.
            self.assertNotRegex(text, forbidden)

    @per_product()
    def test_required_checks_are_the_policy_inventory_from_the_product_ci_workflow(self, product, text):
        found = required_checks(text)
        self.assertEqual(len(found), 2 if product.recheck else 1, "the guard job, plus the publish re-check where there is one")
        for required in found:
            self.assertEqual(required, required_for(product))

    @per_product()
    def test_every_required_check_is_a_graph_job_and_a_job_name_of_its_ci_workflow(self, product, text):
        # A renamed CI job would make every release refuse forever; this catches the rename instead.
        graph = graph_jobs()
        ci = read(ROOT / product.ci_workflow)
        for name in product.checks:
            self.assertEqual(graph.get(name), product.ci_workflow, f"{name} in graph.yaml")
            self.assertRegex(ci, rf"(?m)^    name: {re.escape(name)}$")

    @per_product()
    def test_the_guard_reads_both_check_runs_and_workflow_runs_of_the_exact_sha(self, product, text):
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

    @per_product()
    def test_the_gate_gets_the_exact_sha_and_repository(self, product, text):
        scripts = [step_script(job(text, "guard"), GATE_STEP)]
        if product.recheck:
            scripts.append(step_script(job(text, "publish"), RECHECK_STEP))
        for script in scripts:
            self.assertIn(".github/release/ci-check-gate.cjs", script)
            for flag in ('--checks "$RUNNER_TEMP/check-runs.json"', '--runs "$RUNNER_TEMP/workflow-runs.json"',
                         '--jobs "$RUNNER_TEMP/jobs.json"', '--required "$REQUIRED_CHECKS"', '--sha "$SHA"',
                         '--repo "$REPO"'):
                self.assertIn(flag, script)

    @per_product(shapes=("pos",))
    def test_pos_signing_manifest_and_publish_wait_for_the_guard(self, product, text):
        # The Windows build and the ephemeral dry-run signing stay independent of it (a dry run still proves the
        # build); everything that signs for real, records or publishes needs a green guard.
        self.assertEqual(needs_of(job(text, "build")), ["resolve"])
        self.assertEqual(needs_of(job(text, "sign-dry-run")), ["resolve", "build"])
        self.assertEqual(sorted(needs_of(job(text, "sign-release"))), ["build", "guard", "hold", "resolve"])
        self.assertEqual(sorted(needs_of(job(text, "manifest"))), ["build", "guard", "resolve", "sign-dry-run", "sign-release"])
        self.assertEqual(sorted(needs_of(job(text, "publish"))), ["guard", "hold", "manifest", "resolve", "sign-release"])
        for name in ("manifest", "publish"):
            condition = " ".join(job_if(job(text, name)).split())
            self.assertTrue(condition.startswith("!cancelled() && "), name)
            self.assertIn("needs.guard.result == 'success'", condition, name)
            self.assertNotIn("always()", condition, name)

    @per_product(shapes=("admin", "connector"))
    def test_admin_and_connector_manifest_and_publish_wait_for_the_guard(self, product, text):
        # The build stays independent of the guard (a dry run still proves the build); the manifest is the record
        # of a release, so a refused guard stops it, and publish needs the guard as well as the manifest.
        self.assertEqual(needs_of(job(text, "build")), ["resolve"])
        self.assertEqual(sorted(needs_of(job(text, "manifest"))), ["build", "guard", "resolve"])
        expected = ["build", "guard", "manifest", "resolve"] if product.shape == "admin" else ["guard", "manifest", "resolve"]
        self.assertEqual(sorted(needs_of(job(text, "publish"))), expected)
        # The default success() applies: a refused, failed or skipped guard skips the job. Nothing overrides it, so the
        # manifest has no `if:` at all and publish only the mode check (any other expression could re-admit a skipped guard).
        self.assertEqual(job_if(job(text, "manifest")), "")
        self.assertEqual(" ".join(job_if(job(text, "publish")).split()), "needs.resolve.outputs.mode == 'release'")

    @per_product(shapes=("connector",))
    def test_connector_publish_stays_disabled_and_gets_no_new_privilege(self, product, text):
        publish = job(text, "publish")
        self.assertIn("environment: release-erpnext-connector", publish)
        self.assertRegex(publish, r"(?m)^    permissions: \{\}$")
        self.assertEqual(re.findall(r"(?m)^      - name: (.+)$", publish), ["Refuse publication (Shadow)"])
        self.assertNotIn("uses:", publish)
        self.assertNotIn("secrets.", publish)
        self.assertIn("exit 1", publish)
        # No job of the workflow gains a write scope, and nothing publishes.
        self.assertNotRegex(text, r"(?m)^\s+(contents|id-token|attestations|actions|checks): write")
        self.assertNotRegex(text, r"gh release create|attest-build-provenance")

    @per_product(shapes=("admin",))
    def test_admin_publish_keeps_its_privileges_and_gains_only_checks_read(self, product, text):
        publish = job(text, "publish")
        block = re.search(r"^    permissions:\n((?:      .*\n)+)", publish, re.M)
        scopes = [re.sub(r"\s+#.*$", "", line.strip()) for line in block.group(1).splitlines()]
        self.assertEqual(scopes, ["contents: write", "id-token: write", "attestations: write", "actions: read", "checks: read"])
        self.assertIn("environment: release-admin-console", publish)
        self.assertRegex(publish, r"(?m)^    if: needs\.resolve\.outputs\.mode == 'release'$")
        for kept in ("Refuse unless the release environment is protected", "Check the release inputs",
                     "Check the package against the manifest", "Refuse if the release already exists",
                     "Attest build provenance", "Create the GitHub release"):
            self.assertIn(kept, publish)

    @per_product(recheck=True)
    def test_publish_proves_the_sha_again_after_the_approval_and_before_anything_irreversible(self, product, text):
        publish = job(text, "publish")
        names = re.findall(r"^      - name: (.+)$", publish, re.M)
        position = {n.split(" (")[0]: i for i, n in enumerate(names)}
        recheck = position[RECHECK_STEP]
        protect = next(i for n, i in position.items() if n.startswith("Refuse unless the release environment"))
        self.assertLess(protect, recheck, "after the environment protection check")
        for later in ("Attest build provenance", "Create the GitHub release"):
            self.assertLess(recheck, position[later], later)
        for download in (n for n in names if n.startswith("Download")):
            if download == "Download the source maps":  # Admin only: after the release exists, for the Sentry upload
                continue
            self.assertLess(recheck, names.index(download), download)
        self.assertRegex(publish, r"checks: read")
        self.assertRegex(publish, r"actions: read")
        script = step_script(publish, RECHECK_STEP)
        # An empty environment: the privileged job's OIDC and token variables never reach the script.
        self.assertIn('env -i PATH="$PATH" node .github/release/ci-check-gate.cjs', script)
        self.assertNotIn("GH_TOKEN", step_block(publish, RECHECK_STEP).split("run: |")[0].replace("GH_TOKEN: ${{ github.token }}", ""))

    @per_product(recheck=True)
    def test_publish_runs_only_the_one_guard_file_from_the_repository_before_publishing(self, product, text):
        publish = job(text, "publish")
        checkouts = [m for m in re.finditer(r"^      - name: .*\n        uses: actions/checkout@.*\n(?:        .*\n)+", publish, re.M)]
        # POS: the guard file is the only checkout. Admin: a second, later sparse checkout feeds the Sentry upload
        # that runs after the release exists (RT-1242).
        self.assertEqual(len(checkouts), 2 if product.shape == "admin" else 1)
        first = checkouts[0].group(0)
        self.assertIn("persist-credentials: false", first)
        self.assertIn("sparse-checkout-cone-mode: false", first)
        self.assertRegex(first, r"sparse-checkout: \|\n\s+/\.github/release/ci-check-gate\.cjs\n")
        self.assertEqual(re.findall(r"^\s+/\S+$", first, re.M), ["            /.github/release/ci-check-gate.cjs"])
        self.assertLess(checkouts[0].start(), offset(publish, RECHECK_STEP))
        for extra in checkouts[1:]:
            self.assertGreater(extra.start(), offset(publish, "Create the GitHub release"), "only the Sentry helper, after publishing")
            self.assertIn("Sentry", extra.group(0).splitlines()[0])
        self.assertNotIn("setup-node", publish)

    @per_product()
    def test_the_guard_checkout_covers_every_file_its_steps_read(self, product, text):
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

    @per_product()
    def test_the_guard_node_setup_caches_nothing(self, product, text):
        # zizmor cache-poisoning: a release workflow must not restore a package-manager cache a PR could have written.
        setup = step(job(text, "guard"), "Setup Node")
        self.assertIn("package-manager-cache: false", setup)

    @per_product()
    def test_the_guard_refuses_the_whole_release_not_only_the_publish(self, product, text):
        script = step_script(job(text, "guard"), GATE_STEP)
        self.assertIn('[ "$status" -eq 0 ] || {', script)
        self.assertIn("exit 1", script)
        self.assertIn(f"(mandatory {product.scope} checks)", script)

    @per_product()
    def test_nothing_can_soften_the_guard_verdict(self, product, text):
        # continue-on-error on the job or a step turns a refusal into `success`, and an `if:` on the job or on a step
        # skips the check: either would let the manifest and publish run without a green guard.
        self.assertNotIn("continue-on-error", text)
        guard = job(text, "guard")
        self.assertEqual(job_if(guard), "")
        steps = [(GATE_STEP, job(text, "guard"))]
        if product.recheck:
            steps.append((RECHECK_STEP, job(text, "publish")))
        for name, owner in steps:
            self.assertNotRegex(step_block(owner, name), r"(?m)^        if:", name)

    @per_product()
    def test_resolve_and_env_probe_are_unchanged_by_the_guard(self, product, text):
        # The guard adds a job after resolve; it does not touch what resolve proves or the negative environment probe.
        self.assertEqual(needs_of(job(text, "resolve")), [])
        self.assertIn("git merge-base --is-ancestor", step_script(job(text, "resolve"), "Resolve SHA, mode and tag"))
        if re.search(r"(?m)^  env-probe:$", text):  # the pilot release has no probe job
            probe = job(text, "env-probe")
            self.assertRegex(probe, r"(?m)^    permissions: \{\}$")
            self.assertNotIn("guard", probe)


@unittest.skipUnless(HAVE_BASH and shutil.which("jq") and shutil.which("node"), "bash, jq and node are needed")
class ReleaseCiGuardSteps(unittest.TestCase):
    """The shell steps of the guard job (and the publish re-check), run for real against fake `gh` answers."""

    def run_guard(self, product: Product, checks, runs, *, sha: str = SHA, jobs=None):
        text = TEXTS[product.file]
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
            # The job-level env of the workflow: the list the shell steps read is the one written in the YAML.
            env["REQUIRED_CHECKS"] = json.dumps(required_checks(guard)[0])
            first = subprocess.run([BASH, "-c", step_script(guard, READ_STEP)], capture_output=True, text=True, check=False, env=env, cwd=work)
            if first.returncode != 0:
                return first, None
            second = subprocess.run([BASH, "-c", step_script(guard, GATE_STEP)], capture_output=True, text=True, check=False, env=dict(env), cwd=work)
            verdict = output.read_text(encoding="utf-8") if output.exists() else ""
            return first, (second, verdict)

    def green(self, product: Product):
        return [check_run(name, 100) for name in product.checks], [workflow_run(100, product.ci_workflow)]

    def test_every_required_check_green_from_a_push_run_passes(self):
        for product in PRODUCTS.values():
            with self.subTest(workflow=product.file):
                checks, runs = self.green(product)
                first, second = self.run_guard(product, checks, runs)
                self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
                result, verdict = second
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("verdict=PASS", verdict)

    def test_the_guard_step_refuses_each_negative_case(self):
        for product in PRODUCTS.values():
            first_name, last_name = product.checks[0], product.checks[-1]
            checks, runs = self.green(product)
            other = ".github/workflows/admin-console.yml" if product.ci_workflow != ".github/workflows/admin-console.yml" else ".github/workflows/pos.yml"

            def change(name, **over):
                return [{**c, **over} if c["name"] == name else c for c in checks]

            cases = {
                "missing check": ([c for c in checks if c["name"] != last_name], runs, last_name),
                "failed check": (change(first_name, conclusion="failure"), runs, first_name),
                "cancelled": (change(last_name, conclusion="cancelled"), runs, last_name),
                "skipped": (change(first_name, conclusion="skipped"), runs, first_name),
                "timed out": (change(first_name, conclusion="timed_out"), runs, first_name),
                "pending": (change(last_name, status="in_progress", conclusion=None), runs, last_name),
                "wrong-SHA check": (change(first_name, head_sha="b" * 40), runs, first_name),
                "untrusted app": (change(first_name, app={"slug": "circleci-checks"}), runs, first_name),
                "pull_request run": (checks, [workflow_run(100, product.ci_workflow, event="pull_request", head_branch="feature")], "event"),
                "another product's workflow": (checks, [workflow_run(100, other)], "workflow"),
                "run on another branch": (checks, [workflow_run(100, product.ci_workflow, head_branch="claude/x")], "branch"),
                "fork run": (checks, [workflow_run(100, product.ci_workflow, head_repository={"full_name": "attacker/r"})], "repository"),
                "run for another SHA": (checks, [workflow_run(100, product.ci_workflow, head_sha="b" * 40)], "head SHA"),
                "run not listed": (checks, [], "run 100"),
            }
            real = next(c for c in checks if c["name"] == last_name)
            forged = check_run(last_name, 100, started_at="2026-11-20T11:00:00Z")
            forged["details_url"] = real["details_url"]  # a forged check run pointing at a real, trusted job
            cases["forged check run"] = ([*checks, forged], runs, "its id", [job_for(c) for c in checks])
            edited = next(c for c in checks if c["name"] == first_name)
            cases["job did not succeed"] = (checks, runs, first_name, [{**job_for(c), "conclusion": "failure"} if c is edited else job_for(c) for c in checks])
            cases["job missing"] = (checks, runs, "job", [job_for(c) for c in checks if c is not edited])
            # A re-run that started between the check-run read and the job read: a job with no check run.
            late = {"id": 99999, "run_id": 100, "name": last_name, "status": "queued", "conclusion": None, "head_sha": SHA,
                    "check_run_url": f"https://api.github.com/repos/{REPO}/check-runs/99999"}
            cases["re-run between the two reads"] = (checks, runs, "has no check run", [*[job_for(c) for c in checks], late])
            # A job whose name only starts like the required one is not the required check.
            cases["lookalike name"] = ([c for c in checks if c["name"] != last_name] + [check_run(f"{last_name} lane v16", 100)], runs, last_name)
            for label, case in cases.items():
                case_checks, case_runs, expect, *rest = case
                with self.subTest(workflow=product.file, case=label):
                    first, second = self.run_guard(product, case_checks, case_runs, jobs=rest[0] if rest else None)
                    self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
                    result, verdict = second
                    self.assertNotEqual(result.returncode, 0, "the guard accepted a bad case")
                    self.assertIn("verdict=REFUSED", verdict)
                    self.assertIn(expect, result.stdout + result.stderr)

    def test_the_newest_run_decides_a_later_red_rerun_refuses_an_older_green(self):
        for product in PRODUCTS.values():
            with self.subTest(workflow=product.file):
                checks, runs = self.green(product)
                rerun = check_run(product.checks[0], 101, conclusion="failure", started_at="2026-11-20T12:00:00Z")
                first, second = self.run_guard(product, [*checks, rerun], [*runs, workflow_run(101, product.ci_workflow)])
                self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
                self.assertNotEqual(second[0].returncode, 0)
                self.assertIn("verdict=REFUSED", second[1])

    def test_the_publish_recheck_step_passes_and_refuses_for_real(self):
        for product in (p for p in PRODUCTS.values() if p.recheck):
            publish = job(TEXTS[product.file], "publish")
            script = step_script(publish, RECHECK_STEP)
            for label, bad in (("green", False), ("a failed check", True)):
                with self.subTest(workflow=product.file, case=label), tempfile.TemporaryDirectory() as tmp:
                    base = Path(tmp)
                    (base / "bin").mkdir()
                    gh = base / "bin" / "gh"
                    gh.write_text(FAKE_GH, encoding="utf-8", newline="\n")
                    gh.chmod(0o755)
                    data = base / "data"
                    data.mkdir()
                    target = product.checks[-1]
                    checks = [check_run(n, 100, **({"conclusion": "failure"} if bad and n == target else {})) for n in product.checks]
                    (data / "check-runs.json").write_text(json.dumps({"check_runs": checks}), encoding="utf-8")
                    (data / "runs.json").write_text(json.dumps({"workflow_runs": [workflow_run(100, product.ci_workflow)]}), encoding="utf-8")
                    (data / "jobs-100.json").write_text(json.dumps({"jobs": [job_for(c) for c in checks]}), encoding="utf-8")
                    work = base / "work"
                    (work / ".github" / "release").mkdir(parents=True)
                    shutil.copy(GATE, work / ".github" / "release" / "ci-check-gate.cjs")
                    runner = base / "runner"
                    runner.mkdir()
                    env = {"PATH": f"{base / 'bin'}{os.pathsep}{os.environ.get('PATH', '')}", "REPO": REPO, "SHA": SHA,
                           "GH_TOKEN": "x", "FAKE_GH_DATA": data.as_posix(), "RUNNER_TEMP": runner.as_posix(),
                           "REQUIRED_CHECKS": json.dumps(required_checks(publish)[0])}
                    result = subprocess.run([BASH, "-c", script], capture_output=True, text=True, check=False, env=env, cwd=work)
                    if bad:
                        self.assertNotEqual(result.returncode, 0, "the publish re-check accepted a failed check")
                        self.assertIn(target, result.stdout + result.stderr)
                    else:
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        self.assertIn("PASS", result.stdout)

    def test_a_missing_check_prints_the_manual_proof_for_its_own_workflow_and_runs_nothing(self):
        for product in PRODUCTS.values():
            with self.subTest(workflow=product.file):
                _, second = self.run_guard(product, [], self.green(product)[1])
                result, _ = second
                hint_file = product.ci_workflow.split("/")[-1]
                self.assertIn(f"gh workflow run {hint_file} --ref main -f expected_sha={SHA}", result.stdout)
                self.assertIn("dispatches nothing", result.stdout)
                self.assertEqual(result.stdout.count("gh workflow run "), 1, "only the product's own proof, nothing else")

    def test_an_api_failure_refuses_the_release(self):
        for product in PRODUCTS.values():
            with self.subTest(workflow=product.file):
                checks, runs = self.green(product)
                first, second = self.run_guard(product, checks, None)  # the workflow-run list answers 404
                self.assertNotEqual(first.returncode, 0)
                self.assertIsNone(second)
                first, second = self.run_guard(product, None, runs)  # the check-run list answers 404
                self.assertNotEqual(first.returncode, 0)

    def test_an_empty_answer_is_a_refusal_not_a_pass(self):
        for product in PRODUCTS.values():
            with self.subTest(workflow=product.file):
                first, second = self.run_guard(product, [], [])
                self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
                self.assertNotEqual(second[0].returncode, 0)

    def test_a_bad_release_sha_is_refused_before_anything_is_trusted(self):
        for product in PRODUCTS.values():
            with self.subTest(workflow=product.file):
                checks, runs = self.green(product)
                first, second = self.run_guard(product, checks, runs, sha="ABC")
                # The request for a malformed SHA finds nothing (the read step fails), or the gate refuses it.
                self.assertTrue(first.returncode != 0 or second[0].returncode != 0)


if __name__ == "__main__":
    unittest.main()
