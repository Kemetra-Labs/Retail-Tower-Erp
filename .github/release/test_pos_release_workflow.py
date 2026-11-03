"""RT-1082: static and step-level checks of release-pos.yml (the lab-signed POS installer release).

The workflow is policy class (root .github/), so its checks live here and run in
project-graph-selftest (`python -m unittest discover -s .github/release`), next to the Console and
ERP lab-path checks whose helpers are reused. The signing script itself,
apps/pos/scripts/lab/ci/release-lab-installer.ps1, is Windows-only and is proven by the workflow run.

The version gate of the resolve step is run for real with bash (CI is Linux; locally only when bash works).
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_console_lab_workflow import BASH, HAVE_BASH, WORKFLOWS, job, read, step_script, triggers  # noqa: E402

SECRETS = ("POS_LAB_SIGN_PFX_BASE64", "POS_LAB_SIGN_PFX_PASSWORD")


def step(text: str, name: str) -> str:
    """The whole step block (header and body) whose name starts with `name`."""
    match = re.search(rf"^      - name: {re.escape(name)}.*?\n(.*?)(?=^      - name: |\Z)", text, re.M | re.S)
    if not match:
        raise AssertionError(f"step {name} missing")
    return match.group(0)


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.test", *args],
                          cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


class ReleasePos(unittest.TestCase):
    text = read(WORKFLOWS / "release-pos.yml")

    def test_triggers_are_tag_push_and_dispatch_only(self):
        self.assertEqual(triggers(self.text), ["push", "workflow_dispatch"])
        self.assertRegex(self.text, r'(?m)^  push:\n    tags: \["pos/v\*"\]$')

    def test_every_action_is_pinned_by_sha(self):
        uses = re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", self.text, re.M)
        self.assertTrue(uses)
        for ref in uses:
            self.assertRegex(ref, r"^[\w./-]+@[0-9a-f]{40}$")

    def test_permissions_empty_at_the_top(self):
        self.assertRegex(self.text, r"(?m)^permissions: \{\}$")

    def test_inputs_never_expanded_inside_run_scripts(self):
        for block in re.findall(r"run: \|\n((?:          .*\n|\n)+)", self.text):
            self.assertNotIn("${{", block, block[:200])

    @unittest.skipUnless(HAVE_BASH, "bash not available")
    def test_resolve_refuses_a_tag_that_differs_from_package_json(self):
        script = step_script(self.text, "Resolve SHA, mode and tag")
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "apps" / "pos").mkdir(parents=True)
            git(repo, "init", "-q")
            (repo / "apps" / "pos" / "package.json").write_text(json.dumps({"version": "0.1.0"}), encoding="utf-8")
            git(repo, "add", "apps/pos/package.json")
            git(repo, "commit", "-q", "-m", "x")
            sha = git(repo, "rev-parse", "HEAD")
            git(repo, "update-ref", "refs/remotes/origin/main", sha)
            summary, output = repo / "summary.md", repo / "output.txt"

            def run(ref: str) -> subprocess.CompletedProcess:
                # Same environment the resolve step gets, with GITHUB_OUTPUT and the step summary in the temp dir.
                env = {"EVENT": "push", "REF": ref, "SHA": sha, "DRY_RUN": "",
                       "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)}
                return subprocess.run([BASH, "-c", script], cwd=repo, capture_output=True, text=True, check=False,
                                      env={"PATH": os.environ.get("PATH", ""), **env})

            refused = run("refs/tags/pos/v0.2.0")
            self.assertNotEqual(refused.returncode, 0)
            message = refused.stdout + refused.stderr
            self.assertIn("0.2.0", message)
            self.assertIn("0.1.0", message)
            self.assertFalse(output.exists() and output.read_text(encoding="utf-8"), "outputs written despite refusal")

            (repo / "apps" / "pos" / "package.json").write_text(json.dumps({"version": "0.2.0"}), encoding="utf-8")
            accepted = run("refs/tags/pos/v0.2.0")
            self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
            self.assertIn("tag=pos/v0.2.0", output.read_text(encoding="utf-8"))

    def test_resolve_checks_out_only_what_it_reads(self):
        block = step(job(self.text, "resolve"), "Checkout (history only")
        self.assertIn(".github/release", block)
        self.assertIn("apps/pos/package.json", block)

    def test_only_sign_release_mentions_secrets(self):
        for name in ("resolve", "build", "sign-dry-run", "manifest", "publish"):
            self.assertNotIn("secrets.", job(self.text, name), name)
        self.assertEqual(re.findall(r"secrets\.(\w+)", job(self.text, "env-probe")), ["RELEASE_ENV_PROBE"])
        sign = job(self.text, "sign-release")
        self.assertEqual(sorted(re.findall(r"secrets\.(\w+)", sign)), sorted(SECRETS))
        self.assertEqual(self.text.count("vars.POS_LAB_ROOT_SHA1"), 1)
        self.assertIn("vars.POS_LAB_ROOT_SHA1", sign)
        self.assertRegex(sign, r"(?m)^    environment: release-pos-sign$")
        self.assertRegex(sign, r"(?m)^    if: needs\.resolve\.outputs\.mode == 'release'$")

    def test_secrets_reach_only_the_one_step_that_runs_the_script(self):
        block = step(job(self.text, "sign-release"), "Sign and verify the installer")
        for name in SECRETS:
            self.assertEqual(block.count(f"secrets.{name}"), 1)
        self.assertIn("vars.POS_LAB_ROOT_SHA1", block)
        self.assertIn("shell: pwsh", block)
        self.assertIn("release-lab-installer.ps1 -Mode release", block)
        # Nothing else in the job (job env, other steps) sees them.
        sign = job(self.text, "sign-release")
        for name in (*SECRETS, "POS_LAB_ROOT_SHA1"):
            self.assertEqual(sign.count(name), block.count(name), name)

    def test_sign_dry_run_has_no_environment_and_no_secret(self):
        dry = job(self.text, "sign-dry-run")
        self.assertNotRegex(dry, r"(?m)^    environment:")
        self.assertNotIn("secrets", dry)
        self.assertNotIn("POS_LAB_SIGN", dry)
        self.assertRegex(dry, r"(?m)^    if: needs\.resolve\.outputs\.mode == 'dry-run'$")
        self.assertIn("release-lab-installer.ps1 -Mode dry-run", dry)

    def test_sign_jobs_run_on_windows_from_the_prebuilt_package(self):
        for name, mode in (("sign-dry-run", "dry-run"), ("sign-release", "release")):
            sign = job(self.text, name)
            self.assertRegex(sign, r"(?m)^    runs-on: windows-latest$")
            self.assertIn("needs: [resolve, build]", sign)
            self.assertIn(f"name: pos-unpacked-{mode}-${{{{ github.run_id }}}}", sign)
            self.assertIn(f"name: pos-installer-{mode}-${{{{ github.run_id }}}}", sign)
            self.assertIn("node-version-file: .nvmrc", sign)
            self.assertIn("persist-credentials: false", sign)
            self.assertNotIn(": write", sign)
        build = job(self.text, "build")
        self.assertIn("name: pos-unpacked-${{ needs.resolve.outputs.mode }}-${{ github.run_id }}", build)
        self.assertIn("apps/pos/dist-electron/win-unpacked", build)

    def test_secret_job_installs_without_scripts(self):
        for name in ("sign-release", "sign-dry-run"):
            sign = job(self.text, name)
            self.assertIn("npm ci --ignore-scripts", sign)
            self.assertNotRegex(sign, r"npm ci(?! --ignore-scripts)")
            cleanup = step(sign, "Remove the lab certificates")
            self.assertIn("if: always()", cleanup)
            self.assertIn("release-lab-installer.ps1 -Cleanup", cleanup)
            self.assertIn("shell: pwsh", cleanup)
            self.assertLess(sign.index("release-lab-installer.ps1 -Mode"), sign.index("release-lab-installer.ps1 -Cleanup"))

    def test_manifest_records_the_installer_blockmap_and_channel_file(self):
        manifest = job(self.text, "manifest")
        self.assertIn("always()", manifest)
        self.assertIn("needs.sign-dry-run.result == 'success'", manifest)
        self.assertIn("needs.sign-release.result == 'success'", manifest)
        script = step_script(manifest, "Write the release manifest")
        for name in ("pos-installer", "pos-blockmap", "pos-channel"):
            self.assertIn(f'--artifact "{name}=', script)
        self.assertNotIn("pos-win-unpacked", manifest)
        self.assertIn("signing=lab test certificate (RT-321 production signing not used)", script)

    def test_publish_is_protected_and_runs_no_repository_code(self):
        publish = job(self.text, "publish")
        self.assertRegex(publish, r"(?m)^    environment: release-pos$")
        self.assertRegex(publish, r"(?m)^    if: needs\.resolve\.outputs\.mode == 'release'$")
        self.assertIn("needs: [resolve, sign-release, manifest]", publish)
        self.assertNotIn("actions/checkout", publish)
        protect = step_script(publish, "Refuse unless the release environment is protected")
        self.assertIn("""'[{"name":"pos/v*","type":"tag"}]'""", protect)
        self.assertIn("required_reviewers", protect)
        self.assertIn("environments/release-pos", protect)
        self.assertIn("refusing to overwrite", step_script(publish, "Refuse if the release already exists"))
        create = step_script(publish, "Create the GitHub release")
        self.assertIn("repos/$REPO/commits/refs/tags/$TAG", create)
        self.assertIn('[ "$TAG_SHA" = "$SHA" ]', create)
        self.assertIn("--verify-tag", create)
        self.assertIn('--title "POS Pulse $TAG (LAB)"', create)
        self.assertIn("not for production", create)
        # Exactly the five assets are passed to gh release create (the continuation line after --notes).
        lines = create.splitlines()
        notes = next(i for i, line in enumerate(lines) if line.lstrip().startswith("--notes"))
        self.assertEqual(re.findall(r'"\$PKG/([^"]+)"', lines[notes + 1]),
                         ["$EXE", "$EXE.blockmap", "lab.yml", "$EXE.sha256", "release-manifest.json"])

    def test_publish_checks_the_package_against_the_manifest(self):
        script = step_script(job(self.text, "publish"), "Check the package against the manifest")
        self.assertIn('VERSION="${TAG#pos/v}"', script)
        for name in ("pos-installer", "pos-blockmap", "pos-channel"):
            self.assertIn(f'"{name}"', script)
        self.assertIn('.product == "pos"', script)
        self.assertIn("sha256sum", script)

    def test_publish_attests_the_installer(self):
        block = step(job(self.text, "publish"), "Attest build provenance")
        self.assertRegex(block, r"uses: actions/attest-build-provenance@[0-9a-f]{40}")
        self.assertRegex(block, r"subject-path: .*POS-Pulse-LAB-Setup-\*\.exe\n")
        self.assertIn("attestations: write", job(self.text, "publish"))

    def test_only_publish_has_write_scopes(self):
        for name in ("resolve", "build", "sign-dry-run", "sign-release", "manifest", "env-probe"):
            self.assertNotIn(": write", job(self.text, name), name)

    def test_env_probe_still_targets_release_pos(self):
        probe = job(self.text, "env-probe")
        self.assertRegex(probe, r"(?m)^    environment: release-pos$")
        self.assertIn("probe_environment", probe)


if __name__ == "__main__":
    unittest.main()
