"""RT-1294: static and step-level checks of release-pos-pilot.yml (the pilot-signed POS installer release).

The workflow is policy class (root .github/), so its checks live here and run in project-graph-selftest
(`python -m unittest discover -s .github/release`), next to the lab release checks whose helpers are reused.
The signing script itself, apps/pos/scripts/pilot/ci/release-pilot-installer.ps1, is Windows-only; it is first
proven by the dry run on main (resolve refuses branch SHAs), and its release-only certificate path by the
first real release.

What is pinned: the pilot tag pattern, the two new environments and nothing else holding one, the signing
material reaching exactly one step, the exact asset set, no lab name anywhere, and the version gate of the
resolve step (run for real with bash when bash works).
"""

import hashlib
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

from test_console_lab_workflow import BASH, HAVE_BASH, WORKFLOWS, job, read, run_step, step_script, triggers  # noqa: E402
from test_pos_release_workflow import git, job_if, needs_of, step  # noqa: E402

SECRETS = ("POS_PILOT_SIGN_PFX_BASE64", "POS_PILOT_SIGN_PFX_PASSWORD")
SIGN_ENV = "release-pos-pilot-sign"
PUBLISH_ENV = "release-pos-pilot"
LAB_NAMES = ("POS_LAB", "release-pos-sign", "release-pos\n", "release-lab-installer", "lab.yml", "LAB-Setup", ".blockmap", "win-x64.zip")


def code(text: str) -> str:
    """The text without comment lines: a comment may name a key without being one."""
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


class ReleasePosPilot(unittest.TestCase):
    text = read(WORKFLOWS / "release-pos-pilot.yml")

    def test_triggers_are_the_pilot_tag_push_and_dispatch_only(self):
        self.assertEqual(triggers(self.text), ["push", "workflow_dispatch"])
        self.assertRegex(self.text, r'(?m)^  push:\n    tags: \["pos-pilot/v\*"\]$')
        self.assertNotIn("pull_request", code(self.text))

    def test_every_action_is_pinned_by_sha(self):
        uses = re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", self.text, re.M)
        self.assertTrue(uses)
        for ref in uses:
            self.assertRegex(ref, r"^[\w./-]+@[0-9a-f]{40}$")

    def test_actions_are_the_ones_the_lab_release_pins(self):
        lab = read(WORKFLOWS / "release-pos.yml")
        lab_uses = set(re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", lab, re.M))
        for ref in re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", self.text, re.M):
            self.assertIn(ref, lab_uses, f"{ref} is not pinned by release-pos.yml")

    def test_permissions_empty_at_the_top_and_inputs_never_expanded_in_run_scripts(self):
        self.assertRegex(self.text, r"(?m)^permissions: \{\}$")
        for block in re.findall(r"run: \|\n((?:          .*\n|\n)+)", self.text):
            self.assertNotIn("${{", block, block[:200])

    def test_no_lab_name_appears_anywhere(self):
        for name in LAB_NAMES:
            self.assertNotIn(name, self.text + "\n", name)
        self.assertNotIn("refs/tags/pos/v", self.text)

    def test_only_the_two_pilot_jobs_hold_an_environment(self):
        self.assertEqual(re.findall(r"^    environment: (\S+)$", job(self.text, "sign-release"), re.M), [SIGN_ENV])
        self.assertEqual(re.findall(r"^    environment: (\S+)$", job(self.text, "publish"), re.M), [PUBLISH_ENV])
        for name in ("resolve", "build", "sign-dry-run", "manifest"):
            self.assertNotIn("environment:", code(job(self.text, name)), name)
        self.assertEqual(len(re.findall(r"^    environment:", code(self.text), re.M)), 2)

    def test_signing_material_reaches_exactly_one_step_of_one_job(self):
        for secret in SECRETS:
            self.assertEqual(self.text.count(f"secrets.{secret}"), 1, secret)
        self.assertEqual(len(re.findall(r"\$\{\{ secrets\.", self.text)), len(SECRETS))
        sign = job(self.text, "sign-release")
        owner = step(sign, "Sign and verify the installer")
        for secret in SECRETS:
            self.assertIn(f"secrets.{secret}", owner)
        self.assertIn("vars.POS_PILOT_LEAF_SHA1", owner)
        for name in ("resolve", "build", "sign-dry-run", "manifest", "publish"):
            self.assertNotRegex(job(self.text, name), r"secrets\.(?!RELEASE)", name)

    def test_sign_job_installs_without_lifecycle_scripts_and_cleans_up_always(self):
        sign = job(self.text, "sign-release")
        self.assertIn("npm ci --ignore-scripts", sign)
        self.assertRegex(step(sign, "Remove the pilot certificates"), r"if: always\(\)")
        dry = job(self.text, "sign-dry-run")
        self.assertIn("npm ci --ignore-scripts", dry)
        self.assertRegex(step(dry, "Remove the pilot certificates"), r"if: always\(\)")

    def test_both_sign_paths_timestamp_with_the_http_sectigo_url(self):
        # Pinned exactly. The signtool on the hosted runner rejected the https form ("Invalid Timestamp URL",
        # RT-1294 dry run 42783687374), so an https value would fail every signing run until that is re-proven.
        for name in ("sign-release", "sign-dry-run"):
            tsa = re.findall(r"POS_PILOT_TSA_URL: (\S+)", job(self.text, name))
            self.assertEqual(tsa, ["http://timestamp.sectigo.com"], name)

    def test_dry_run_reads_no_secret_and_release_publishes_only_after_both_gates(self):
        self.assertNotIn("secrets.", job(self.text, "sign-dry-run"))
        self.assertIn("-Mode dry-run", job(self.text, "sign-dry-run"))
        self.assertIn("-Mode release", job(self.text, "sign-release"))
        self.assertIn("needs.resolve.outputs.mode == 'dry-run'", job_if(job(self.text, "sign-dry-run")))
        self.assertIn("needs.resolve.outputs.mode == 'release'", job_if(job(self.text, "sign-release")))
        pub = job(self.text, "publish")
        self.assertEqual(sorted(needs_of(pub)), ["manifest", "resolve", "sign-release"])
        self.assertIn("mode == 'release'", job_if(pub))

    def test_the_build_job_is_secret_free_and_unsigned(self):
        build = job(self.text, "build")
        self.assertNotIn("environment:", build)
        self.assertNotIn("secrets.", build)
        self.assertIn("npm run package:dir", build)
        self.assertIn("scripts/verify-packaged.ts fuses", build)
        self.assertIn("scripts/verify-packaged.ts native", build)

    def test_manifest_records_one_pilot_installer_for_the_pilot_product(self):
        script = step_script(job(self.text, "manifest"), "Write the release manifest")
        self.assertIn("--product pos-pilot", script)
        self.assertEqual(script.count("--artifact "), 1)
        self.assertIn('--artifact "pos-installer=', script)
        self.assertIn("POS-Pulse-Setup-*.exe", script)

    def test_publish_refuses_unprotected_environments_and_never_overwrites(self):
        pub = job(self.text, "publish")
        check = step_script(pub, "Refuse unless the release environments are protected")
        self.assertIn('[{"name":"pos-pilot/v*","type":"tag"}]', check)
        self.assertIn(f"check_env {PUBLISH_ENV} required", check)
        # A rogue tag runs that commit's copy of this file: the owner's approval on the signing environment is
        # the control, so the alarm demands the reviewer there too.
        self.assertIn(f"check_env {SIGN_ENV} required", check)
        self.assertNotIn("optional", check)
        self.assertIn("refusing to overwrite", step_script(pub, "Refuse if the release already exists"))

    def test_publish_attests_the_signed_installer_and_releases_exactly_three_assets(self):
        pub = job(self.text, "publish")
        attest = step(pub, "Attest build provenance")
        self.assertIn("POS-Pulse-Setup-*.exe", attest)
        self.assertEqual(len(re.findall(r"runner\.temp \}\}/pkg/", attest)), 1)
        release = step_script(pub, "Create the GitHub release")
        self.assertIn('"$EXE" "$EXE.sha256" release-manifest.json', release)
        self.assertIn("(PILOT)", release)
        self.assertIn("--verify-tag", release)
        manifest_check = step_script(pub, "Check the package against the manifest")
        self.assertIn('.product == "pos-pilot"', manifest_check)
        self.assertIn('.signing == "pilot"', manifest_check)
        self.assertIn("(.artifacts | length == 1)", manifest_check)

    @unittest.skipUnless(HAVE_BASH and shutil.which("jq"), "bash and jq are needed")
    def test_resolve_version_gate_and_pilot_tag_only(self):
        script = step_script(self.text, "Resolve SHA, mode and tag")
        package = Path("apps") / "pos" / "package.json"
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / package).parent.mkdir(parents=True)
            git(repo, "init", "-q")
            (repo / package).write_text(json.dumps({"version": "0.1.0"}), encoding="utf-8")
            git(repo, "add", package.as_posix())
            git(repo, "commit", "-q", "-m", "x")
            sha = git(repo, "rev-parse", "HEAD")
            git(repo, "update-ref", "refs/remotes/origin/main", sha)
            summary, output = repo / "summary.md", repo / "output.txt"

            def run(event: str, ref: str, dry_run: str, at: str = sha) -> subprocess.CompletedProcess:
                """Runs the resolve step for an event, ref and dry-run input, at a commit (default: main's)."""
                output.unlink(missing_ok=True)
                summary.unlink(missing_ok=True)
                env = {"EVENT": event, "REF": ref, "SHA": at, "DRY_RUN": dry_run,
                       "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)}
                return subprocess.run([BASH, "-c", script], cwd=repo, capture_output=True, text=True, check=False,
                                      env={"PATH": os.environ.get("PATH", ""), **env})

            refused = run("push", "refs/tags/pos-pilot/v0.2.0", "")
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn("0.2.0", refused.stdout + refused.stderr)
            self.assertIn("0.1.0", refused.stdout + refused.stderr)
            lab_tag = run("push", "refs/tags/pos/v0.1.0", "")
            self.assertNotEqual(lab_tag.returncode, 0, "a lab tag must never start the pilot release")
            accepted = run("push", "refs/tags/pos-pilot/v0.1.0", "")
            self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
            self.assertIn("mode=release", output.read_text(encoding="utf-8"))
            self.assertIn("tag=pos-pilot/v0.1.0", output.read_text(encoding="utf-8"))
            dry = run("workflow_dispatch", "refs/heads/some-branch", "true")
            self.assertEqual(dry.returncode, 0, dry.stdout + dry.stderr)
            self.assertIn("mode=dry-run", output.read_text(encoding="utf-8"))
            branch_release = run("workflow_dispatch", "refs/heads/some-branch", "false")
            self.assertNotEqual(branch_release.returncode, 0, "a non-dry-run dispatch needs a pilot tag ref")
            # The tag pattern is anchored at both ends: neither a suffix nor a look-alike product prefix starts it.
            for ref in ("refs/tags/pos-pilot/v0.1.0-rc1", "refs/tags/pos-pilot-x/v0.1.0", "refs/tags/xpos-pilot/v0.1.0"):
                self.assertNotEqual(run("push", ref, "").returncode, 0, ref)
            # A commit that is not an ancestor of origin/main is refused, in both modes.
            (repo / "other.txt").write_text("x", encoding="utf-8")
            git(repo, "add", "other.txt")
            git(repo, "commit", "-q", "-m", "y")
            off_main = git(repo, "rev-parse", "HEAD")
            off_release = run("push", "refs/tags/pos-pilot/v0.1.0", "", off_main)
            self.assertNotEqual(off_release.returncode, 0, "a release SHA off main must be refused")
            self.assertIn("not on main", off_release.stdout + off_release.stderr)
            self.assertNotEqual(run("workflow_dispatch", "refs/heads/x", "true", off_main).returncode, 0)

    def test_every_job_has_exactly_the_permissions_it_needs(self):
        def permissions(name: str) -> list[str]:
            """The job-level `permissions:` entries of a job, without trailing comments."""
            block = re.search(r"^    permissions:\n((?:      .*\n)+)", job(self.text, name) + "\n", re.M)
            self.assertIsNotNone(block, name)
            return [re.sub(r"\s+#.*$", "", line.strip()) for line in block.group(1).splitlines()]

        for name in ("resolve", "build", "sign-dry-run", "sign-release", "manifest"):
            self.assertEqual(permissions(name), ["contents: read"], name)
        self.assertEqual(
            permissions("publish"),
            ["contents: write", "id-token: write", "attestations: write", "actions: read"],
        )

    def test_every_checkout_drops_the_token(self):
        checkouts = re.findall(r"uses: actions/checkout@", self.text)
        self.assertEqual(len(checkouts), 5)
        self.assertEqual(len(re.findall(r"persist-credentials: false", self.text)), len(checkouts))

    def test_manifest_and_publish_run_only_when_every_gate_succeeded(self):
        def words(text: str) -> str:
            """The text on one line: a folded `if:` may wrap anywhere."""
            return " ".join(text.split())

        manifest_if = words(job_if(job(self.text, "manifest")))
        for part in ("!cancelled()", "needs.resolve.result == 'success'", "needs.build.result == 'success'",
                     "needs.resolve.outputs.mode == 'dry-run' && needs.sign-dry-run.result == 'success'",
                     "needs.resolve.outputs.mode == 'release' && needs.sign-release.result == 'success'"):
            self.assertIn(part, manifest_if)
        publish_if = words(job_if(job(self.text, "publish")))
        for part in ("!cancelled()", "needs.resolve.result == 'success'", "needs.resolve.outputs.mode == 'release'",
                     "needs.sign-release.result == 'success'", "needs.manifest.result == 'success'"):
            self.assertIn(part, publish_if)
        self.assertNotIn("||", publish_if)
        self.assertNotIn("always()", publish_if + manifest_if)

    def test_the_cleanup_step_follows_the_signing_step_and_runs_the_cleanup_mode(self):
        for name in ("sign-release", "sign-dry-run"):
            text = job(self.text, name)
            self.assertLess(text.index("name: Sign and verify the installer"), text.index("name: Remove the pilot certificates"))
            self.assertIn("release-pilot-installer.ps1 -Cleanup", step(text, "Remove the pilot certificates"))

    @unittest.skipUnless(HAVE_BASH and shutil.which("jq") and shutil.which("sha256sum"), "bash, jq and sha256sum are needed")
    def test_publish_manifest_check_accepts_only_the_pilot_package_it_was_built_for(self):
        script = step_script(job(self.text, "publish"), "Check the package against the manifest")
        tag, sha, exe = "pos-pilot/v0.1.0", "a" * 40, "POS-Pulse-Setup-0.1.0.exe"
        payload = b"installer bytes"
        digest = "sha256:" + hashlib.sha256(payload).hexdigest()

        def good() -> dict:
            """A fresh manifest that the publish check must accept."""
            return {"product": "pos-pilot", "signing": "pilot", "mode": "release", "tag": tag, "source": {"sha": sha},
                    "artifacts": [{"name": "pos-installer", "file": exe, "digest": digest}]}

        def run(manifest: dict) -> subprocess.CompletedProcess:
            """Runs the publish step's check on a package holding the installer and this manifest."""
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                (temp / "pkg").mkdir()
                (temp / "manifest").mkdir()
                (temp / "pkg" / exe).write_bytes(payload)
                (temp / "manifest" / "release-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                env = {"PATH": os.environ.get("PATH", ""), "TAG": tag, "SHA": sha, "RUNNER_TEMP": temp.as_posix()}
                result = subprocess.run([BASH, "-c", script], capture_output=True, text=True, check=False, env=env)
                if result.returncode == 0:
                    self.assertTrue((temp / "pkg" / f"{exe}.sha256").is_file())
                    self.assertTrue((temp / "pkg" / "release-manifest.json").is_file())
                return result

        accepted = run(good())
        self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
        extra = good()
        extra["artifacts"].append({"name": "other", "file": "x", "digest": digest})
        bad = {
            "another product": {**good(), "product": "pos"},
            "no signing field": {k: v for k, v in good().items() if k != "signing"},
            "a lab signing field": {**good(), "signing": "lab"},
            "a dry-run manifest": {**good(), "mode": "dry-run"},
            "another tag": {**good(), "tag": "pos-pilot/v0.1.1"},
            "another sha": {**good(), "source": {"sha": "b" * 40}},
            "another digest": {**good(), "artifacts": [{"name": "pos-installer", "file": exe, "digest": "sha256:" + "0" * 64}]},
            "a second artifact": extra,
        }
        for label, manifest in bad.items():
            self.assertNotEqual(run(manifest).returncode, 0, label)


class ReleasePosPilotLaneConfig(unittest.TestCase):
    """RT-1347 (RT-1345 D1, S2): the pilot build stamps its public lane configuration from repository variables.

    Exactly one stamp and nothing else: lane `pilot`, the API base URL and the Descope project id from variables
    (never secrets, never an environment on the build job), the update origin and channel left empty (D5 is not
    approved), the packaged lane-config.json verified before signing, and its digest recorded in the manifest.
    """

    text = read(WORKFLOWS / "release-pos-pilot.yml")
    API_VAR = "POS_PILOT_LANE_API_BASE_URL"
    DESCOPE_VAR = "POS_PILOT_LANE_DESCOPE_PROJECT_ID"
    VERIFY = "scripts/pilot/verify-pilot-lane-config.ts"
    BUILD_STEP = "Build (renderer + main + preload)"

    def build_step_env(self, name: str) -> dict[str, str]:
        """The `env:` entries of the build job's step whose name starts with `name`."""
        match = re.search(rf"^      - name: {re.escape(name)}.*?\n(.*?)(?=^      - name: |\Z)", job(self.text, "build"), re.M | re.S)
        self.assertIsNotNone(match, name)
        block = re.search(r"^        env:\n((?:          .*\n)+)", match.group(1), re.M)
        self.assertIsNotNone(block, name)
        return dict(re.findall(r"^          (\w+): (.*)$", block.group(1), re.M))

    def test_the_build_stamps_lane_pilot_and_the_two_public_values_from_repository_variables(self):
        env = self.build_step_env(self.BUILD_STEP)
        self.assertEqual(env["POS_LANE_CONFIG_LANE"], "pilot")
        self.assertEqual(env["POS_LANE_CONFIG_API_BASE_URL"], "${{ vars." + self.API_VAR + " }}")
        self.assertEqual(env["POS_LANE_CONFIG_DESCOPE_PROJECT_ID"], "${{ vars." + self.DESCOPE_VAR + " }}")

    def test_the_update_origin_and_channel_stay_empty_for_the_pilot_lane(self):
        # RT-1345 D5 is not approved: no update origin, no channel, no feed, anywhere in this workflow.
        env = self.build_step_env(self.BUILD_STEP)
        self.assertEqual(env["POS_LANE_CONFIG_UPDATE_ORIGIN"], '""')
        self.assertEqual(env["POS_LANE_CONFIG_UPDATE_CHANNEL"], '""')
        self.assertEqual(sorted(env), sorted(
            ["POS_LANE_CONFIG_LANE", "POS_LANE_CONFIG_API_BASE_URL", "POS_LANE_CONFIG_DESCOPE_PROJECT_ID",
             "POS_LANE_CONFIG_UPDATE_ORIGIN", "POS_LANE_CONFIG_UPDATE_CHANNEL"]))
        for name in ("ELECTRON_UPDATE_FEED_URL", "POS_PULSE_UPDATE_CHANNEL", "app-update.yml"):
            self.assertNotIn(name, code(self.text), name)

    def test_the_stamp_reaches_the_build_job_only_and_through_variables_not_secrets(self):
        self.assertEqual(len(re.findall(r"POS_LANE_CONFIG_LANE:", self.text)), 1)
        for name in ("resolve", "sign-dry-run", "sign-release", "manifest", "publish"):
            self.assertNotIn("POS_LANE_CONFIG", job(self.text, name), name)
            self.assertNotIn("vars." + self.API_VAR, job(self.text, name), name)
        # The only repository variables this workflow reads: the leaf pin (signing job) and the two lane values.
        self.assertEqual(sorted(set(re.findall(r"\$\{\{ vars\.(\w+) \}\}", self.text))),
                         sorted(["POS_PILOT_LEAF_SHA1", self.API_VAR, self.DESCOPE_VAR]))
        self.assertEqual(len(re.findall(r"\$\{\{ secrets\.", self.text)), len(SECRETS))
        # No environment on the build job (repository variables), and none added anywhere.
        self.assertNotIn("environment:", code(job(self.text, "build")))
        self.assertEqual(len(re.findall(r"^    environment:", code(self.text), re.M)), 2)

    def test_the_pilot_values_are_checked_before_anything_is_installed_or_built(self):
        build = job(self.text, "build")
        order = [build.index(f"name: {n}") for n in
                 ("Check the pilot lane variables", "Install dependencies", self.BUILD_STEP,
                  "Package (Windows --dir, unsigned)", "Verify the packaged pilot lane configuration",
                  "Upload win-unpacked")]
        self.assertEqual(order, sorted(order))
        env = self.build_step_env("Check the pilot lane variables")
        self.assertEqual(env, {self.API_VAR: "${{ vars." + self.API_VAR + " }}", self.DESCOPE_VAR: "${{ vars." + self.DESCOPE_VAR + " }}"})

    @unittest.skipUnless(HAVE_BASH, "bash is needed")
    def test_a_blank_or_missing_variable_fails_the_check_and_names_the_variable_not_a_value(self):
        script = step_script(job(self.text, "build"), "Check the pilot lane variables")
        good = {self.API_VAR: "https://api.pilot.example", self.DESCOPE_VAR: "P2abcdefghijklmnopqrstuvwxyz"}

        def run(env: dict[str, str]) -> subprocess.CompletedProcess:
            return subprocess.run([BASH, "-c", script], capture_output=True, text=True, check=False,
                                  env={"PATH": os.environ.get("PATH", ""), **env})

        accepted = run(good)
        self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
        for label, env in {
            "both missing": {},
            "api blank": {**good, self.API_VAR: ""},
            "api spaces": {**good, self.API_VAR: "   \t "},
            "descope blank": {**good, self.DESCOPE_VAR: ""},
            "descope spaces": {**good, self.DESCOPE_VAR: " "},
        }.items():
            result = run(env)
            self.assertNotEqual(result.returncode, 0, label)
            blank = [n for n in (self.API_VAR, self.DESCOPE_VAR) if env.get(n, "").strip() == ""]
            for name in blank:
                self.assertIn(name, result.stdout + result.stderr, label)
            for value in good.values():
                self.assertNotIn(value, result.stdout + result.stderr, label)

    def test_the_packaged_file_is_verified_before_the_upload_and_its_digest_leaves_the_build_job(self):
        build = job(self.text, "build")
        verify = re.search(r"^      - name: Verify the packaged pilot lane configuration.*?\n(.*?)(?=^      - name: |\Z)", build, re.M | re.S)
        self.assertIsNotNone(verify)
        self.assertIn("id: lane", verify.group(1))
        self.assertIn("npx tsx " + self.VERIFY, verify.group(1))
        self.assertRegex(build, r"(?m)^    outputs:\n      lane_config_digest: \$\{\{ steps\.lane\.outputs\.lane_config_digest \}\}$")
        self.assertNotIn("secrets.", build)

    def test_the_manifest_records_the_digest_of_the_stamped_file_and_still_one_artifact(self):
        manifest = job(self.text, "manifest")
        script = step_script(manifest, "Write the release manifest")
        self.assertRegex(script, r'--lane-config-digest "\$LANE_CONFIG_DIGEST"')
        self.assertIn("LANE_CONFIG_DIGEST: ${{ needs.build.outputs.lane_config_digest }}", manifest)
        self.assertRegex(script, r"\^sha256:\[0-9a-f\]\{64\}\$")
        self.assertEqual(script.count("--artifact "), 1)
        self.assertNotIn("--artifact-digest", script)
        # The release stays three assets: the digest travels inside the manifest.
        self.assertIn('"$EXE" "$EXE.sha256" release-manifest.json', step_script(job(self.text, "publish"), "Create the GitHub release"))

    def test_the_pilot_still_ships_no_update_configuration(self):
        self.assertIn("The installer ships no update configuration", self.text)
        self.assertIn("updater=none", self.text)


if __name__ == "__main__":
    unittest.main()
