"""RT-1592: the release hold wiring of release-pos.yml and release-pos-pilot.yml, and the runner of its node spec.

The hold logic itself is specified in release-hold.test.cjs; this file runs that spec (so the release-tooling job,
which discovers `test_*.py` here, covers it) and checks the workflows around it: the hold job is read-only and
environment-free, only the signing-for-release and publish jobs wait for it, a dry-run prints the verdict and still
succeeds, a release run fails on a refusal, and the shell step works end to end against a throwaway git repository.
Runs in `python -m unittest discover -s .github/release`.
"""

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
from test_pos_release_workflow import job_if, needs_of, step  # noqa: E402

RELEASE_DIR = ROOT / ".github" / "release"
HOLD = RELEASE_DIR / "release-hold.cjs"
HOLD_SPEC = RELEASE_DIR / "release-hold.test.cjs"
WORKFLOW_PRODUCTS = {"release-pos.yml": "pos", "release-pos-pilot.yml": "pos-pilot"}
TEXTS = {name: read(WORKFLOWS / name) for name in WORKFLOW_PRODUCTS}
HOLD_STEP = "Release hold"
HAVE_NODE = shutil.which("node") is not None
if not HAVE_NODE and os.environ.get("CI"):
    raise RuntimeError("node is required in CI for the release hold specs")


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", *args],
                          cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


class HoldSpec(unittest.TestCase):
    @unittest.skipUnless(HAVE_NODE, "node not available")
    def test_the_node_spec_of_the_hold_check_passes(self):
        result = subprocess.run(["node", "--test", str(HOLD_SPEC)], capture_output=True, text=True, check=False, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stdout[-4000:] + result.stderr[-2000:])


class HoldWiring(unittest.TestCase):
    def each(self):
        for name, text in TEXTS.items():
            with self.subTest(workflow=name):
                yield name, text

    def test_the_hold_job_is_read_only_secret_free_and_environment_free(self):
        for name, text in self.each():
            hold = re.sub(r"(?m)^\s*#.*\n", "", job(text, "hold"))  # code lines only: the comments say what is NOT there
            self.assertEqual(needs_of(hold), ["resolve", "guard"])
            self.assertEqual(re.findall(r"^    permissions:\n((?:      .*\n)+)", hold, re.M)[0].split(), ["contents:", "read"])
            self.assertNotRegex(hold, r"(?m)^    environment:")
            self.assertNotIn("secrets.", hold)
            self.assertNotIn("id-token", hold)
            self.assertNotIn("GH_TOKEN", hold)
            self.assertNotIn("gh api", hold)
            self.assertNotIn("gh workflow", hold)
            self.assertNotRegex(hold, r"(?i)jira")
            self.assertEqual(hold.count("actions/checkout@"), 1)
            self.assertIn("persist-credentials: false", hold)
            self.assertIn("fetch-depth: 0", hold)

    def test_the_hold_checkout_is_only_the_check_its_manifest_and_nvmrc(self):
        for name, text in self.each():
            block = step(job(text, "hold"), "Checkout the hold check")
            patterns = re.findall(r"^            (/\S+)$", block, re.M)
            self.assertEqual(patterns, ["/.github/release/release-hold.cjs", "/.github/release/release-holds.json", "/.nvmrc"])
            self.assertIn("sparse-checkout-cone-mode: false", block)

    def test_the_hold_runs_the_check_for_its_own_product_with_the_guard_verdict(self):
        for name, text in self.each():
            script = step_script(job(text, "hold"), HOLD_STEP)
            self.assertIn("node .github/release/release-hold.cjs --manifest .github/release/release-holds.json", script)
            self.assertIn(f"--product {WORKFLOW_PRODUCTS[name]} ", script)
            self.assertIn('--sha "$SHA"', script)
            self.assertIn('--guard-verdict "$GUARD_VERDICT"', script)
            self.assertRegex(job(text, "hold"), r"SHA: \$\{\{ needs\.resolve\.outputs\.sha \}\}")
            self.assertRegex(job(text, "hold"), r"GUARD_VERDICT: \$\{\{ needs\.guard\.outputs\.verdict \}\}")
            self.assertRegex(job(text, "hold"), r"MODE: \$\{\{ needs\.resolve\.outputs\.mode \}\}")

    def test_the_hold_runs_on_every_run_so_a_dry_run_shows_the_verdict(self):
        for name, text in self.each():
            condition = job_if(job(text, "hold"))
            self.assertEqual(condition, "!cancelled() && needs.resolve.result == 'success'")
            self.assertNotIn("guard.result", condition, "a refused guard must not hide the hold verdict")
            self.assertNotIn("always()", condition)

    def test_only_signing_for_release_and_publish_wait_for_the_hold(self):
        for name, text in self.each():
            self.assertEqual(needs_of(job(text, "resolve")), [])
            self.assertEqual(needs_of(job(text, "guard")), ["resolve"])
            self.assertEqual(needs_of(job(text, "build")), ["resolve"])
            self.assertEqual(needs_of(job(text, "sign-dry-run")), ["resolve", "build"])
            self.assertEqual(needs_of(job(text, "sign-release")), ["resolve", "guard", "hold", "build"])
            self.assertEqual(sorted(needs_of(job(text, "manifest"))), ["build", "guard", "resolve", "sign-dry-run", "sign-release"])
            self.assertEqual(needs_of(job(text, "publish")), ["resolve", "guard", "hold", "sign-release", "manifest"])
            self.assertIn("needs.hold.result == 'success'", job_if(job(text, "publish")))
            # The dry-run path (sign-dry-run and the dry-run manifest) never mentions the hold.
            self.assertNotIn("hold", job_if(job(text, "manifest")))
            self.assertNotIn("hold", job(text, "sign-dry-run"))
            self.assertNotIn("hold", job(text, "build"))

    def test_nothing_in_the_workflow_can_soften_the_hold(self):
        for name, text in self.each():
            self.assertNotRegex(text, r"(?i)continue-on-error")
            self.assertNotIn("release-hold.cjs || true", text)
            self.assertEqual(text.count("release-hold.cjs --manifest"), 1)
            self.assertNotIn("hold.outputs.verdict == 'PASS' ||", text)

    def test_the_two_existing_guards_and_the_required_checks_are_unchanged(self):
        for name, text in self.each():
            self.assertEqual(text.count("ci-check-gate.cjs --checks"), 2, "the guard and the publish re-check stay")
            required = re.findall(r"REQUIRED_CHECKS: '(\[.*\])'", text)
            self.assertEqual(len(required), 2)
            self.assertEqual([c["name"] for c in json.loads(required[0])], ["pos/static", "pos/test", "pos/package-windows", "pos/e2e-electron"])


@unittest.skipUnless(HAVE_BASH and HAVE_NODE, "bash and node are required")
class HoldStepEndToEnd(unittest.TestCase):
    """Runs the workflow's own shell steps (as Actions would) against a throwaway git repository."""

    def make_repo(self, base: Path, *, cleared: bool, mutate=None):
        work = base / "work"
        (work / ".github" / "release").mkdir(parents=True)
        git(work, "init", "-q", "-b", "main")
        (work / "README.md").write_text("base\n", encoding="utf-8")
        git(work, "add", "README.md")
        git(work, "commit", "-q", "-m", "base")
        (work / "apps" / "pos").mkdir(parents=True)
        (work / "apps" / "pos" / "cap.test.ts").write_text("t\n", encoding="utf-8")
        (work / "apps" / "pos" / "cap.ts").write_text("e\n", encoding="utf-8")
        git(work, "add", "apps")
        git(work, "commit", "-q", "-m", "feat: the capability")
        clearing = git(work, "rev-parse", "HEAD")
        shutil.copy(HOLD, work / ".github" / "release" / "release-hold.cjs")
        if cleared:
            manifest = {"schema": 1, "holds": [{
                "id": "park-limit", "reason": "r", "products": ["pos", "pos-pilot"], "status": "cleared",
                "capabilities": [{"name": "cap", "clearing_shas": [clearing], "tests": ["apps/pos/cap.test.ts"], "entry_points": ["apps/pos/cap.ts"]}]}]}
            if mutate:
                mutate(manifest)
            (work / ".github" / "release" / "release-holds.json").write_text(json.dumps(manifest), encoding="utf-8")
        else:
            # An explicit open hold, so these cases keep testing the open path after the clearing PR sets the committed one to cleared.
            open_hold = {"schema": 1, "holds": [{"id": "park-limit", "reason": "r", "products": ["pos", "pos-pilot"],
                                                  "status": "open", "lifted_by": ["RT-1562", "RT-1563"]}]}
            (work / ".github" / "release" / "release-holds.json").write_text(json.dumps(open_hold), encoding="utf-8")
        git(work, "add", ".github")
        git(work, "commit", "-q", "-m", "chore: the hold")
        return work, git(work, "rev-parse", "HEAD")

    def run_hold(self, name: str, *, mode: str, guard: str, cleared: bool, mutate=None):
        text = TEXTS[name]
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            work, sha = self.make_repo(base, cleared=cleared, mutate=mutate)
            runner = base / "runner"
            runner.mkdir()
            output, summary = base / "out.txt", base / "summary.md"
            env = {"PATH": os.environ.get("PATH", ""), "SHA": sha, "MODE": mode, "GUARD_VERDICT": guard,
                   "RUNNER_TEMP": runner.as_posix(), "GITHUB_OUTPUT": output.as_posix(), "GITHUB_STEP_SUMMARY": summary.as_posix()}
            hold = job(text, "hold")
            checkout = subprocess.run([BASH, "-c", step_script(hold, "Check the checkout is the release SHA")], capture_output=True, text=True, check=False, env=env, cwd=work)
            result = subprocess.run([BASH, "-c", step_script(hold, HOLD_STEP)], capture_output=True, text=True, check=False, env=env, cwd=work)
            return checkout, result, (output.read_text(encoding="utf-8") if output.exists() else ""), (summary.read_text(encoding="utf-8") if summary.exists() else "")

    def test_the_checkout_step_accepts_the_release_sha_and_refuses_another(self):
        for name in TEXTS:
            with self.subTest(workflow=name):
                checkout, _, _, _ = self.run_hold(name, mode="dry-run", guard="PASS", cleared=False)
                self.assertEqual(checkout.returncode, 0, checkout.stdout + checkout.stderr)
        text = TEXTS["release-pos-pilot.yml"]
        with tempfile.TemporaryDirectory() as tmp:
            work, _ = self.make_repo(Path(tmp), cleared=False)
            env = {"PATH": os.environ.get("PATH", ""), "SHA": "b" * 40}
            wrong = subprocess.run([BASH, "-c", step_script(job(text, "hold"), "Check the checkout is the release SHA")], capture_output=True, text=True, check=False, env=env, cwd=work)
            self.assertNotEqual(wrong.returncode, 0)
            self.assertIn("the checkout is not the release SHA", wrong.stdout)

    def test_an_open_hold_in_a_dry_run_prints_the_verdict_and_still_succeeds(self):
        for name in TEXTS:
            with self.subTest(workflow=name):
                _, result, output, summary = self.run_hold(name, mode="dry-run", guard="PASS", cleared=False)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("verdict=REFUSED", output)
                self.assertIn("hold 'park-limit' is open", result.stdout)
                self.assertNotIn("::error::", result.stdout, "a dry-run reports the refusal as a warning, not an error")
                self.assertIn("::warning::", result.stdout)
                self.assertIn("Release hold: REFUSED", result.stdout)
                self.assertIn("hold 'park-limit' is open", summary)
                self.assertIn("RT-1592", summary)

    def test_an_open_hold_in_a_release_run_fails_the_job_and_names_the_hold(self):
        for name in TEXTS:
            with self.subTest(workflow=name):
                _, result, output, summary = self.run_hold(name, mode="release", guard="PASS", cleared=False)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn("verdict=REFUSED", output)
                self.assertIn("::error::hold 'park-limit' is open", result.stdout)
                self.assertIn("it must not be signed or published", result.stdout)
                self.assertIn("hold 'park-limit' is open", summary)

    def test_a_cleared_hold_with_real_evidence_and_a_passing_guard_passes_in_both_modes(self):
        for name in TEXTS:
            for mode in ("dry-run", "release"):
                with self.subTest(workflow=name, mode=mode):
                    _, result, output, _ = self.run_hold(name, mode=mode, guard="PASS", cleared=True)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn("verdict=PASS", output)
                    self.assertIn("Release hold: PASS", result.stdout)

    def test_a_cleared_hold_is_refused_in_a_release_when_the_ci_guard_did_not_pass_or_evidence_is_missing(self):
        def missing_entry(manifest):
            manifest["holds"][0]["capabilities"][0]["entry_points"] = ["apps/pos/gone.ts"]

        cases = {"guard refused": ("REFUSED", None, "release CI guard verdict is 'REFUSED'"),
                 "guard output empty": ("", None, "release CI guard verdict is 'none'"),
                 "entry point missing": ("PASS", missing_entry, "production entry point apps/pos/gone.ts is missing")}
        for name in TEXTS:
            for label, (guard, mutate, expected) in cases.items():
                with self.subTest(workflow=name, case=label):
                    _, result, output, _ = self.run_hold(name, mode="release", guard=guard, cleared=True, mutate=mutate)
                    self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                    self.assertIn("verdict=REFUSED", output)
                    self.assertIn(expected, result.stdout)

    def test_a_malformed_manifest_fails_a_release_and_only_warns_in_a_dry_run(self):
        def break_status(manifest):
            manifest["holds"][0]["status"] = "closed"

        for name in TEXTS:
            with self.subTest(workflow=name):
                _, release, _, _ = self.run_hold(name, mode="release", guard="PASS", cleared=True, mutate=break_status)
                self.assertEqual(release.returncode, 1)
                _, dry, output, _ = self.run_hold(name, mode="dry-run", guard="PASS", cleared=True, mutate=break_status)
                self.assertEqual(dry.returncode, 0)
                self.assertIn("verdict=REFUSED", output)
                self.assertIn("unknown status", dry.stdout)


if __name__ == "__main__":
    unittest.main()
