"""RT-1082: static and step-level checks of release-pos.yml (the lab-signed POS installer release).

The workflow is policy class (root .github/), so its checks live here and run in
project-graph-selftest (`python -m unittest discover -s .github/release`), next to the Console and
ERP lab-path checks whose helpers are reused. The signing script itself,
apps/pos/scripts/lab/ci/release-lab-installer.ps1, is Windows-only; it is first proven by the post-merge dry-run on main (resolve refuses branch SHAs).

The version gate of the resolve step is run for real with bash (CI is Linux; locally only when bash works).
"""

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

try:  # optional: the release selftest installs nothing, so this check runs only where PyYAML exists
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_console_lab_workflow import BASH, HAVE_BASH, WORKFLOWS, job, read, run_step, step_script, triggers  # noqa: E402

SECRETS = ("POS_LAB_SIGN_PFX_BASE64", "POS_LAB_SIGN_PFX_PASSWORD")

# Stands in for `gh api repos/<repo>/environments/<name>[/deployment-branch-policies] [--jq EXPR]`, answering
# from env-<name>.json and policies-<name>.json in $FAKE_GH_DATA; a missing file is a 404.
FAKE_GH = """#!/usr/bin/env bash
set -euo pipefail
[ "$1" = api ] || exit 2
path="$2"; shift 2
expr=.
if [ "${1:-}" = --jq ]; then expr="$2"; fi
prefix=repos/o/r/environments/
case "$path" in
  "$prefix"*/deployment-branch-policies) name="${path#"$prefix"}"; name="${name%/deployment-branch-policies}"
    file="$FAKE_GH_DATA/policies-$name.json" ;;
  "$prefix"*) name="${path#"$prefix"}"; file="$FAKE_GH_DATA/env-$name.json" ;;
  *) exit 2 ;;
esac
[ -f "$file" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
jq -c "$expr" "$file"
"""


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

    @unittest.skipUnless(HAVE_BASH and shutil.which("jq"), "bash and jq are needed")
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

    def test_win_unpacked_upload_is_whole_and_outlasts_an_approval_delay(self):
        block = step(job(self.text, "build"), "Upload win-unpacked")
        self.assertIn("path: apps/pos/dist-electron/win-unpacked/", block)
        # upload-artifact skips dot-files unless told otherwise.
        self.assertRegex(block, r"(?m)^          include-hidden-files: true$")
        # An owner approval on release-pos-sign may take days; a 1-day artifact would expire first.
        self.assertRegex(block, r"(?m)^          retention-days: 7$")

    def test_release_installer_artifact_outlasts_the_publish_approval(self):
        block = step(job(self.text, "sign-release"), "Upload the installer")
        # publish downloads it only after the release-pos approval; keep it as long as the manifest.
        self.assertRegex(block, r"(?m)^          retention-days: 90$")

    def test_build_zips_the_package_under_its_versioned_name(self):
        # RT-1261: the zip is a release asset, named for the version, not the commit.
        script = step_script(job(self.text, "build"), "Zip the package")
        self.assertIn("require('./package.json').version", script)
        self.assertIn('"$out/$ZIP"', script)
        self.assertIn('ZIP="POS-Pulse-$VERSION-win-x64.zip"', script)
        self.assertNotIn("pos-win-unpacked", self.text)

    def test_package_artifact_outlasts_the_publish_approval_in_release_mode(self):
        block = step(job(self.text, "build"), "Upload the package")
        self.assertIn("name: pos-package-${{ needs.resolve.outputs.mode }}-${{ github.run_id }}", block)
        # publish reads it after the release-pos approval, like the installer; a dry-run keeps it 7 days.
        self.assertIn("retention-days: ${{ needs.resolve.outputs.mode == 'release' && 90 || 7 }}", block)

    def test_manifest_records_the_installer_blockmap_and_channel_file(self):
        manifest = job(self.text, "manifest")
        condition = job_if(manifest)
        # !cancelled(), not always(): cancelling the run must still stop it.
        self.assertTrue(condition.startswith("!cancelled() && "), condition)
        self.assertNotIn("always()", condition)
        self.assertIn("needs.resolve.result == 'success'", condition)
        self.assertIn("needs.build.result == 'success'", condition)
        # The sign job of THIS run's mode must have succeeded: a failed or cancelled one never leads to a manifest.
        self.assertIn("needs.resolve.outputs.mode == 'dry-run' && needs.sign-dry-run.result == 'success'", condition)
        self.assertIn("needs.resolve.outputs.mode == 'release' && needs.sign-release.result == 'success'", condition)
        script = step_script(manifest, "Write the release manifest")
        for name in ("pos-installer", "pos-blockmap", "pos-channel", "pos-package"):
            self.assertIn(f'--artifact "{name}=', script)
        self.assertIn("signing=lab test certificate (RT-321 production signing not used)", script)
        # RT-1261: the package zip of this run, and the digest of the app executable inside it.
        download = step(manifest, "Download the Windows package")
        self.assertIn("name: pos-package-${{ needs.resolve.outputs.mode }}-${{ github.run_id }}", download)
        self.assertIn('--note "app_exe_sha256=$APP_EXE_DIGEST"', script)
        self.assertIn("POS Pulse", script)

    @unittest.skipUnless(HAVE_BASH and shutil.which("unzip"), "bash and unzip are needed")
    def test_manifest_step_records_the_package_and_its_app_exe(self):
        script = step_script(job(self.text, "manifest"), "Write the release manifest")
        exe = "POS-Pulse-LAB-Setup-0.1.2.exe"
        # Stands in for `python3 .github/release/manifest.py ...`: records its arguments, one per line.
        fake_python = '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$ARGS_FILE"\nmkdir -p "$RUNNER_TEMP/manifest"\necho "{}" > "$RUNNER_TEMP/manifest/release-manifest.json"\n'

        def zipped(app: bytes, member: str = "POS Pulse.exe") -> bytes:
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as archive:
                archive.writestr(member, app)
            return buffer.getvalue()

        def run(package: dict[str, bytes]) -> tuple[subprocess.CompletedProcess, list[str]]:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                for folder in ("pkg", "package", "bin"):
                    (root / folder).mkdir()
                for name in (exe, f"{exe}.blockmap", "lab.yml"):
                    (root / "pkg" / name).write_bytes(b"x")
                for name, data in package.items():
                    (root / "package" / name).write_bytes(data)
                shim = root / "bin" / "python3"
                shim.write_text(fake_python, encoding="utf-8", newline="\n")
                shim.chmod(0o755)
                args_file = root / "args.txt"
                env = {"PATH": f"{(root / 'bin').as_posix()}{os.pathsep}{os.environ.get('PATH', '')}",
                       "RUNNER_TEMP": root.as_posix(), "ARGS_FILE": args_file.as_posix(),
                       "GITHUB_STEP_SUMMARY": (root / "summary.md").as_posix(),
                       "SHA": "f351186493df79c4fdd781ad7416594cf4eaac92", "MODE": "dry-run", "TAG": "",
                       "REPOSITORY": "o/r", "CI_URL": "https://example.test/run"}
                result = subprocess.run([BASH, "-c", script], capture_output=True, text=True, check=False, env=env)
                args = args_file.read_text(encoding="utf-8").splitlines() if args_file.exists() else []
                return result, args

        good, args = run({"POS-Pulse-0.1.2-win-x64.zip": zipped(b"app")})
        self.assertEqual(good.returncode, 0, good.stdout + good.stderr)
        self.assertTrue(any(a.startswith("pos-package=") and a.endswith("/package/POS-Pulse-0.1.2-win-x64.zip")
                            for a in args), args)
        self.assertIn("app_exe_sha256=sha256:" + hashlib.sha256(b"app").hexdigest(), args)
        for label, package in (
            ("no zip", {}),
            ("a zip for another version", {"POS-Pulse-0.1.1-win-x64.zip": zipped(b"app")}),
            ("an extra file", {"POS-Pulse-0.1.2-win-x64.zip": zipped(b"app"), "x.txt": b"x"}),
            ("no POS Pulse.exe at the root", {"POS-Pulse-0.1.2-win-x64.zip": zipped(b"app", "sub/POS Pulse.exe")}),
        ):
            refused, refused_args = run(package)
            self.assertNotEqual(refused.returncode, 0, f"the manifest step accepted {label}")
            self.assertEqual(refused_args, [], f"manifest.py ran despite {label}")

    def test_publish_is_protected_and_runs_no_repository_code(self):
        publish = job(self.text, "publish")
        self.assertRegex(publish, r"(?m)^    environment: release-pos$")
        self.assertIn("needs: [resolve, sign-release, manifest]", publish)
        # !cancelled() plus explicit results: sign-dry-run is skipped in release mode and is an ancestor through
        # manifest, so the implicit success() would skip publish on every real release. Not always(): cancelling
        # the run must stop an approved publish.
        condition = job_if(publish)
        self.assertTrue(condition.startswith("!cancelled() && "), condition)
        self.assertNotIn("always()", condition)
        for part in ("needs.resolve.outputs.mode == 'release'", "needs.resolve.result == 'success'",
                     "needs.sign-release.result == 'success'", "needs.manifest.result == 'success'"):
            self.assertIn(part, condition)
        self.assertNotIn("actions/checkout", publish)
        protect = step_script(publish, "Refuse unless the release environments are protected")
        self.assertIn("""'[{"name":"pos/v*","type":"tag"}]'""", protect)
        self.assertIn("required_reviewers", protect)
        self.assertIn('repos/$REPO/environments/$name"', protect)
        # Both environments are checked: release-pos with a required reviewer, release-pos-sign (the PFX holder)
        # for its tag-only policy, the reviewer being optional there (spec C-7).
        self.assertEqual(re.findall(r"(?m)^check_env (\S+) (\S+)$", protect),
                         [("release-pos", "required"), ("release-pos-sign", "optional")])
        self.assertIn("refusing to overwrite", step_script(publish, "Refuse if the release already exists"))
        create = step_script(publish, "Create the GitHub release")
        self.assertIn("repos/$REPO/commits/refs/tags/$TAG", create)
        self.assertIn('[ "$TAG_SHA" = "$SHA" ]', create)
        self.assertIn("--verify-tag", create)
        self.assertIn('--title "POS Pulse $TAG (LAB)"', create)
        self.assertIn("not for production", create)
        # Exactly the six assets are passed to gh release create (the continuation line after --notes).
        lines = create.splitlines()
        notes = next(i for i, line in enumerate(lines) if line.lstrip().startswith("--notes"))
        self.assertEqual(re.findall(r'"\$PKG/([^"]+)"', lines[notes + 1]),
                         ["$EXE", "$EXE.blockmap", "lab.yml", "$EXE.sha256", "release-manifest.json", "$ZIP"])
        self.assertIn('ZIP="POS-Pulse-$VERSION-win-x64.zip"', create)
        self.assertIn("unsigned", create)

    @unittest.skipUnless(HAVE_BASH and shutil.which("jq"), "bash and jq are needed")
    def test_publish_refuses_unless_both_environments_are_protected(self):
        script = step_script(job(self.text, "publish"), "Refuse unless the release environments are protected")
        reviewed = {"protection_rules": [{"type": "required_reviewers", "reviewers": [{"type": "User"}]}],
                    "deployment_branch_policy": {"custom_branch_policies": True}}
        unreviewed = {"protection_rules": [], "deployment_branch_policy": {"custom_branch_policies": True}}
        open_env = {"protection_rules": [], "deployment_branch_policy": None}
        tag_only = {"branch_policies": [{"id": 1, "name": "pos/v*", "type": "tag"}]}
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            bindir = data / "bin"
            bindir.mkdir()
            gh = bindir / "gh"
            gh.write_text(FAKE_GH, encoding="utf-8", newline="\n")
            gh.chmod(0o755)

            def run(envs: dict, policies: dict) -> subprocess.CompletedProcess:
                for old in data.glob("*.json"):
                    old.unlink()
                for name, body in envs.items():
                    (data / f"env-{name}.json").write_text(json.dumps(body), encoding="utf-8")
                for name, body in policies.items():
                    (data / f"policies-{name}.json").write_text(json.dumps(body), encoding="utf-8")
                env = {"PATH": f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}", "REPO": "o/r",
                       "FAKE_GH_DATA": data.as_posix()}
                return subprocess.run([BASH, "-c", script], capture_output=True, text=True, check=False, env=env)

            good_policies = {"release-pos": tag_only, "release-pos-sign": tag_only}
            ok = run({"release-pos": reviewed, "release-pos-sign": unreviewed}, good_policies)
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            # A reviewer on release-pos-sign is allowed too.
            ok = run({"release-pos": reviewed, "release-pos-sign": reviewed}, good_policies)
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)

            refusals = {
                "release-pos-sign missing (a job naming it would create it unprotected)":
                    ({"release-pos": reviewed}, {"release-pos": tag_only}, "cannot read the release-pos-sign"),
                "release-pos-sign without a deployment policy":
                    ({"release-pos": reviewed, "release-pos-sign": open_env}, good_policies,
                     "release-pos-sign has no custom deployment policy"),
                "release-pos-sign admits a branch":
                    ({"release-pos": reviewed, "release-pos-sign": unreviewed},
                     {"release-pos": tag_only,
                      "release-pos-sign": {"branch_policies": [{"name": "main", "type": "branch"}]}},
                     "release-pos-sign must admit exactly the tag pattern pos/v*"),
                "release-pos-sign admits pos/v* and more":
                    ({"release-pos": reviewed, "release-pos-sign": unreviewed},
                     {"release-pos": tag_only, "release-pos-sign": {"branch_policies": [
                         {"name": "pos/v*", "type": "tag"}, {"name": "*", "type": "tag"}]}},
                     "release-pos-sign must admit exactly the tag pattern pos/v*"),
                "release-pos without a reviewer":
                    ({"release-pos": unreviewed, "release-pos-sign": unreviewed}, good_policies,
                     "release-pos has no required reviewer"),
            }
            for label, (envs, policies, message) in refusals.items():
                refused = run(envs, policies)
                self.assertNotEqual(refused.returncode, 0, label)
                self.assertIn(message, refused.stdout + refused.stderr, label)

    @unittest.skipUnless(yaml, "PyYAML is not installed")
    def test_conditions_load_as_expressions_starting_with_not_cancelled(self):
        # A folded scalar starting with `!` must stay a string, not become a YAML tag.
        jobs = yaml.safe_load(self.text)["jobs"]
        for name in ("manifest", "publish"):
            self.assertIsInstance(jobs[name]["if"], str)
            self.assertTrue(jobs[name]["if"].startswith("!cancelled() && "), name)

    def test_publish_checks_the_package_against_the_manifest(self):
        script = step_script(job(self.text, "publish"), "Check the package against the manifest")
        self.assertIn('VERSION="${TAG#pos/v}"', script)
        for name in ("pos-installer", "pos-blockmap", "pos-channel", "pos-package"):
            self.assertIn(f'"{name}"', script)
        self.assertIn('.product == "pos"', script)
        self.assertIn("sha256sum", script)
        self.assertIn("(.artifacts | length == 4)", script)
        self.assertIn(".notes.app_exe_sha256 == $app_exe", script)

    def test_publish_downloads_the_package_this_run_built(self):
        publish = job(self.text, "publish")
        block = step(publish, "Download the Windows package")
        self.assertIn("name: pos-package-release-${{ github.run_id }}", block)
        self.assertIn("path: ${{ runner.temp }}/pkg", block)
        # Downloaded before the check, which runs before the attestation and the release.
        order = ["- name: Download the Windows package", "- name: Check the package against the manifest",
                 "- name: Attest build provenance", "- name: Create the GitHub release"]
        positions = [publish.index(name) for name in order]
        self.assertEqual(positions, sorted(positions))

    def test_publish_attests_the_installer_and_the_package(self):
        block = step(job(self.text, "publish"), "Attest build provenance")
        self.assertRegex(block, r"uses: actions/attest-build-provenance@[0-9a-f]{40}")
        paths = re.search(r"subject-path: \|\n((?:            .*\n)+)", block)
        self.assertIsNotNone(paths, "subject-path must list one path per line")
        self.assertEqual([line.strip() for line in paths.group(1).splitlines()],
                         ["${{ runner.temp }}/pkg/POS-Pulse-LAB-Setup-*.exe",
                          "${{ runner.temp }}/pkg/POS-Pulse-*-win-x64.zip"])
        self.assertIn("attestations: write", job(self.text, "publish"))

    @unittest.skipUnless(HAVE_BASH and shutil.which("jq") and shutil.which("unzip"), "bash, jq and unzip are needed")
    def test_publish_check_binds_the_package_and_its_app_exe_to_the_manifest(self):
        script = step_script(job(self.text, "publish"), "Check the package against the manifest")
        sha = "f351186493df79c4fdd781ad7416594cf4eaac92"
        exe, zip_name = "POS-Pulse-LAB-Setup-0.1.2.exe", "POS-Pulse-0.1.2-win-x64.zip"

        def digest(data: bytes) -> str:
            return "sha256:" + hashlib.sha256(data).hexdigest()

        def zipped(app: bytes, member: str = "POS Pulse.exe") -> bytes:
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as archive:
                archive.writestr(member, app)
                archive.writestr("resources/app.asar", b"asar")
            return buffer.getvalue()

        files = {exe: b"installer", f"{exe}.blockmap": b"blockmap", "lab.yml": b"version: 0.1.2\n",
                 zip_name: zipped(b"app")}

        def manifest_for(package: dict[str, bytes], app_exe: str = digest(b"app"), artifacts: int = 4) -> dict:
            names = {exe: "pos-installer", f"{exe}.blockmap": "pos-blockmap", "lab.yml": "pos-channel",
                     zip_name: "pos-package"}
            entries = [{"name": names[name], "file": name, "digest": digest(data)}
                       for name, data in package.items() if name in names]
            return {"product": "pos", "mode": "release", "tag": "pos/v0.1.2", "source": {"sha": sha},
                    "artifacts": entries[:artifacts], "notes": {"app_exe_sha256": app_exe}}

        def run(package: dict[str, bytes], manifest: dict) -> subprocess.CompletedProcess:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                (root / "pkg").mkdir()
                (root / "manifest").mkdir()
                for name, data in package.items():
                    (root / "pkg" / name).write_bytes(data)
                (root / "manifest" / "release-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                result = run_step(script, {"TAG": "pos/v0.1.2", "SHA": sha, "RUNNER_TEMP": root.as_posix()})
                if result.returncode == 0:
                    published = sorted(p.name for p in (root / "pkg").iterdir())
                    self.assertEqual(published, sorted([*package, f"{exe}.sha256", "release-manifest.json"]))
                return result

        ok = run(files, manifest_for(files))
        self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
        altered = {**files, zip_name: zipped(b"other app")}
        renamed = {k if k != zip_name else "pos-win-unpacked-0123456789ab.zip": v for k, v in files.items()}
        missing = {k: v for k, v in files.items() if k != zip_name}
        refusals = {
            "a zip that is not the one the manifest recorded": (altered, manifest_for(files)),
            "a renamed zip": (renamed, manifest_for(files)),
            "no zip": (missing, manifest_for(files)),
            "an extra file": ({**files, "extra.txt": b"x"}, manifest_for(files)),
            "a manifest without the package": (files, manifest_for(files, artifacts=3)),
            "an app exe that is not the recorded one": (files, manifest_for(files, app_exe=digest(b"other"))),
            "a package without POS Pulse.exe at its root":
                ({**files, zip_name: zipped(b"app", "app/POS Pulse.exe")},
                 manifest_for({**files, zip_name: zipped(b"app", "app/POS Pulse.exe")})),
        }
        for label, (package, manifest) in refusals.items():
            self.assertNotEqual(run(package, manifest).returncode, 0, f"publish accepted {label}")

    def test_no_job_downstream_of_a_mode_skipped_job_relies_on_the_implicit_success(self):
        names = re.findall(r"^  ([a-z][a-z0-9_-]*):\n", self.text.split("\njobs:\n", 1)[1], re.M)
        jobs = {name: job(self.text, name) for name in names}
        # A job whose own `if:` depends on the mode is skipped in some runs (a skipped job skips its dependents
        # under the implicit success(); always() in an upstream job does not carry downstream).
        skipped = {n for n, text in jobs.items()
                   if "outputs.mode ==" in job_if(text) and not job_if(text).startswith("!cancelled()")}
        self.assertEqual(skipped, {"sign-dry-run", "sign-release"})
        downstream: set[str] = set()
        frontier = set(skipped)
        while frontier:
            frontier = {n for n, text in jobs.items() if n not in downstream and set(needs_of(text)) & frontier}
            downstream |= frontier
        self.assertEqual(downstream, {"manifest", "publish"})
        for name in sorted(downstream):
            condition = job_if(jobs[name])
            # !cancelled() replaces the implicit success() without always()'s "even when cancelled".
            self.assertTrue(condition.startswith("!cancelled() && "), f"{name} relies on the implicit success()")
            self.assertNotIn("always()", condition, f"{name} would keep running after a cancel")
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
