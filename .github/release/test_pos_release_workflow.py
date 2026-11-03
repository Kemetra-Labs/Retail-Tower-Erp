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


def job_if(text: str) -> str:
    """The job-level `if:` expression (plain or folded `>-` block) joined into one line; '' when absent."""
    match = re.search(r"^    if: >-\n((?:      .*\n)+)", text, re.M) or re.search(r"^    if: (.*)\n", text, re.M)
    return " ".join(part.strip() for part in match.group(1).splitlines()) if match else ""


def needs_of(text: str) -> list[str]:
    match = re.search(r"^    needs: (?:\[(.*?)\]|(\S+))\n", text, re.M)
    if not match:
        return []
    return [n.strip() for n in (match.group(1) or match.group(2)).split(",")]


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
    def test_resolve_version_gate_and_package_json_read(self):
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

            def run(event: str, ref: str, dry_run: str) -> subprocess.CompletedProcess:
                # Same environment the resolve step gets, with GITHUB_OUTPUT and the step summary in the temp dir.
                output.unlink(missing_ok=True)
                summary.unlink(missing_ok=True)
                env = {"EVENT": event, "REF": ref, "SHA": sha, "DRY_RUN": dry_run,
                       "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)}
                return subprocess.run([BASH, "-c", script], cwd=repo, capture_output=True, text=True, check=False,
                                      env={"PATH": os.environ.get("PATH", ""), **env})

            def release(tag_version: str) -> subprocess.CompletedProcess:
                return run("push", f"refs/tags/pos/v{tag_version}", "")

            def dry_run() -> subprocess.CompletedProcess:
                return run("workflow_dispatch", "refs/heads/some-branch", "true")

            # A release tag that differs from package.json is refused and names both versions.
            refused = release("0.2.0")
            self.assertNotEqual(refused.returncode, 0)
            message = refused.stdout + refused.stderr
            self.assertIn("0.2.0", message)
            self.assertIn("0.1.0", message)
            self.assertFalse(output.exists() and output.read_text(encoding="utf-8"), "outputs written despite refusal")
            # A matching tag passes.
            accepted = release("0.1.0")
            self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
            self.assertIn("tag=pos/v0.1.0", output.read_text(encoding="utf-8"))
            # A dry-run with a readable package.json passes (no tag to compare) and reports the version it read.
            dry = dry_run()
            self.assertEqual(dry.returncode, 0, dry.stdout + dry.stderr)
            self.assertIn("mode=dry-run", output.read_text(encoding="utf-8"))
            self.assertIn("apps/pos version 0.1.0", summary.read_text(encoding="utf-8"))

            # An unreadable package.json fails in both modes: missing, not JSON, no version, not X.Y.Z.
            for label, content in (("missing", None), ("not json", "{"), ("no version", "{}"),
                                   ("not X.Y.Z", json.dumps({"version": "1.0"}))):
                if content is None:
                    (repo / package).unlink()
                else:
                    (repo / package).write_text(content, encoding="utf-8")
                for mode_name, result in (("release", release("0.1.0")), ("dry-run", dry_run())):
                    self.assertNotEqual(result.returncode, 0, f"{mode_name} passed with a {label} package.json")
                    self.assertIn("package.json", result.stdout + result.stderr, f"{mode_name}, {label}")

    def sparse_patterns(self) -> list[str]:
        block = step(job(self.text, "resolve"), "Checkout (history only")
        body = re.search(r"^          sparse-checkout: \|\n((?:            .*\n)+)", block, re.M).group(1)
        return [line.strip() for line in body.splitlines() if line.strip() and not line.strip().startswith("#")]

    def test_resolve_checks_out_only_what_it_reads(self):
        block = step(job(self.text, "resolve"), "Checkout (history only")
        # Non-cone mode: cone mode takes directories, and package.json is a single file.
        self.assertIn("sparse-checkout-cone-mode: false", block)
        self.assertEqual(self.sparse_patterns(), ["/.github/release/", "/apps/pos/package.json"])

    def test_the_sparse_checkout_patterns_yield_package_json_and_the_release_scripts(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            files = [".github/release/manifest.py", "apps/pos/package.json", "apps/pos/src/main.ts",
                     "apps/admin-console/package.json", "package.json"]
            for name in files:
                (repo / name).parent.mkdir(parents=True, exist_ok=True)
                (repo / name).write_text("x", encoding="utf-8")
            git(repo, "init", "-q")
            git(repo, "add", *files)
            git(repo, "commit", "-q", "-m", "x")
            git(repo, "sparse-checkout", "set", "--no-cone", *self.sparse_patterns())
            present = sorted(p.relative_to(repo).as_posix() for p in repo.rglob("*")
                             if p.is_file() and ".git" not in p.relative_to(repo).parts)
            self.assertEqual(present, [".github/release/manifest.py", "apps/pos/package.json"])

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
        condition = job_if(manifest)
        self.assertIn("always()", condition)
        self.assertIn("needs.resolve.result == 'success'", condition)
        self.assertIn("needs.build.result == 'success'", condition)
        # The sign job of THIS run's mode must have succeeded: a failed or cancelled one never leads to a manifest.
        self.assertIn("needs.resolve.outputs.mode == 'dry-run' && needs.sign-dry-run.result == 'success'", condition)
        self.assertIn("needs.resolve.outputs.mode == 'release' && needs.sign-release.result == 'success'", condition)
        script = step_script(manifest, "Write the release manifest")
        for name in ("pos-installer", "pos-blockmap", "pos-channel"):
            self.assertIn(f'--artifact "{name}=', script)
        self.assertNotIn("pos-win-unpacked", manifest)
        self.assertIn("signing=lab test certificate (RT-321 production signing not used)", script)

    def test_publish_is_protected_and_runs_no_repository_code(self):
        publish = job(self.text, "publish")
        self.assertRegex(publish, r"(?m)^    environment: release-pos$")
        self.assertIn("needs: [resolve, sign-release, manifest]", publish)
        # always() plus explicit results: sign-dry-run is skipped in release mode and is an ancestor through
        # manifest, so the implicit success() would skip publish on every real release.
        condition = job_if(publish)
        for part in ("always()", "needs.resolve.outputs.mode == 'release'", "needs.resolve.result == 'success'",
                     "needs.sign-release.result == 'success'", "needs.manifest.result == 'success'"):
            self.assertIn(part, condition)
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

    def test_no_job_downstream_of_a_mode_skipped_job_relies_on_the_implicit_success(self):
        names = re.findall(r"^  ([a-z][a-z0-9_-]*):\n", self.text.split("\njobs:\n", 1)[1], re.M)
        jobs = {name: job(self.text, name) for name in names}
        # A job whose own `if:` depends on the mode is skipped in some runs (a skipped job skips its dependents
        # under the implicit success(); always() in an upstream job does not carry downstream).
        skipped = {n for n, text in jobs.items() if "outputs.mode ==" in job_if(text) and "always()" not in job_if(text)}
        self.assertEqual(skipped, {"sign-dry-run", "sign-release"})
        downstream: set[str] = set()
        frontier = set(skipped)
        while frontier:
            frontier = {n for n, text in jobs.items() if n not in downstream and set(needs_of(text)) & frontier}
            downstream |= frontier
        self.assertEqual(downstream, {"manifest", "publish"})
        for name in sorted(downstream):
            condition = job_if(jobs[name])
            self.assertIn("always()", condition, f"{name} relies on the implicit success()")
            for need in needs_of(jobs[name]):
                self.assertIn(f"needs.{need}.result == 'success'", condition, f"{name} does not check {need}")

    def test_only_publish_has_write_scopes(self):
        for name in ("resolve", "build", "sign-dry-run", "sign-release", "manifest", "env-probe"):
            self.assertNotIn(": write", job(self.text, name), name)

    def test_env_probe_still_targets_release_pos(self):
        probe = job(self.text, "env-probe")
        self.assertRegex(probe, r"(?m)^    environment: release-pos$")
        self.assertIn("probe_environment", probe)


if __name__ == "__main__":
    unittest.main()
