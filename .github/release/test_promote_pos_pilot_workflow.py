"""RT-1300: static and step-level checks of promote-pos-pilot.yml, the VERIFY-ONLY (dry-run) promotion of a
pilot release.

The workflow is policy class (root .github/), so its checks live here and run in project-graph-selftest
(`python -m unittest discover -s .github/release`), next to the pilot release checks whose helpers are reused.

What is pinned: it can be started only by hand, it holds no environment, no secret, no AWS and no Backend-Core
call (it cannot upload, sign, register or activate), the release it reads must be a pilot release on a tag that
is on main, the assets are exactly the three the pilot release publishes, the manifest and the attestation
bind them to the tag's commit, and the installer's signature is checked against a pinned leaf. The bash steps
run for real (with a stub `gh`); the PowerShell step is only parsed here, because it adds a certificate to the
machine's trust store and so runs on a hosted runner only.
"""

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
FORBIDDEN_IN_CODE = (
    "id-token", "environment:", "secrets.", "aws-actions", "configure-aws-credentials", "aws s3", "PutObject",
    "AWS_", "attestations: write", "contents: write", "/api/v1/", "Idempotency-Key", "gh release create",
    "gh release upload", "git push",
)
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
            "artifacts": [{"name": "pos-installer", "file": EXE, "digest": "sha256:" + hashlib.sha256(b"installer bytes").hexdigest()}]}
    base.update(changes)
    return base


class PromotePosPilotStatic(unittest.TestCase):
    text = read(WORKFLOW)

    @unittest.skipUnless(yaml, "PyYAML is needed")
    def test_the_file_is_valid_yaml_with_the_two_jobs(self):
        # A plain scalar such as a job name must not hold ": " (the project-graph privilege scan refuses the file).
        document = yaml.safe_load(self.text)
        self.assertEqual(list(document["jobs"]), ["resolve", "verify"])
        for name in ("resolve", "verify"):
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
        self.assertEqual(inputs, ["tag", "leaf_sha1"])

    def test_every_action_is_pinned_by_sha_and_already_pinned_by_the_pilot_release(self):
        pilot = read(WORKFLOWS / "release-pos-pilot.yml")
        pilot_uses = set(re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", pilot, re.M))
        for ref in re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", self.text, re.M):
            self.assertRegex(ref, r"^[\w./-]+@[0-9a-f]{40}$")
            self.assertIn(ref, pilot_uses, f"{ref} is not pinned by release-pos-pilot.yml")

    def test_it_can_neither_upload_nor_register_nor_authenticate_to_anything(self):
        body = code(self.text)
        for word in FORBIDDEN_IN_CODE:
            self.assertNotIn(word, body, word)
        self.assertEqual(len(re.findall(r"^    environment:", body, re.M)), 0)

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
                "FAKE_TAG_SHA": SHA}

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


if __name__ == "__main__":
    unittest.main()
