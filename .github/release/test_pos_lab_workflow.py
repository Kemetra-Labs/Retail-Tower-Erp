"""RT-1082 (S2): static and step-level checks of deploy-pos-lab.yml, the POS lab feed deploy.

deploy-pos-lab.yml lives in the root .github/, so its checks live here and run in
project-graph-selftest (`python -m unittest discover -s .github/release`), next to the Console lab
checks whose helpers are reused. The SSM document it runs,
services/backend-core/deploy/lab/ssm/RT-PosLabFeedDeploy.yaml, is checked by Backend-Core's
apps/api/test/deploy/lab-ssm-documents.spec.ts.

The guard and the lab.yml check are run for real with bash (CI is Linux; locally only when bash works).
"""

import base64
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_console_lab_workflow import HAVE_BASH, ROOT, WORKFLOWS, job, read, run_step, step_script, triggers  # noqa: E402

DOCUMENT = ROOT / "services" / "backend-core" / "deploy" / "lab" / "ssm" / "RT-PosLabFeedDeploy.yaml"
RELEASE_WORKFLOW = WORKFLOWS / "release-pos.yml"


def document_parameters() -> list[str]:
    block = re.search(r"^parameters:\n((?:  .*\n)+)", read(DOCUMENT), re.M).group(1)
    return re.findall(r"^  ([A-Z][A-Za-z]+):$", block, re.M)


def lab_yml(version: str, sha512: str, size: int, path: str | None = None) -> str:
    exe = path or f"POS-Pulse-LAB-Setup-{version}.exe"
    return (f"version: {version}\nfiles:\n  - url: {exe}\n    sha512: {sha512}\n    size: {size}\n"
            f"path: {exe}\nsha512: {sha512}\nreleaseDate: '2026-11-03T10:00:00.000Z'\n")


class DeployPosLab(unittest.TestCase):
    text = read(WORKFLOWS / "deploy-pos-lab.yml")

    def test_every_action_is_pinned_by_sha(self):
        uses = re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", self.text, re.M)
        self.assertTrue(uses)
        for ref in uses:
            self.assertRegex(ref, r"^[\w./-]+@[0-9a-f]{40}$")

    def test_actions_are_the_ones_the_console_deploy_pins(self):
        console = set(re.findall(r"uses:\s*(\S+)", read(WORKFLOWS / "deploy-console-lab.yml")))
        self.assertLessEqual(set(re.findall(r"uses:\s*(\S+)", self.text)), console)

    def test_permissions_empty_at_the_top(self):
        self.assertRegex(self.text, r"(?m)^permissions: \{\}$")

    def test_dispatch_is_the_only_trigger(self):
        self.assertEqual(triggers(self.text), ["workflow_dispatch"])

    def test_inputs_never_expanded_inside_run_scripts(self):
        for block in re.findall(r"run: \|\n((?:          .*\n|\n)+)", self.text):
            self.assertNotIn("${{", block, block[:200])

    def test_inputs_and_dry_run_default(self):
        head = self.text.split("jobs:")[0]
        self.assertEqual(re.findall(r"(?m)^      ([a-z_]+):$", head), ["pos_release", "jira_key", "dry_run"])
        self.assertRegex(head, r"(?m)^      dry_run:\n(?:        .*\n)*?        default: true$")

    def test_concurrency_shared_with_the_other_lab_paths(self):
        self.assertRegex(self.text, r"(?m)^concurrency:\n  group: deploy-aws-lab\n  cancel-in-progress: false$")
        for other in ("deploy-lab.yml", "deploy-erp-lab.yml", "deploy-console-lab.yml"):
            self.assertIn("group: deploy-aws-lab", read(WORKFLOWS / other))

    def test_main_only_in_both_jobs(self):
        self.assertIn('[ "$RUN_REF" = "refs/heads/main" ]', job(self.text, "preflight"))
        self.assertIn('[ "$RUN_REF" = "refs/heads/main" ]', job(self.text, "live"))

    def test_environment_and_id_token_only_on_live(self):
        self.assertEqual(self.text.count("environment: aws-lab"), 1)
        live, pre = job(self.text, "live"), job(self.text, "preflight")
        self.assertIn("environment: aws-lab", live)
        self.assertIn("id-token: write", live)
        self.assertNotIn("id-token", pre)
        self.assertNotIn(": write", pre)

    def test_live_only_after_preflight_and_never_on_a_dry_run(self):
        live = job(self.text, "live")
        self.assertIn("needs: preflight", live)
        self.assertIn("if: ${{ inputs.dry_run == false }}", live)
        self.assertIn('[ "$DRY_RUN" = "false" ] || fail', live)

    def test_preflight_runs_no_repository_code(self):
        self.assertNotIn("actions/checkout", job(self.text, "preflight"))

    def test_preflight_verifies_the_release_and_its_attestation_for_the_tag(self):
        pre = job(self.text, "preflight")
        self.assertIn(".isImmutable == true and .isDraft == false", pre)
        self.assertIn("compare/$SHA...main", pre)
        self.assertIn('sha256sum --check --strict "$EXE.sha256"', pre)
        self.assertIn("--signer-workflow Kemetra-Labs/Retail-Tower-Erp/.github/workflows/release-pos.yml", pre)
        self.assertIn('--source-ref "refs/tags/$POS_RELEASE"', pre)
        self.assertIn('gh attestation verify "$DL/$EXE"', pre)

    def test_preflight_requires_exactly_the_assets_release_pos_publishes(self):
        pre = step_script(self.text, "Verify the POS release")
        assets = '"$EXE" "$EXE.blockmap" "$EXE.sha256" lab.yml release-manifest.json'
        # A release from before RT-1261 holds the five lab assets; a later one also holds the package zip.
        self.assertIn(f"FIVE=\"$(printf '%s\\n' {assets} | sort", pre)
        self.assertIn(f"SIX=\"$(printf '%s\\n' {assets} \"$ZIP\" | sort", pre)
        self.assertIn('ZIP="POS-Pulse-$VERSION-win-x64.zip"', pre)
        # S1: the publish step of release-pos.yml lists the same six files, with the same zip name.
        release = read(RELEASE_WORKFLOW)
        self.assertIn('"$EXE" "$EXE.blockmap" lab.yml "$EXE.sha256" release-manifest.json "$ZIP"', release)
        self.assertIn('ZIP="POS-Pulse-$VERSION-win-x64.zip"', release)

    def test_preflight_binds_the_manifest_names_to_the_downloaded_files(self):
        pre = step_script(self.text, "Verify the POS release")
        for name in ("pos-installer", "pos-blockmap", "pos-channel", "pos-package"):
            self.assertIn(f'select(.name == "{name}"', pre)
            # the names release-pos.yml records in the manifest
            self.assertIn(f"--artifact \"{name}=", read(RELEASE_WORKFLOW))
        self.assertIn('.product == "pos" and .mode == "release" and .tag == $tag and .source.sha == $sha', pre)
        # Three artifacts without the package (a five-asset release), four with it.
        self.assertIn("(.artifacts | length == 3)", pre)
        self.assertIn("(.artifacts | length == 4)", pre)

    @unittest.skipUnless(shutil.which("jq"), "jq is needed")
    def test_manifest_predicate_matches_the_release_shape(self):
        program = re.search(r"--arg zip \"\$ZIP\" --arg package \"\$PACKAGE\" '\n(.*?)\n            ' \"\$DL",
                            self.text, re.S).group(1)
        digest = {key: "sha256:" + key * 64 for key in "1234"}
        five = {"product": "pos", "mode": "release", "tag": "pos/v0.1.2", "source": {"sha": "a" * 40}, "artifacts": [
            {"name": "pos-installer", "file": "E", "digest": digest["1"]},
            {"name": "pos-blockmap", "file": "E.blockmap", "digest": digest["2"]},
            {"name": "pos-channel", "file": "lab.yml", "digest": digest["3"]}]}
        six = {**five, "artifacts": [*five["artifacts"], {"name": "pos-package", "file": "Z", "digest": digest["4"]}]}
        renamed = {**five, "artifacts": [*five["artifacts"], {"name": "pos-package", "file": "Y", "digest": digest["4"]}]}

        def accepts(manifest: dict, package: str) -> bool:
            args = ["--arg", "tag", "pos/v0.1.2", "--arg", "sha", "a" * 40, "--arg", "exe", "E",
                    "--arg", "exe_digest", digest["1"], "--arg", "map", "E.blockmap", "--arg", "map_digest", digest["2"],
                    "--arg", "yml", "lab.yml", "--arg", "yml_digest", digest["3"], "--arg", "zip", "Z",
                    "--arg", "package", package]
            return subprocess.run(["jq", "-e", *args, program], input=json.dumps(manifest), capture_output=True,
                                  text=True, check=False).returncode == 0

        self.assertTrue(accepts(five, "absent"), "a release from before RT-1261 must still verify")
        self.assertTrue(accepts(six, "present"))
        self.assertFalse(accepts(six, "absent"), "a manifest that records a package the release does not hold")
        self.assertFalse(accepts(five, "present"), "a release package the manifest does not record")
        self.assertFalse(accepts(renamed, "present"), "a package recorded under another name")

    def test_the_package_never_reaches_the_feed(self):
        pre = step_script(self.text, "Verify the POS release")
        download = next(line for line in pre.splitlines() if "--pattern" in line)
        self.assertNotIn("$ZIP", download)
        self.assertNotIn("win-x64.zip", job(self.text, "live"))
        self.assertNotIn("win-x64.zip", read(DOCUMENT))

    def test_lab_yml_is_checked_before_the_ledger(self):
        pre = job(self.text, "preflight")
        self.assertLess(pre.index("- name: Verify the POS release"), pre.index("- name: Check lab.yml against the installer"))
        self.assertLess(pre.index("- name: Check lab.yml against the installer"), pre.index("- name: Write the planned ledger"))

    def test_environment_gate_is_read_back_before_live(self):
        pre = job(self.text, "preflight")
        self.assertIn("repos/$REPO/environments/aws-lab", pre)
        self.assertIn("environment_gate", pre)
        self.assertIn('[ "$ENVIRONMENT_GATE" = "reviewed" ]', job(self.text, "live"))

    def test_ledgers_are_named_for_the_run(self):
        self.assertIn("name: pos-lab-planned-${{ github.run_id }}", self.text)
        self.assertIn("name: pos-lab-live-${{ github.run_id }}", self.text)
        self.assertIn('then "deployed" else "failed" end', job(self.text, "live"))

    def test_node_by_tags_lab01(self):
        live = job(self.text, "live")
        self.assertIn('"Key=tag:Environment,Values=lab" "Key=tag:Host,Values=lab-01"', live)
        self.assertIn("^mi-[0-9a-f]{17}$", live)

    def test_only_the_feed_document_is_sent_with_its_exact_parameters(self):
        live = job(self.text, "live")
        self.assertEqual(re.findall(r"--document-name (\S+)", live), ["RT-PosLabFeedDeploy"])
        self.assertNotIn("AWS-RunShellScript", self.text)
        self.assertNotIn("start-session", self.text)
        params = re.findall(r"\b([A-Z][A-Za-z]+): \[\$", live)
        self.assertEqual(sorted(params), sorted(document_parameters()))
        self.assertEqual(len(params), 5)

    def test_only_strict_result_lines_reach_the_log(self):
        live = job(self.text, "live")
        self.assertIn("RESULT_RE='^RT_(GATE|FAIL|PRIOR|TARGET|SWAP|REVERT|PRUNE|DONE)( [A-Za-z0-9=:._/-]+)*$'", live)
        self.assertIn('| grep -E "$RESULT_RE" > "$LIVE/deploy.lines"', live)
        self.assertIn('grep -qxF "RT_DONE release=$POS_RELEASE"', live)

    def test_every_line_the_document_prints_matches_the_strict_pattern(self):
        pattern = re.compile(r"^RT_(GATE|FAIL|PRIOR|TARGET|SWAP|REVERT|PRUNE|DONE)( [A-Za-z0-9=:._/-]+)*$")
        sample = {"$1": "G-Host", "$*": "version-not-higher", "$GATE": "G-Smoke", "$PRIOR": "0.1.1", "$VERSION": "0.1.2",
                  "$KEPT": "4", "$REMOVED": "2", "$RELEASE_TAG": "pos/v0.1.2"}
        says = re.findall(r'say "(RT_[^"]*)"', read(DOCUMENT))
        self.assertTrue(says)
        for line in says:
            for var, value in sample.items():
                line = line.replace(var, value)
            self.assertRegex(line, pattern)

    def test_polling_outlasts_the_document(self):
        timeout = int(re.search(r'timeoutSeconds: "([0-9]+)"', read(DOCUMENT)).group(1))
        deadline = int(re.search(r"DEADLINE=\$\(\( \$\(date \+%s\) \+ ([0-9]+) \)\)", job(self.text, "live")).group(1))
        self.assertGreater(deadline, timeout)
        minutes = int(re.search(r"(?m)^    timeout-minutes: ([0-9]+)$", job(self.text, "live")).group(1))
        self.assertGreater(minutes * 60, deadline)

    def test_claims_are_printed_for_this_workflow_file(self):
        self.assertIn("--workflow-file deploy-pos-lab.yml", job(self.text, "live"))

    @unittest.skipUnless(HAVE_BASH, "bash not available")
    def test_guard_refuses_other_refs_and_malformed_inputs(self):
        guard = step_script(self.text, "Guard (main only, validated inputs)")
        good = {"RUN_REF": "refs/heads/main", "POS_RELEASE": "pos/v0.1.1", "JIRA_KEY": "RT-1082", "DRY_RUN": "true"}
        self.assertEqual(run_step(guard, good).returncode, 0)
        for key, bad in (("RUN_REF", "refs/heads/feature"), ("POS_RELEASE", "pos/v0.1"), ("POS_RELEASE", "pos-v0.1.1"),
                         ("POS_RELEASE", "pos/v0.1.1; id"), ("POS_RELEASE", "admin-console/v0.1.1"),
                         ("JIRA_KEY", "RT-0"), ("DRY_RUN", "maybe")):
            result = run_step(guard, {**good, key: bad})
            self.assertNotEqual(result.returncode, 0, f"{key}={bad} passed the guard")

    @unittest.skipUnless(HAVE_BASH, "bash not available")
    def test_preflight_checks_lab_yml_against_the_installer(self):
        check = step_script(self.text, "Check lab.yml against the installer")
        with tempfile.TemporaryDirectory() as tmp:
            release = Path(tmp) / "release"
            release.mkdir()
            installer = bytes(range(256)) * 400
            (release / "POS-Pulse-LAB-Setup-0.1.2.exe").write_bytes(installer)
            sha512 = base64.b64encode(hashlib.sha512(installer).digest()).decode()
            env = {"RUNNER_TEMP": tmp.replace("\\", "/"), "POS_RELEASE": "pos/v0.1.2"}

            def run(yml: str):
                (release / "lab.yml").write_text(yml, encoding="utf-8", newline="\n")
                return run_step(check, env)

            ok = run(lab_yml("0.1.2", sha512, len(installer)))
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            good = lab_yml("0.1.2", sha512, len(installer))
            for name, yml in (
                ("sha512", lab_yml("0.1.2", base64.b64encode(hashlib.sha512(b"other").digest()).decode(), len(installer))),
                ("size", lab_yml("0.1.2", sha512, len(installer) + 1)),
                ("version", lab_yml("0.1.3", sha512, len(installer), "POS-Pulse-LAB-Setup-0.1.2.exe")),
                ("path", lab_yml("0.1.2", sha512, len(installer), "POS-Pulse-LAB-Setup-0.1.1.exe")),
                ("one sha512 of two", good.replace(f"    sha512: {sha512}", "    sha512: other", 1)),
                ("no size", re.sub(r"(?m)^    size: .*\n", "", good)),
                ("two versions", good + "version: 0.1.2\n"),
            ):
                self.assertNotEqual(run(yml).returncode, 0, f"a lab.yml with a wrong {name} passed")


if __name__ == "__main__":
    unittest.main()
