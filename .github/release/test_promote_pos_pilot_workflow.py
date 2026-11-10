"""RT-1300: static and step-level checks of promote-pos-pilot.yml, the promotion of a pilot release.

The workflow is policy class (root .github/), so its checks live here and run in project-graph-selftest
(`python -m unittest discover -s .github/release`), next to the pilot release checks whose helpers are reused.

What is pinned, job by job. It can be started only by hand, and `dry_run` defaults to true. `resolve` and `verify`
hold no environment, no secret, no AWS and no id-token in either mode: the release it reads must be a pilot release
on a tag that is on main, the assets are exactly the three the pilot release publishes, the manifest and the
attestation bind them to the tag's commit, and the installer's signature is checked against a pinned leaf. Only
when a person turns `dry_run` off do two more jobs run, and they are the only ones with an environment or an
id-token: `upload` (checks everything first, then one conditional, checksummed PutObject, and builds the
registration body once) and `register` (one OIDC-authenticated POST; it never activates). The bash steps run for
real, with stub `gh`, `aws` and `curl`; the PowerShell step is only parsed here, because it adds a certificate to
the machine's trust store and so runs on a hosted runner only.
"""

import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import sys

try:  # optional: the release selftest installs nothing, so the parse check runs only where PyYAML exists
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_console_lab_workflow import BASH, HAVE_BASH, ROOT, WORKFLOWS, job, read, step_script, triggers  # noqa: E402
from test_pos_pilot_release_workflow import LAB_NAMES, code  # noqa: E402
from test_pos_release_workflow import git, needs_of, step  # noqa: E402

WORKFLOW = WORKFLOWS / "promote-pos-pilot.yml"
SUBJECT = "CN=Kemetra POS PILOT"
TAG = "pos-pilot/v0.1.0"
VERSION = "0.1.0"
EXE = f"POS-Pulse-Setup-{VERSION}.exe"
SHA = "a" * 40
LEAF = "AB" * 20
REPO = "Kemetra-Labs/Retail-Tower-Erp"
# What the two jobs that run in a dry run too (resolve, verify) must never hold: a credential, an environment, a
# write to S3 or to Backend-Core, or a way to publish anything.
NEVER_IN_THE_VERIFY_JOBS = (
    "id-token", "environment:", "secrets.", "aws-actions", "configure-aws-credentials", "aws s3", "PutObject",
    "put-object", "AWS_", "attestations: write", "contents: write", "/api/v1/", "Idempotency-Key", "Bearer",
    "gh release create", "gh release upload", "git push",
)
ENVIRONMENT = "release-pos-pilot-promote"
STUB_GH = """
gh() {
  printf '%s\\n' "$*" >> "$GH_LOG"
  case "$1 $2" in
    "release view") cat "$FAKE_VIEW" ;;
    "release download")
      dir=""
      while [ "$#" -gt 0 ]; do if [ "$1" = "--dir" ]; then dir="$2"; fi; shift; done
      cp "$FAKE_ASSETS"/* "$dir"/ ;;
    "attestation verify") exit "${FAKE_ATTEST_EXIT:-0}" ;;
    "api repos/"*) printf '%s
' "${FAKE_TAG_SHA:-}" ;;
    *) echo "unexpected gh $*" >&2; exit 9 ;;
  esac
}
"""


def run_bash(script: str, env: dict[str, str], cwd: Path | None = None, preamble: str = "") -> subprocess.CompletedProcess:
    """Runs a step script under bash with exactly this environment (plus PATH), as Actions would."""
    return subprocess.run([BASH, "-c", preamble + "\n" + script], cwd=cwd, capture_output=True, text=True, check=False,
                          env={"PATH": os.environ.get("PATH", ""), **env})


def runner_temp(tmp: Path) -> str:
    """RUNNER_TEMP as the platform has it: on a hosted Windows runner it holds backslashes (a drive path), which
    GNU sha256sum escapes in its output, so a check that parses that output must be proven on such a path."""
    return str(tmp) if sys.platform == "win32" else tmp.as_posix()


def manifest(**changes) -> dict:
    """A manifest the checks must accept; each keyword replaces one top-level field."""
    base = {"product": "pos-pilot", "signing": "pilot", "mode": "release", "tag": TAG, "source": {"repository": REPO, "sha": SHA},
            "ci_url": f"https://github.com/{REPO}/actions/runs/777/attempts/2",
            "artifacts": [{"name": "pos-installer", "file": EXE, "digest": "sha256:" + hashlib.sha256(b"installer bytes").hexdigest()}]}
    base.update(changes)
    return base


class PromotePosPilotStatic(unittest.TestCase):
    text = read(WORKFLOW)

    @unittest.skipUnless(yaml, "PyYAML is needed")
    def test_the_file_is_valid_yaml_with_the_four_jobs(self):
        # A plain scalar such as a job name must not hold ": " (the project-graph privilege scan refuses the file).
        document = yaml.safe_load(self.text)
        self.assertEqual(list(document["jobs"]), ["resolve", "verify", "upload", "register"])
        for name in ("resolve", "verify", "upload", "register"):
            self.assertIsInstance(document["jobs"][name]["name"], str)

    def test_the_run_must_be_on_main_and_the_runbook_says_so_and_takes_the_pin_from_the_protected_environment(self):
        resolve = job(self.text, "resolve")
        self.assertIn("REF: ${{ github.ref }}", step(resolve, "Resolve the tag and the leaf pin"))
        self.assertIn('[ "$REF" = refs/heads/main ]', step_script(resolve, "Resolve the tag and the leaf pin"))
        doc = read(ROOT / "services/backend-core/docs/operations/pos-pilot-release-bucket.md")
        section = doc.split("## 8. Verifying a pilot release before promotion", 1)[1]
        self.assertNotIn("any ref", section)
        self.assertIn("from `main`", section)
        pin = section.split("`leaf_sha1`", 1)[1].split("**What it checks", 1)[0]
        self.assertIn("POS_PILOT_LEAF_SHA1", pin)
        self.assertIn("not from the output of the signing run", pin)

    def test_it_is_started_by_hand_only(self):
        self.assertEqual(triggers(self.text), ["workflow_dispatch"])
        self.assertNotIn("pull_request", code(self.text))
        inputs = re.findall(r"^      ([a-z_0-9]+):$", re.search(r"workflow_dispatch:\n    inputs:\n((?:      .*\n|        .*\n)+)", self.text).group(1), re.M)
        self.assertEqual(inputs, ["tag", "leaf_sha1", "dry_run"])

    def test_every_action_is_pinned_by_sha_and_already_pinned_by_the_pilot_release_or_the_lab_deploys(self):
        pilot = read(WORKFLOWS / "release-pos-pilot.yml")
        lab = read(WORKFLOWS / "deploy-lab.yml")
        known = set(re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", pilot, re.M))
        # The one AWS action is the build the lab deploys already assume their role with, not a new pin.
        lab_aws = {ref for ref in re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", lab, re.M) if ref.startswith("aws-actions/configure-aws-credentials@")}
        self.assertEqual(len(lab_aws), 1)
        for ref in re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", self.text, re.M):
            self.assertRegex(ref, r"^[\w./-]+@[0-9a-f]{40}$")
            self.assertIn(ref, known | lab_aws, f"{ref} is pinned by neither release-pos-pilot.yml nor deploy-lab.yml")

    def test_the_two_jobs_that_run_in_a_dry_run_too_hold_no_credential_and_no_way_to_publish(self):
        for name in ("resolve", "verify"):
            body = code(job(self.text, name))
            for word in NEVER_IN_THE_VERIFY_JOBS:
                self.assertNotIn(word, body, f"{name}: {word}")
            self.assertEqual(len(re.findall(r"^    environment:", body, re.M)), 0, name)

    def test_the_token_is_read_only_everywhere(self):
        self.assertRegex(self.text, r"(?m)^permissions: \{\}$")
        for name in ("resolve", "verify"):
            block = re.search(r"^    permissions:\n((?:      .*\n)+)", job(self.text, name) + "\n", re.M)
            self.assertIsNotNone(block, name)
            self.assertEqual([re.sub(r"\s+#.*$", "", line.strip()) for line in block.group(1).splitlines()], ["contents: read"], name)

    def test_inputs_are_never_expanded_inside_a_run_script(self):
        for block in re.findall(r"run: \|\n((?:          .*\n|\n)+)", self.text):
            self.assertNotIn("${{", block, block[:200])

    def test_every_checkout_drops_the_token(self):
        checkouts = re.findall(r"uses: actions/checkout@", self.text)
        self.assertEqual(len(checkouts), 1)
        self.assertEqual(len(re.findall(r"persist-credentials: false", self.text)), 1)
        self.assertIn("fetch-depth: 0", self.text)

    def test_no_lab_or_production_name_appears_anywhere(self):
        for name in LAB_NAMES:
            self.assertNotIn(name, self.text + "\n", name)
        self.assertNotIn("refs/tags/pos/v", self.text)
        self.assertNotIn("release-pos-pilot-sign", code(self.text))

    def test_one_run_per_tag_and_a_running_one_is_never_cancelled(self):
        self.assertRegex(self.text, r"(?m)^concurrency:\n  group: promote-pos-pilot-\$\{\{ inputs\.tag \}\}\n  cancel-in-progress: false$")

    def test_verify_waits_for_resolve_and_runs_on_windows(self):
        self.assertEqual(needs_of(job(self.text, "verify")), ["resolve"])
        self.assertRegex(job(self.text, "verify"), r"runs-on: windows-latest")
        self.assertRegex(job(self.text, "verify"), r"defaults:\n      run:\n        shell: bash")

    def test_the_attestation_is_bound_to_the_repository_the_signer_workflow_and_the_tags_commit(self):
        script = step_script(job(self.text, "verify"), "Verify the build provenance")
        for part in ('--repo "$REPO"', '--signer-workflow "$REPO/.github/workflows/release-pos-pilot.yml"',
                     '--source-digest "$SHA"', '--source-ref "refs/tags/$TAG"', "--deny-self-hosted-runners"):
            self.assertIn(part, script)
        self.assertIn('"$PKG/$EXE"', script)

    def test_the_signature_step_pins_the_leaf_before_it_trusts_anything_and_cleans_up_always(self):
        verify = job(self.text, "verify")
        sign = step(verify, "Verify the Authenticode signature")
        self.assertIn("shell: pwsh", sign)
        script = step_script(verify, "Verify the Authenticode signature")
        self.assertIn(f"'{SUBJECT}'", script)
        self.assertLess(script.index("$leaf.Thumbprint -ne $pin"), script.index("X509Store"))
        self.assertLess(script.index("-cne 'CN=Kemetra POS PILOT'"), script.index("X509Store"))
        self.assertIn("[byte[]]$leaf.RawData", script, "only the public bytes of the leaf may be added to the store")
        self.assertIn("$checked.Status -ne 'Valid'", script)
        self.assertIn("TimeStamperCertificate", script)
        cleanup = step(verify, "Remove the pilot trust")
        self.assertRegex(cleanup, r"if: always\(\)")
        self.assertIn("Cert:\\LocalMachine\\Root\\$env:LEAF_SHA1", step_script(verify, "Remove the pilot trust"))
        self.assertLess(verify.index("name: Verify the Authenticode signature"), verify.index("name: Remove the pilot trust"))

    def test_the_signature_step_checks_every_link_of_the_pin_and_the_store_it_cleans(self):
        verify = job(self.text, "verify")
        script = step_script(verify, "Verify the Authenticode signature")
        for part in ("$ErrorActionPreference = 'Stop'", "if ($null -eq $leaf)", "$leaf.Issuer -cne $leaf.Subject",
                     "X509Store('Root', 'LocalMachine')", "$checked.SignerCertificate.Thumbprint -ne $pin",
                     'Join-Path $env:RUNNER_TEMP "pkg/POS-Pulse-Setup-$($env:VERSION).exe"'):
            self.assertIn(part, script)
        self.assertEqual(script.count("X509Store("), 1, "one store, the one the cleanup removes from")
        cleanup = step_script(verify, "Remove the pilot trust")
        self.assertIn("Cert:\\LocalMachine\\Root\\$env:LEAF_SHA1", cleanup)
        self.assertIn("still in the trust store", cleanup, "the removal is read back, not assumed")

    def test_the_token_is_set_per_step_only_and_the_attestation_also_pins_the_signer_commit(self):
        verify = job(self.text, "verify")
        job_env = verify.split("    steps:")[0]
        self.assertNotIn("GH_TOKEN", code(job_env), "a comment may name the variable; the job env may not set it")
        for name in ("Download the release assets", "Verify the build provenance"):
            self.assertIn("GH_TOKEN: ${{ github.token }}", step(verify, name))
        for name in ("Check the assets against the manifest", "Verify the Authenticode signature", "Dry-run result"):
            self.assertNotIn("GH_TOKEN", step(verify, name), name)
        self.assertIn('--signer-digest "$SHA"', step_script(verify, "Verify the build provenance"))
        download = step_script(verify, "Download the release assets")
        self.assertIn('--repo "$REPO"', download)
        self.assertIn("command -v", download, "a missing tool fails with a named error, not a cryptic one")
        self.assertIn("for tool in jq sha256sum gh; do command -v", download)

    def test_the_steps_run_in_the_order_that_never_trusts_before_it_has_checked(self):
        names = re.findall(r"^      - name: (.+)$", job(self.text, "verify"), re.M)
        self.assertEqual(names, [
            "Download the release assets", "Check the assets against the manifest", "Verify the build provenance",
            "Verify the Authenticode signature", "Remove the pilot trust", "Dry-run result",
        ])

    def test_the_object_key_is_the_one_the_api_derives(self):
        rows = read(ROOT / "services/backend-core/apps/api/src/pos-pilot-releases/pilot-release-registry.rows.ts")
        self.assertIn("`pos/pilot/${version}/POS-Pulse-Setup-${version}.exe`", rows)
        self.assertIn("pos/pilot/${VERSION}/${EXE}", step_script(job(self.text, "verify"), "Dry-run result"))
        # The live upload writes to the very key the api derives (and the dry run announces).
        self.assertIn('KEY="pos/pilot/$VERSION/$EXE"', step_script(job(self.text, "upload"), "Upload the installer once (conditional write)"))

    @unittest.skipUnless(shutil.which("pwsh"), "pwsh is needed")
    def test_the_powershell_steps_parse(self):
        verify = job(self.text, "verify")
        checker = (
            "param($Path) $e = $null; $t = $null; "
            "[void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$t, [ref]$e); "
            "if ($e) { $e | ForEach-Object { $_.Message }; exit 1 }"
        )
        with tempfile.TemporaryDirectory() as tmp:
            check = Path(tmp) / "check.ps1"
            check.write_text(checker, encoding="utf-8")
            for name in ("Verify the Authenticode signature", "Remove the pilot trust"):
                target = Path(tmp) / "step.ps1"
                target.write_text(step_script(verify, name), encoding="utf-8")
                result = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-File", str(check), str(target)],
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 0, name + result.stdout + result.stderr)


@unittest.skipUnless(HAVE_BASH and shutil.which("jq") and shutil.which("sha256sum"), "bash, jq and sha256sum are needed")
class PromotePosPilotSteps(unittest.TestCase):
    text = read(WORKFLOW)

    def test_resolve_accepts_only_a_pilot_tag_on_main_and_a_forty_hex_pin(self):
        script = step_script(job(self.text, "resolve"), "Resolve the tag and the leaf pin")
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init", "-q")
            (repo / "a.txt").write_text("a", encoding="utf-8")
            git(repo, "add", "a.txt")
            git(repo, "commit", "-q", "-m", "a")
            on_main = git(repo, "rev-parse", "HEAD")
            git(repo, "update-ref", "refs/remotes/origin/main", on_main)
            git(repo, "tag", TAG)
            git(repo, "tag", "-a", "-m", "annotated", "pos-pilot/v0.2.0")
            (repo / "b.txt").write_text("b", encoding="utf-8")
            git(repo, "add", "b.txt")
            git(repo, "commit", "-q", "-m", "b")
            git(repo, "tag", "pos-pilot/v0.3.0")
            git(repo, "tag", "pos/v0.1.0", on_main)
            output, summary = repo / "out.txt", repo / "summary.md"

            def run(tag: str, leaf: str = LEAF, ref: str = "refs/heads/main") -> subprocess.CompletedProcess:
                output.unlink(missing_ok=True)
                summary.unlink(missing_ok=True)
                return run_bash(script, {"TAG": tag, "LEAF_SHA1": leaf, "REF": ref, "GITHUB_OUTPUT": str(output),
                                         "GITHUB_STEP_SUMMARY": str(summary)}, cwd=repo)

            ok = run(TAG)
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            written = output.read_text(encoding="utf-8")
            for line in (f"sha={on_main}", f"tag={TAG}", f"version={VERSION}", f"leaf={LEAF}"):
                self.assertIn(line, written)
            lower = run(TAG, LEAF.lower())
            self.assertEqual(lower.returncode, 0, lower.stdout + lower.stderr)
            self.assertIn(f"leaf={LEAF}", output.read_text(encoding="utf-8"), "the pin is compared upper-case")
            annotated = run("pos-pilot/v0.2.0")
            self.assertEqual(annotated.returncode, 0, annotated.stdout + annotated.stderr)
            self.assertIn(f"sha={on_main}", output.read_text(encoding="utf-8"), "an annotated tag resolves to its commit")
            refused = {
                "a tag on a commit that is not on main": run("pos-pilot/v0.3.0"),
                "a tag that does not exist": run("pos-pilot/v9.9.9"),
                "a lab tag": run("pos/v0.1.0"),
                "a release candidate suffix": run("pos-pilot/v0.1.0-rc1"),
                "a look-alike product": run("pos-pilot-x/v0.1.0"),
                "a prefix": run("xpos-pilot/v0.1.0"),
                "a branch name": run("main"),
                "an empty tag": run(""),
                "a short pin": run(TAG, "AB" * 19),
                "a non-hex pin": run(TAG, "G" * 40),
                "an empty pin": run(TAG, ""),
                "a development branch": run(TAG, ref="refs/heads/some-branch"),
                "a look-alike of main": run(TAG, ref="refs/heads/main-copy"),
                "a tag ref": run(TAG, ref=f"refs/tags/{TAG}"),
                "no ref": run(TAG, ref=""),
            }
            for label, result in refused.items():
                self.assertNotEqual(result.returncode, 0, label)
            self.assertIn("not on main", refused["a tag on a commit that is not on main"].stdout)

    def assets(self, tmp: Path, view: dict | None = None, payload: bytes = b"installer bytes", with_sha: bool = True) -> dict:
        """Lays out a fake release: the assets the stub downloads, and the JSON its `release view` prints."""
        assets = tmp / "assets"
        assets.mkdir()
        (assets / EXE).write_bytes(payload)
        if with_sha:
            (assets / f"{EXE}.sha256").write_text(f"{hashlib.sha256(payload).hexdigest()}  {EXE}\n", encoding="utf-8")
        (assets / "release-manifest.json").write_text(json.dumps(manifest()), encoding="utf-8")
        shown = view if view is not None else {
            "tagName": TAG, "isDraft": False, "isPrerelease": False,
            "assets": [{"name": EXE}, {"name": f"{EXE}.sha256"}, {"name": "release-manifest.json"}],
        }
        (tmp / "view.json").write_text(json.dumps(shown), encoding="utf-8")
        return {"FAKE_ASSETS": str(assets), "FAKE_VIEW": str(tmp / "view.json"), "GH_LOG": str(tmp / "gh.log")}

    def common_env(self, tmp: Path) -> dict:
        return {"TAG": TAG, "SHA": SHA, "VERSION": VERSION, "REPO": REPO, "RUNNER_TEMP": runner_temp(tmp), "GH_TOKEN": "t",
                "FAKE_TAG_SHA": SHA, "GITHUB_OUTPUT": str(tmp / "out.txt")}

    def test_the_download_step_reads_only_a_published_release_with_exactly_the_three_assets(self):
        script = step_script(job(self.text, "verify"), "Download the release assets")
        three = [{"name": EXE}, {"name": f"{EXE}.sha256"}, {"name": "release-manifest.json"}]
        cases = {
            "a draft": {"tagName": TAG, "isDraft": True, "assets": three},
            "another tag": {"tagName": "pos-pilot/v0.1.1", "isDraft": False, "assets": three},
            # Each of these is otherwise a published release, so only the asset-set check can refuse it.
            "a missing asset": {"tagName": TAG, "isDraft": False, "isPrerelease": False, "assets": three[:2]},
            "an extra asset": {"tagName": TAG, "isDraft": False, "isPrerelease": False, "assets": [*three, {"name": "lab.yml"}]},
            "a renamed installer": {"tagName": TAG, "isDraft": False, "isPrerelease": False,
                                    "assets": [{"name": "POS-Pulse-0.1.0-win-x64.zip"}, *three[1:]]},
        }
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            env = {**self.common_env(temp), **self.assets(temp)}
            ok = run_bash(script, env, preamble=STUB_GH)
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            self.assertEqual(sorted(p.name for p in (temp / "pkg").iterdir()), sorted([EXE, f"{EXE}.sha256", "release-manifest.json"]))
            calls = (temp / "gh.log").read_text(encoding="utf-8")
            self.assertIn(f"release view {TAG} --repo {REPO}", calls)
            self.assertIn(f"release download {TAG} --repo {REPO} --dir ", calls, "this job has no checkout: gh needs --repo")
        for label, view in cases.items():
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                env = {**self.common_env(temp), **self.assets(temp, view)}
                result = run_bash(script, env, preamble=STUB_GH)
                self.assertNotEqual(result.returncode, 0, label)
                self.assertFalse((temp / "pkg").exists(), f"{label}: nothing may be downloaded after a refusal")

    def test_the_download_step_refuses_a_tag_that_moved_and_an_asset_the_listing_did_not_show(self):
        script = step_script(job(self.text, "verify"), "Download the release assets")
        three = [{"name": EXE}, {"name": f"{EXE}.sha256"}, {"name": "release-manifest.json"}]
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            env = {**self.common_env(temp), **self.assets(temp), "FAKE_TAG_SHA": "b" * 40}
            moved = run_bash(script, env, preamble=STUB_GH)
            self.assertNotEqual(moved.returncode, 0, "the tag no longer points at the resolved commit")
            self.assertFalse((temp / "pkg").exists())
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            env = {**self.common_env(temp), **self.assets(temp, {"tagName": TAG, "isDraft": False, "isPrerelease": True, "assets": three})}
            self.assertNotEqual(run_bash(script, env, preamble=STUB_GH).returncode, 0, "a prerelease")
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            env = {**self.common_env(temp), **self.assets(temp)}
            (Path(env["FAKE_ASSETS"]) / "extra.bin").write_bytes(b"x")
            extra = run_bash(script, env, preamble=STUB_GH)
            self.assertNotEqual(extra.returncode, 0, "the download held a file the listing did not show")

    def test_the_size_bound_is_one_byte_to_two_gib_inclusive(self):
        script = step_script(job(self.text, "verify"), "Check the assets against the manifest")

        def run(size: int) -> subprocess.CompletedProcess:
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                pkg = temp / "pkg"
                pkg.mkdir()
                (pkg / EXE).write_bytes(b"installer bytes")
                sha_line = f"{hashlib.sha256(b'installer bytes').hexdigest()}  {EXE}" + chr(10)
                (pkg / f"{EXE}.sha256").write_bytes(sha_line.encode())
                (pkg / "release-manifest.json").write_text(json.dumps(manifest()), encoding="utf-8")
                return run_bash(script, self.common_env(temp), preamble=f"wc() {{ echo {size}; }}")

        for size in (1, 2147483648):
            ok = run(size)
            self.assertEqual(ok.returncode, 0, f"{size}: {ok.stdout}{ok.stderr}")
        for size in (0, 2147483649, 21474836480):
            self.assertNotEqual(run(size).returncode, 0, size)

    def test_the_manifest_check_accepts_only_the_pilot_package_it_was_built_for(self):
        script = step_script(job(self.text, "verify"), "Check the assets against the manifest")
        good_digest = "sha256:" + hashlib.sha256(b"installer bytes").hexdigest()
        extra = manifest()
        extra["artifacts"].append({"name": "other", "file": "x", "digest": good_digest})
        bad = {
            "another product": manifest(product="pos"),
            "no signing field": {k: v for k, v in manifest().items() if k != "signing"},
            "a lab signing field": manifest(signing="lab"),
            "a production signing field": manifest(signing="production"),
            "a dry-run manifest": manifest(mode="dry-run"),
            "another tag": manifest(tag="pos-pilot/v0.1.1"),
            "another commit": manifest(source={"repository": REPO, "sha": "b" * 40}),
            "another repository": manifest(source={"repository": "Other/Repo", "sha": SHA}),
            "another digest": manifest(artifacts=[{"name": "pos-installer", "file": EXE, "digest": "sha256:" + "0" * 64}]),
            "another file name": manifest(artifacts=[{"name": "pos-installer", "file": "POS-Pulse-Setup-0.1.1.exe", "digest": good_digest}]),
            "a second artifact": extra,
        }

        def run(manifest_doc: dict, sha_text: str | None = None, payload: bytes = b"installer bytes") -> subprocess.CompletedProcess:
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                pkg = temp / "pkg"
                pkg.mkdir()
                (pkg / EXE).write_bytes(payload)
                text = sha_text if sha_text is not None else f"{hashlib.sha256(payload).hexdigest()}  {EXE}\n"
                (pkg / f"{EXE}.sha256").write_bytes(text.encode())  # LF as sha256sum writes it, never the platform newline
                (pkg / "release-manifest.json").write_text(json.dumps(manifest_doc), encoding="utf-8")
                return run_bash(script, self.common_env(temp))

        accepted = run(manifest())
        self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
        for label, doc in bad.items():
            self.assertNotEqual(run(doc).returncode, 0, label)
        self.assertNotEqual(run(manifest(), sha_text=f"{'0' * 64}  {EXE}\n").returncode, 0, "a .sha256 that does not match the bytes")
        # A valid checksum of ANOTHER asset must not pass as the installer's: this is the manifest's own digest.
        manifest_sha = hashlib.sha256(json.dumps(manifest()).encode()).hexdigest()
        other = run(manifest(), sha_text=f"{manifest_sha}  release-manifest.json\n")
        self.assertNotEqual(other.returncode, 0, "a .sha256 that names release-manifest.json, not the installer")
        for label, text in {"a binary-mode entry": f"{hashlib.sha256(b'installer bytes').hexdigest()} *{EXE}\n",
                            "two entries": f"{hashlib.sha256(b'installer bytes').hexdigest()}  {EXE}\n{manifest_sha}  release-manifest.json\n",
                            "an empty file": ""}.items():
            self.assertNotEqual(run(manifest(), sha_text=text).returncode, 0, label)
        tampered = run(manifest(), payload=b"installer bytes!")
        self.assertNotEqual(tampered.returncode, 0, "tampered bytes")
        self.assertNotEqual(run(manifest(), payload=b"").returncode, 0, "an empty installer")
        self.assertIn("2147483648", script, "the registry refuses a size over 2 GiB: so does the check")

    def test_the_attestation_step_fails_when_gh_cannot_verify_and_passes_the_exact_arguments(self):
        script = step_script(job(self.text, "verify"), "Verify the build provenance")
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            env = {**self.common_env(temp), "GH_LOG": str(temp / "gh.log")}
            ok = run_bash(script, env, preamble=STUB_GH)
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            call = (temp / "gh.log").read_text(encoding="utf-8").strip()
            self.assertIn(f"attestation verify {runner_temp(temp)}/pkg/{EXE}", call)
            for part in (f"--repo {REPO}", f"--signer-workflow {REPO}/.github/workflows/release-pos-pilot.yml",
                         f"--source-digest {SHA}", f"--source-ref refs/tags/{TAG}", "--deny-self-hosted-runners"):
                self.assertIn(part, call)
            failed = run_bash(script, {**env, "FAKE_ATTEST_EXIT": "1"}, preamble=STUB_GH)
            self.assertNotEqual(failed.returncode, 0, "no attestation, no promotion")

    def test_the_dry_run_result_says_what_a_live_promotion_would_do_and_that_nothing_was_done(self):
        script = step_script(job(self.text, "verify"), "Dry-run result")
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            pkg = temp / "pkg"
            pkg.mkdir()
            (pkg / EXE).write_bytes(b"installer bytes")
            summary = temp / "summary.md"
            env = {**self.common_env(temp), "GITHUB_STEP_SUMMARY": str(summary), "GITHUB_SERVER_URL": "https://github.com",
                   "GITHUB_RUN_ID": "123456789", "LEAF_SHA1": LEAF}
            result = run_bash(script, env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            text = summary.read_text(encoding="utf-8")
            digest = hashlib.sha256(b"installer bytes").hexdigest()
            for part in (f"pos/pilot/{VERSION}/{EXE}", digest, "15", SUBJECT, SHA, TAG,
                         f"{REPO}/actions/runs/123456789", "nothing was uploaded", "nothing was registered", "leave the release inactive"):
                self.assertIn(part, text)
            for word in ("http://", "X-Amz", "Authorization", "Bearer"):
                self.assertNotIn(word, text)


ROLE_ARN = "arn:aws:iam::123456789012:role/rt-gha-pos-pilot-promote"
BUCKET = "kemetra-rt-pos-pilot-releases"
REGION = "us-east-1"
API = "https://lab.example.com"
AUDIENCE = "https://lab.example.com/pos-pilot-promotion"
PAYLOAD = b"installer bytes"
DIGEST = hashlib.sha256(PAYLOAD).hexdigest()
B64 = base64.b64encode(hashlib.sha256(PAYLOAD).digest()).decode()
CI_RUN = "777"
ATTESTATION_ID = "65805159"
RELEASE_ATTESTATION_ID = "65805210"
SLSA = "https://slsa.dev/provenance/v1"
RELEASE_PREDICATE = "https://in-toto.io/attestation/release/v0.2"
VERSION_ID = "3HL4kqtJlcpXroDTDmJ.rmSpXd3dIbrHY"
RUN_ID = "123456789"
STEP_SETTINGS = "Check the environment's settings and the tools"
STEP_DOWNLOAD = "Download the release again and compare it with what verify checked"
STEP_ATTEST = "Resolve the build provenance attestation"
STEP_API = "Check that Backend-Core answers"
STEP_ASSUME = "Assume the upload role (GitHub OIDC, no stored keys)"
STEP_PUT = "Upload the installer once (conditional write)"
STEP_BODY = "Build the registration body once"
STEP_REGISTER = "Register the release with Backend-Core (OIDC bearer; it is not activated)"
RUNBOOK = ROOT / "services/backend-core/docs/operations/pos-pilot-release-bucket.md"

# `gh`, `aws` and `curl` as the live steps use them. Each logs its arguments (never what goes in on stdin).
STUB_GH_LIVE = r"""
gh() {
  printf '%s\n' "$*" >> "$GH_LOG"
  case "$1 $2" in
    "release view") cat "$FAKE_VIEW" ;;
    "release download")
      dir=""
      while [ "$#" -gt 0 ]; do if [ "$1" = "--dir" ]; then dir="$2"; fi; shift; done
      cp "$FAKE_ASSETS"/* "$dir"/ ;;
    "api repos/"*)
      case "$2" in
        */attestations/*) cat "$FAKE_ATTESTATIONS" ;;
        *) printf '%s\n' "${FAKE_TAG_SHA:-}" ;;
      esac ;;
    *) echo "unexpected gh $*" >&2; exit 9 ;;
  esac
}
"""
STUB_AWS = r"""
aws() {
  printf '%s\n' "$*" >> "$AWS_LOG"
  if [ "$1 $2 $3" = "s3api put-object --generate-cli-skeleton" ]; then
    if [ -n "${FAKE_NO_IFNONE:-}" ]; then printf '{"Bucket": ""}\n'; else printf '{"Bucket": "", "IfNoneMatch": ""}\n'; fi
    return 0
  fi
  if [ "$1 $2" = "s3api put-object" ]; then
    if [ -n "${FAKE_PUT_ERR:-}" ]; then printf '%s\n' "$FAKE_PUT_ERR" >&2; fi
    if [ "${FAKE_PUT_EXIT:-0}" = 0 ]; then printf '%s\n' "$FAKE_PUT_OUT"; fi
    return "${FAKE_PUT_EXIT:-0}"
  fi
  echo "unexpected aws $*" >&2; return 9
}
"""
STUB_CURL = r"""
curl() {
  printf '%s\n' "$*" >> "$CURL_LOG"
  case " $* " in *" -K - "*) cat > "$CURL_STDIN" ;; esac
  case " $* " in
    *" --get "*)
      if [ -n "${FAKE_TOKEN_REPLY:-}" ]; then printf '%s\n' "$FAKE_TOKEN_REPLY"; else printf '{"value":"jwt.test.token"}\n'; fi ;;
    *"/api/v1/health/ready"*) printf '%s' "${FAKE_HEALTH:-200}" ;;
    *" -X POST "*)
      out=""; prev=""
      for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done
      printf '%s' "$FAKE_RESP" > "$out"
      printf '%s' "${FAKE_HTTP:-201}" ;;
    *) echo "unexpected curl $*" >&2; return 9 ;;
  esac
}
"""


def statement(predicate_type: str = SLSA, digest: str = DIGEST, invocation: str | None = None) -> dict:
    """The in-toto statement inside an attestation bundle, as much of it as the workflow reads."""
    run = invocation or f"https://github.com/{REPO}/actions/runs/{CI_RUN}/attempts/2"
    return {"_type": "https://in-toto.io/Statement/v1", "predicateType": predicate_type,
            "subject": [{"name": EXE, "digest": {"sha256": digest}}],
            "predicate": {"runDetails": {"metadata": {"invocationId": run}}}}


def attestation(att_id: str, stmt: dict, url: str | None = None) -> dict:
    """One entry of GitHub's attestation list: no id field, the id is the number in the bundle's storage path."""
    return {"bundle_url": url or f"https://blob.example.net/attestations/1430288487/2026/11/10/{att_id}.json.sn?se=x&sig=y",
            "repository_id": 1430288487, "initiator": "github",
            "bundle": {"dsseEnvelope": {"payload": base64.b64encode(json.dumps(stmt).encode()).decode()}}}


def lay_out_release(tmp: Path, view: dict | None = None, payload: bytes = PAYLOAD, manifest_obj: dict | None = None,
                    sha_line: str | None = None, attestations: list | None = None) -> dict:
    """A fake release (the assets the stub downloads, the JSON its `release view` prints, the attestation list)."""
    assets = tmp / "assets"
    assets.mkdir()
    (assets / EXE).write_bytes(payload)
    line = sha_line if sha_line is not None else f"{hashlib.sha256(payload).hexdigest()}  {EXE}\n"
    (assets / f"{EXE}.sha256").write_text(line, encoding="utf-8")
    (assets / "release-manifest.json").write_text(json.dumps(manifest_obj if manifest_obj is not None else manifest()), encoding="utf-8")
    shown = view if view is not None else {
        "tagName": TAG, "isDraft": False, "isPrerelease": False,
        "assets": [{"name": EXE}, {"name": f"{EXE}.sha256"}, {"name": "release-manifest.json"}],
    }
    (tmp / "view.json").write_text(json.dumps(shown), encoding="utf-8")
    listed = attestations if attestations is not None else [
        attestation(RELEASE_ATTESTATION_ID, statement(RELEASE_PREDICATE)), attestation(ATTESTATION_ID, statement())]
    (tmp / "attestations.json").write_text(json.dumps({"attestations": listed}), encoding="utf-8")
    return {"FAKE_ASSETS": str(assets), "FAKE_VIEW": str(tmp / "view.json"), "FAKE_ATTESTATIONS": str(tmp / "attestations.json")}


def live_env(tmp: Path, **extra: str) -> dict:
    """The environment a live step sees: the job's env, the environment's variables and the fakes' log files."""
    env = {"TAG": TAG, "SHA": SHA, "VERSION": VERSION, "REPO": REPO, "RUNNER_TEMP": runner_temp(tmp), "GH_TOKEN": "t",
           "GITHUB_OUTPUT": str(tmp / "out.txt"), "GITHUB_STEP_SUMMARY": str(tmp / "summary.md"), "GH_LOG": str(tmp / "gh.log"),
           "AWS_LOG": str(tmp / "aws.log"), "CURL_LOG": str(tmp / "curl.log"), "CURL_STDIN": str(tmp / "curl.stdin"),
           "FAKE_TAG_SHA": SHA, "ROLE_ARN": ROLE_ARN, "BUCKET": BUCKET, "S3_REGION": REGION, "API_BASE": API,
           "AUDIENCE": AUDIENCE, "VERIFIED_DIGEST": DIGEST, "VERIFIED_SIZE": str(len(PAYLOAD)), "ACTOR": "octocat", "RUN_ID": RUN_ID}
    env.update(extra)
    return env


def step_outputs(tmp: Path) -> dict[str, str]:
    """What the step wrote to GITHUB_OUTPUT."""
    path = tmp / "out.txt"
    if not path.exists():
        return {}
    return dict(line.split("=", 1) for line in path.read_text(encoding="utf-8").splitlines() if "=" in line)


class PromotePosPilotLiveStatic(unittest.TestCase):
    text = read(WORKFLOW)

    def test_the_live_jobs_run_only_when_dry_run_is_off_and_in_a_fixed_order(self):
        self.assertEqual(needs_of(job(self.text, "upload")), ["resolve", "verify"])
        self.assertEqual(needs_of(job(self.text, "register")), ["resolve", "upload"])
        for name in ("upload", "register"):
            self.assertIn("if: ${{ !inputs.dry_run }}", job(self.text, name), name)
        for name in ("resolve", "verify"):
            self.assertNotIn("inputs.dry_run", job(self.text, name), name)

    def test_dry_run_is_a_boolean_that_defaults_to_true(self):
        block = re.search(r"      dry_run:\n((?:        .*\n)+)", self.text).group(1)
        self.assertIn("type: boolean", block)
        self.assertIn("default: true", block)

    def test_exactly_the_two_live_jobs_hold_the_environment_and_an_id_token(self):
        for name in ("resolve", "verify", "upload", "register"):
            body = code(job(self.text, name))
            environment = re.search(r"^    environment: (\S+)$", body, re.M)
            token = "id-token: write" in body
            if name in ("upload", "register"):
                self.assertIsNotNone(environment, name)
                self.assertEqual(environment.group(1), ENVIRONMENT, name)
                self.assertTrue(token, name)
            else:
                self.assertIsNone(environment, name)
                self.assertFalse(token, name)
        # Permission lines only (six spaces in): a job's error message may name the permission it needs.
        self.assertEqual(len(re.findall(r"^      id-token: write$", code(self.text), re.M)), 2)
        self.assertEqual(len(re.findall(r"^    environment:", code(self.text), re.M)), 2)

    def test_the_live_jobs_hold_exactly_the_permissions_they_use(self):
        def perms(name: str) -> list[str]:
            block = re.search(r"^    permissions:\n((?:      .*\n)+)", job(self.text, name) + "\n", re.M)
            return sorted(re.sub(r"\s+#.*$", "", line.strip()) for line in block.group(1).splitlines())

        self.assertEqual(perms("upload"), ["attestations: read", "contents: read", "id-token: write"])
        self.assertEqual(perms("register"), ["id-token: write"])
        for word in ("contents: write", "attestations: write", "actions:", "packages:", "write-all"):
            self.assertNotIn(word, code(self.text), word)

    def test_the_aws_role_is_assumed_once_in_the_upload_job_from_the_environments_variables_with_no_stored_keys(self):
        self.assertEqual(self.text.count("aws-actions/configure-aws-credentials@"), 1)
        assume = step(job(self.text, "upload"), STEP_ASSUME)
        for part in ("role-to-assume: ${{ vars.POS_PILOT_PROMOTE_ROLE_ARN }}", "aws-region: ${{ vars.POS_PILOT_RELEASE_S3_REGION }}",
                     "role-session-name: rt-promote-pos-pilot-${{ github.run_id }}", "role-duration-seconds: 900"):
            self.assertIn(part, assume)
        for word in ("secrets.", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "aws-access-key-id", "aws-secret-access-key"):
            self.assertNotIn(word, self.text, word)
        self.assertNotIn("configure-aws-credentials", job(self.text, "register"))
        self.assertNotIn("aws ", code(job(self.text, "register")))

    def test_the_upload_is_one_conditional_checksummed_put_object_and_nothing_else_touches_s3(self):
        script = step_script(job(self.text, "upload"), STEP_PUT)
        for part in ("aws s3api put-object", '--bucket "$BUCKET"', '--key "$KEY"', "--checksum-algorithm SHA256",
                     '--checksum-sha256 "$B64"', "--if-none-match '*'", '--body "$PKG/$EXE"'):
            self.assertIn(part, script)
        self.assertEqual(script.count("put-object"), 1)
        body = code(self.text)
        # Two s3api calls in the whole file: the capability probe and the one upload.
        self.assertEqual(len(re.findall(r"\baws s3api\b", body)), 2)
        for word in ("aws s3 ", "s3 cp", "s3 sync", "multipart", "delete-object", "get-object", "head-object", "list-object",
                     "put-bucket", "put-object-acl", "create-bucket", "iam "):
            self.assertNotIn(word, body, word)

    def test_register_posts_once_to_the_register_route_and_never_activates_or_withdraws(self):
        register = code(job(self.text, "register"))
        self.assertEqual(register.count("-X POST"), 1)
        self.assertEqual(register.count("/api/v1/platform/pos-pilot-releases"), 1)
        for word in ("/activate", "/withdraw", "-X PUT", "-X DELETE", "-X PATCH", "actions/checkout", "put-object"):
            self.assertNotIn(word, register, word)
        upload = code(job(self.text, "upload"))
        self.assertNotIn("/api/v1/platform", upload, "the upload job only asks whether Backend-Core answers")
        self.assertNotIn("Bearer", upload)
        self.assertEqual(len(re.findall(r"curl [^\n]*/api/v1/health/ready", code(self.text))), 1, "one health request, in the upload job")

    def test_no_credential_reaches_a_process_argument_list(self):
        register = code(job(self.text, "register"))
        self.assertNotIn('-H "Authorization', register)
        self.assertEqual(register.count("curl -K -"), 2, "the id-token request and the register call both read their header from stdin")
        self.assertIn("::add-mask::", register)
        self.assertNotIn("curl -L", self.text)
        self.assertNotIn("--location", self.text)
        calls = re.findall(r"curl (?:-K - )?--silent[^\n]*", code(self.text))
        self.assertEqual(len(calls), 3, "the Backend-Core check, the id-token request and the register call")
        for call in calls:
            self.assertIn("--proto '=https'", call, "every curl is https-only")
            self.assertIn("--tlsv1.2", call)

    def test_every_check_runs_before_the_role_is_assumed_and_the_body_is_built_after_the_upload(self):
        names = re.findall(r"^      - name: (.+)$", job(self.text, "upload"), re.M)
        self.assertEqual(names, [STEP_SETTINGS, STEP_DOWNLOAD, STEP_ATTEST, STEP_API, STEP_ASSUME, STEP_PUT, STEP_BODY])

    def test_the_runbook_names_every_setting_the_workflow_reads_and_the_five_pins(self):
        section = read(RUNBOOK).split("## 9. ", 1)[1]
        variables = sorted(set(re.findall(r"vars\.([A-Z0-9_]+)", self.text)))
        self.assertEqual(variables, ["POS_PILOT_API_BASE_URL", "POS_PILOT_PROMOTE_ROLE_ARN", "POS_PILOT_PROMOTION_OIDC_AUDIENCE",
                                     "POS_PILOT_RELEASE_BUCKET", "POS_PILOT_RELEASE_S3_REGION"])
        for name in (*variables, ENVIRONMENT, "refs/heads/main", "promote-pos-pilot.yml", "POS_PILOT_PROMOTION_OIDC_AUDIENCE",
                     "POS_PILOT_PROMOTION_OIDC_REPOSITORY", "POS_PILOT_PROMOTION_OIDC_ENVIRONMENT", "POS_PILOT_PROMOTION_OIDC_REF",
                     "POS_PILOT_PROMOTION_OIDC_WORKFLOW_REF", "Re-run failed jobs"):
            self.assertIn(name, section, name)


@unittest.skipUnless(HAVE_BASH and shutil.which("jq") and shutil.which("sha256sum"), "bash, jq and sha256sum are needed")
class PromotePosPilotLiveSteps(unittest.TestCase):
    text = read(WORKFLOW)

    def run_step(self, tmp: Path, job_name: str, step_name: str, env: dict, preamble: str) -> subprocess.CompletedProcess:
        return run_bash(step_script(job(self.text, job_name), step_name), env, preamble=preamble)

    def test_verify_hands_the_digest_and_size_of_the_installer_to_the_live_job(self):
        script = step_script(job(self.text, "verify"), "Check the assets against the manifest")
        self.assertIn("digest: ${{ steps.assets.outputs.digest }}", job(self.text, "verify"))
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            pkg = temp / "pkg"
            pkg.mkdir()
            (pkg / EXE).write_bytes(PAYLOAD)
            (pkg / f"{EXE}.sha256").write_text(f"{DIGEST}  {EXE}\n", encoding="utf-8")
            (pkg / "release-manifest.json").write_text(json.dumps(manifest()), encoding="utf-8")
            result = run_bash(script, live_env(temp))
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(step_outputs(temp), {"digest": DIGEST, "size": str(len(PAYLOAD))})

    def test_the_settings_step_accepts_the_real_shapes_and_refuses_every_malformed_or_foreign_value(self):
        stubs = STUB_AWS + "\ncurl() { :; }\nopenssl() { :; }\nbase64() { :; }\ngh() { :; }\n"
        with tempfile.TemporaryDirectory() as tmp:
            ok = self.run_step(Path(tmp), "upload", STEP_SETTINGS, live_env(Path(tmp)), stubs)
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
        bad = {
            "ROLE_ARN": ["", "arn:aws:iam::123:role/rt-gha-pos-pilot-promote", "arn:aws:iam::123456789012:role/rt-gha-aws-lab-deploy",
                         ROLE_ARN + "x", ROLE_ARN + "/extra", "role/rt-gha-pos-pilot-promote"],
            "BUCKET": ["", "Has-Upper", "has.dot", "-lead", "trail-", "ab", "has_underscore"],
            "S3_REGION": ["", "us_east_1", "useast1", "us-east-1; rm -rf /"],
            "API_BASE": ["", "http://lab.example.com", "https://lab.example.com/", "https://lab.example.com/api", "lab.example.com", "https://"],
            "AUDIENCE": ["", "ab", "sts.amazonaws.com", "has space", "x" * 201],
            # What the body will carry is refused BEFORE the one-shot upload, never after it.
            "ACTOR": ["", "some-app[bot]", "bad actor", "-x", "x-", "a--b", "x" * 40],
            "RUN_ID": ["", "12a"],
            "VERSION": ["01.0.0", "1.02.0", "1.0", "1.0.0-rc.1", "1" * 33],
        }
        for var, values in bad.items():
            for value in values:
                with tempfile.TemporaryDirectory() as tmp:
                    result = self.run_step(Path(tmp), "upload", STEP_SETTINGS, live_env(Path(tmp), **{var: value}), stubs)
                    self.assertNotEqual(result.returncode, 0, f"{var}={value!r}")
        with tempfile.TemporaryDirectory() as tmp:
            result = self.run_step(Path(tmp), "upload", STEP_SETTINGS, live_env(Path(tmp), FAKE_NO_IFNONE="1"), stubs)
            self.assertNotEqual(result.returncode, 0, "a CLI that cannot send If-None-Match must not upload")
            self.assertIn("If-None-Match", result.stdout + result.stderr)

    def test_the_download_step_accepts_only_the_bytes_verify_checked_and_names_the_release_run(self):
        three = [{"name": EXE}, {"name": f"{EXE}.sha256"}, {"name": "release-manifest.json"}]
        other = manifest()
        other["artifacts"] = [{"name": "pos-installer", "file": EXE, "digest": "sha256:" + "0" * 64}]
        two = manifest()
        two["artifacts"].append({"name": "other", "file": "x", "digest": "sha256:" + DIGEST})
        no_ci = {k: v for k, v in manifest().items() if k != "ci_url"}
        cases = {
            "verify saw other bytes": ({}, {"VERIFIED_DIGEST": "0" * 64}),
            "verify saw another size": ({}, {"VERIFIED_SIZE": "16"}),
            "the tag moved": ({}, {"FAKE_TAG_SHA": "b" * 40}),
            "the manifest names another digest": ({"manifest_obj": other}, {}),
            "the manifest holds two artifacts": ({"manifest_obj": two}, {}),
            "the .sha256 is another file's": ({"sha_line": f"{DIGEST}  other.exe\n"}, {}),
            "the ci_url is another repository's": ({"manifest_obj": manifest(ci_url="https://github.com/someone/else/actions/runs/1")}, {}),
            "the ci_url is not a run": ({"manifest_obj": manifest(ci_url=f"https://github.com/{REPO}/actions/runs/abc")}, {}),
            "there is no ci_url": ({"manifest_obj": no_ci}, {}),
            "a draft": ({"view": {"tagName": TAG, "isDraft": True, "isPrerelease": False, "assets": three}}, {}),
            "an extra asset": ({"view": {"tagName": TAG, "isDraft": False, "isPrerelease": False, "assets": [*three, {"name": "lab.yml"}]}}, {}),
        }
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            ok = self.run_step(temp, "upload", STEP_DOWNLOAD, live_env(temp, **lay_out_release(temp)), STUB_GH_LIVE)
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            self.assertEqual(step_outputs(temp), {"digest": DIGEST, "size": str(len(PAYLOAD)), "ci_run": CI_RUN})
            self.assertIn(f"release download {TAG} --repo {REPO} --dir ", (temp / "gh.log").read_text(encoding="utf-8"))
        for label, (layout, env_changes) in cases.items():
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                result = self.run_step(temp, "upload", STEP_DOWNLOAD, live_env(temp, **lay_out_release(temp, **layout), **env_changes), STUB_GH_LIVE)
                self.assertNotEqual(result.returncode, 0, label)
                self.assertEqual(step_outputs(temp), {}, f"{label}: nothing may be handed on after a refusal")

    def test_the_attestation_step_selects_the_slsa_provenance_of_the_release_run_and_nothing_else(self):
        release = attestation(RELEASE_ATTESTATION_ID, statement(RELEASE_PREDICATE))
        slsa = attestation(ATTESTATION_ID, statement())
        wanted = f"https://github.com/{REPO}/attestations/{ATTESTATION_ID}"
        for listed in ([release, slsa], [slsa, release], [slsa]):
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                env = live_env(temp, **lay_out_release(temp, attestations=listed), DIGEST=DIGEST, CI_RUN=CI_RUN)
                ok = self.run_step(temp, "upload", STEP_ATTEST, env, STUB_GH_LIVE)
                self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
                self.assertEqual(step_outputs(temp), {"ref": wanted})
                self.assertIn(f"api repos/{REPO}/attestations/sha256:{DIGEST}", (temp / "gh.log").read_text(encoding="utf-8"))
        cases = {
            "only the release attestation": [release],
            "none at all": [],
            "two provenances of the run": [slsa, attestation("65805300", statement())],
            "a provenance of another run": [attestation(ATTESTATION_ID, statement(invocation=f"https://github.com/{REPO}/actions/runs/999/attempts/1"))],
            "a run number that only starts the same": [attestation(ATTESTATION_ID, statement(invocation=f"https://github.com/{REPO}/actions/runs/{CI_RUN}1/attempts/1"))],
            "a provenance of another repository's run": [attestation(ATTESTATION_ID, statement(invocation=f"https://github.com/someone/else/actions/runs/{CI_RUN}"))],
            "a provenance of another digest": [attestation(ATTESTATION_ID, statement(digest="0" * 64))],
            "a bundle url without an id": [attestation(ATTESTATION_ID, statement(), url="https://blob.example.net/attestations/x.json")],
            "a provenance with no invocationId": [attestation(ATTESTATION_ID, {**statement(), "predicate": {"runDetails": {"metadata": {}}}})],
            "a provenance with an empty invocationId": [attestation(ATTESTATION_ID, statement(invocation=None) | {"predicate": {"runDetails": {"metadata": {"invocationId": ""}}}})],
        }
        for label, listed in cases.items():
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                env = live_env(temp, **lay_out_release(temp, attestations=listed), DIGEST=DIGEST, CI_RUN=CI_RUN)
                result = self.run_step(temp, "upload", STEP_ATTEST, env, STUB_GH_LIVE)
                self.assertNotEqual(result.returncode, 0, label)
                self.assertEqual(step_outputs(temp), {}, label)

    def test_the_backend_core_check_follows_no_redirect_and_needs_exactly_a_200(self):
        # 000 is what curl's -w prints when no HTTP answer came back at all.
        for status, passes in (("200", True), ("302", False), ("401", False), ("404", False), ("503", False), ("000", False)):
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                result = self.run_step(temp, "upload", STEP_API, live_env(temp, FAKE_HEALTH=status), STUB_CURL)
                self.assertEqual(result.returncode == 0, passes, f"{status!r}: {result.stdout}{result.stderr}")
                log = (temp / "curl.log").read_text(encoding="utf-8")
                self.assertIn(f"{API}/api/v1/health/ready", log)
                self.assertIn("--proto =https", log)
                self.assertNotIn(" -L ", f" {log} ")

    @unittest.skipUnless(shutil.which("openssl") and shutil.which("base64"), "openssl and base64 are needed")
    def test_the_upload_sends_one_conditional_checksummed_put_and_records_the_version(self):
        good = json.dumps({"ETag": '"abc"', "VersionId": VERSION_ID, "ChecksumSHA256": B64})

        def run(tmp: Path, **extra: str) -> subprocess.CompletedProcess:
            (tmp / "pkg").mkdir()
            (tmp / "pkg" / EXE).write_bytes(PAYLOAD)
            return self.run_step(tmp, "upload", STEP_PUT, live_env(tmp, DIGEST=DIGEST, **{"FAKE_PUT_OUT": good, **extra}), STUB_AWS)

        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            ok = run(temp)
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            self.assertEqual(step_outputs(temp), {"version_id": VERSION_ID})
            calls = (temp / "aws.log").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(calls), 1, "one PutObject, once")
            for part in (f"--bucket {BUCKET}", f"--key pos/pilot/{VERSION}/{EXE}", "--checksum-algorithm SHA256",
                         f"--checksum-sha256 {B64}", "--if-none-match *", "--content-type application/octet-stream"):
                self.assertIn(part, calls[0])
        cases = {
            "no VersionId": ({"FAKE_PUT_OUT": json.dumps({"ChecksumSHA256": B64})}, None),
            "an empty VersionId": ({"FAKE_PUT_OUT": json.dumps({"VersionId": "", "ChecksumSHA256": B64})}, None),
            "a VersionId with a newline": ({"FAKE_PUT_OUT": json.dumps({"VersionId": "abc\nbody=evil", "ChecksumSHA256": B64})}, "unexpected shape"),
            "another checksum": ({"FAKE_PUT_OUT": json.dumps({"VersionId": VERSION_ID, "ChecksumSHA256": "AAAA"})}, None),
            "no checksum": ({"FAKE_PUT_OUT": json.dumps({"VersionId": VERSION_ID})}, None),
            "an existing key": ({"FAKE_PUT_EXIT": "254", "FAKE_PUT_ERR": "An error occurred (PreconditionFailed) when calling the PutObject operation"}, "Do not re-run"),
            "any other failure": ({"FAKE_PUT_EXIT": "1", "FAKE_PUT_ERR": "An error occurred (AccessDenied)"}, "nothing was written"),
        }
        for label, (extra, message) in cases.items():
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                result = run(temp, **extra)
                self.assertNotEqual(result.returncode, 0, label)
                self.assertEqual(step_outputs(temp), {}, label)
                if message:
                    self.assertIn(message, result.stdout + result.stderr, label)

    def test_the_registration_body_is_built_once_and_satisfies_the_contract_and_the_servers_own_patterns(self):
        script_env = {"DIGEST": DIGEST, "SIZE": str(len(PAYLOAD)), "VERSION_ID": VERSION_ID, "ATTEST_REF": f"https://github.com/{REPO}/attestations/{ATTESTATION_ID}",
                      "ACTOR": "octocat", "RUN_ID": RUN_ID}
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            ok = self.run_step(temp, "upload", STEP_BODY, live_env(temp, **script_env), "")
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            body = json.loads(step_outputs(temp)["body"])
            api = read(ROOT / "services/backend-core/packages/contracts/openapi/pos-pilot-releases.openapi.yaml")
            registration = api.split("    PilotReleaseRegistration:", 1)[1].split("      properties:", 1)[0]
            required = re.findall(r"^        - (\w+)$", registration, re.M)
            self.assertEqual(sorted(body), sorted(required), "the body carries exactly the fields the contract requires")
            self.assertEqual(body["publisher"], SUBJECT)
            self.assertEqual(body["signingClass"], "pilot")
            self.assertEqual(body["sourceSha"], SHA)
            self.assertEqual(body["sizeBytes"], len(PAYLOAD))
            self.assertIsInstance(body["sizeBytes"], int)
            self.assertEqual(body["approvedBy"], "octocat")
            self.assertEqual(body["artifactVersionId"], VERSION_ID)
            self.assertEqual(body["promotionRunUrl"], f"https://github.com/{REPO}/actions/runs/{RUN_ID}", "no /attempts/N: a re-run must send the same body")
            self.assertRegex(body["approvedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
            dto = read(ROOT / "services/backend-core/apps/api/src/pos-pilot-releases/dto.ts")
            for const, field in (("ATTESTATION_REF", "attestationRef"), ("PROMOTION_RUN_URL", "promotionRunUrl"), ("GITHUB_LOGIN", "approvedBy")):
                literal = re.search(rf"const {const} = /(.+)/;", dto).group(1).replace("\\/", "/")
                self.assertRegex(body[field], literal, f"{field} must match the server's {const}")
            self.assertRegex(body["version"], r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
            self.assertRegex(body["sha256"], r"^[0-9a-f]{64}$")
            summary = (temp / "summary.md").read_text(encoding="utf-8")
            for part in (VERSION_ID, "Re-run failed jobs", "never re-run this job"):
                self.assertIn(part, summary)
        for label, change in {"an empty actor": {"ACTOR": ""}, "a space in the actor": {"ACTOR": "bad actor"}, "a leading hyphen": {"ACTOR": "-x"},
                              "a trailing hyphen": {"ACTOR": "x-"}, "a double hyphen": {"ACTOR": "a--b"}, "an actor over 39": {"ACTOR": "x" * 40},
                              "a non-numeric run id": {"RUN_ID": "12a"}, "no version id": {"VERSION_ID": ""}}.items():
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                result = self.run_step(temp, "upload", STEP_BODY, live_env(temp, **{**script_env, **change}), "")
                self.assertNotEqual(result.returncode, 0, label)
                self.assertEqual(step_outputs(temp), {}, label)

    def register_env(self, tmp: Path, body: dict | None = None, **extra: str) -> dict:
        sent = body if body is not None else {
            "version": VERSION, "sha256": DIGEST, "sizeBytes": len(PAYLOAD), "publisher": SUBJECT, "signingClass": "pilot",
            "attestationRef": f"https://github.com/{REPO}/attestations/{ATTESTATION_ID}", "sourceSha": SHA, "approvedBy": "octocat",
            "approvedAt": "2026-11-10T12:00:00Z", "promotionRunUrl": f"https://github.com/{REPO}/actions/runs/{RUN_ID}", "artifactVersionId": VERSION_ID}
        answered = {"releaseId": "11111111-2222-3333-4444-555555555555", "version": VERSION, "sha256": DIGEST, "sizeBytes": len(PAYLOAD),
                    "signingClass": "pilot", "artifactVersionId": VERSION_ID, "approved": True}
        env = live_env(tmp, BODY=json.dumps(sent, separators=(",", ":")), RUN_ID=RUN_ID,
                       ACTIONS_ID_TOKEN_REQUEST_URL="https://token.example.net/oidc?api-version=2", ACTIONS_ID_TOKEN_REQUEST_TOKEN="requesttoken",
                       FAKE_RESP=json.dumps(answered), FAKE_HTTP="201")
        env.update(extra)
        return env

    def test_register_sends_the_body_with_an_oidc_bearer_and_accepts_only_the_release_it_sent(self):
        for status in ("201", "200"):
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                env = self.register_env(temp, FAKE_HTTP=status)
                ok = self.run_step(temp, "register", STEP_REGISTER, env, STUB_CURL)
                self.assertEqual(ok.returncode, 0, f"{status}: {ok.stdout}{ok.stderr}")
                log = (temp / "curl.log").read_text(encoding="utf-8")
                calls = log.splitlines()
                self.assertEqual(len(calls), 2, "one token request and one register call")
                self.assertIn(f"--data-urlencode audience={AUDIENCE}", calls[0])
                self.assertIn("--get", calls[0])
                self.assertIn(f"{API}/api/v1/platform/pos-pilot-releases", calls[1])
                self.assertIn("-X POST", calls[1])
                self.assertIn(f"-H Idempotency-Key: pos-pilot-promote-{VERSION}-{RUN_ID}", calls[1])
                self.assertIn("-H Content-Type: application/json", calls[1])
                self.assertIn(f"--data {env['BODY']}", calls[1])
                for secret in ("requesttoken", "jwt.test.token"):
                    self.assertNotIn(secret, log, "a credential must never be in an argument list")
                self.assertIn("Authorization: Bearer jwt.test.token", (temp / "curl.stdin").read_text(encoding="utf-8"))
                self.assertIn("::add-mask::jwt.test.token", ok.stdout)
                self.assertIn("NOT active", (temp / "summary.md").read_text(encoding="utf-8"))

    def test_register_fails_closed_on_every_refusal_a_mismatched_answer_and_every_bad_setting(self):
        mismatched = {
            "a withdrawn release answered 200": {"approved": False},
            "another digest": {"sha256": "0" * 64},
            "another size": {"sizeBytes": 1},
            "another version id": {"artifactVersionId": "someone-elses"},
            "a lab class": {"signingClass": "lab"},
            "another version": {"version": "9.9.9"},
        }
        for status in ("400", "401", "403", "409", "422", "429", "500", "302"):
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                result = self.run_step(temp, "register", STEP_REGISTER, self.register_env(temp, FAKE_HTTP=status, FAKE_RESP='{"code":"forbidden"}'), STUB_CURL)
                self.assertNotEqual(result.returncode, 0, status)
                self.assertIn("Re-run failed jobs", result.stdout + result.stderr, status)
        for label, change in mismatched.items():
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                answered = {"releaseId": "x", "version": VERSION, "sha256": DIGEST, "sizeBytes": len(PAYLOAD), "signingClass": "pilot",
                            "artifactVersionId": VERSION_ID, "approved": True, **change}
                result = self.run_step(temp, "register", STEP_REGISTER, self.register_env(temp, FAKE_HTTP="200", FAKE_RESP=json.dumps(answered)), STUB_CURL)
                self.assertNotEqual(result.returncode, 0, label)
        lab_body = {"version": VERSION, "signingClass": "lab", "publisher": SUBJECT}
        other_version = {"version": "0.2.0", "signingClass": "pilot", "publisher": SUBJECT}
        bad_settings = {
            "no id-token request url": {"ACTIONS_ID_TOKEN_REQUEST_URL": ""},
            "no id-token request token": {"ACTIONS_ID_TOKEN_REQUEST_TOKEN": ""},
            "a plain http api": {"API_BASE": "http://lab.example.com"},
            "an api with a path": {"API_BASE": "https://lab.example.com/api"},
            "the AWS audience": {"AUDIENCE": "sts.amazonaws.com"},
            "no audience": {"AUDIENCE": ""},
            "an empty token": {"FAKE_TOKEN_REPLY": '{"value":""}'},
            "no token field": {"FAKE_TOKEN_REPLY": "{}"},
        }
        for label, change in bad_settings.items():
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                result = self.run_step(temp, "register", STEP_REGISTER, self.register_env(temp, **change), STUB_CURL)
                self.assertNotEqual(result.returncode, 0, label)
                if "api" in label or "token" in label or "audience" in label:
                    self.assertFalse((temp / "curl.log").exists() and "pos-pilot-releases" in (temp / "curl.log").read_text(encoding="utf-8"), f"{label}: nothing is sent")
        for label, body in {"a lab body": lab_body, "a body for another version": other_version}.items():
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                result = self.run_step(temp, "register", STEP_REGISTER, self.register_env(temp, body=body), STUB_CURL)
                self.assertNotEqual(result.returncode, 0, label)
                self.assertFalse((temp / "curl.log").exists(), f"{label}: nothing is requested or sent")


if __name__ == "__main__":
    unittest.main()
