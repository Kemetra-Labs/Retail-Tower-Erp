"""RT-1007: static checks of the root workflow of the Admin Console lab deploy path.

deploy-console-lab.yml lives in the root .github/, and the project graph forbids a product's tests
from reading outside the product, so its checks live here and run in project-graph-selftest
(`python -m unittest discover -s .github/release`), as RT-927 does for the ERP lab path. The SSM
document it runs, services/backend-core/deploy/lab/ssm/RT-ConsoleLabDeploy.yaml, is checked by
Backend-Core's apps/api/test/deploy/lab-ssm-documents.spec.ts.

The guard and pin-rule steps are run for real with bash (CI is Linux; locally only when bash works).
"""

import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
DOCUMENT = ROOT / "services" / "backend-core" / "deploy" / "lab" / "ssm" / "RT-ConsoleLabDeploy.yaml"
SHA = "f351186493df79c4fdd781ad7416594cf4eaac92"
OTHER = "35114fd49d7765dccf4e4c9f3b5c3a6e2d6dd828"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def job(text: str, name: str) -> str:
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [a-z][a-z0-9_-]*:\n|\Z)", text, re.M | re.S)
    if not match:
        raise AssertionError(f"job {name} missing")
    return match.group(1)


def step_script(text: str, name: str) -> str:
    """The `run: |` body of the step whose name starts with `name`, dedented as Actions runs it."""
    match = re.search(rf"^      - name: {re.escape(name)}.*?\n(.*?)(?=^      - name: |\Z)", text, re.M | re.S)
    if not match:
        raise AssertionError(f"step {name} missing")
    body = re.search(r"^        run: \|\n((?:          .*\n|\n)+)", match.group(1), re.M)
    if not body:
        raise AssertionError(f"step {name} has no run script")
    return "\n".join(line[10:] for line in body.group(1).split("\n"))


def triggers(text: str) -> list[str]:
    block = re.search(r'^"on":\n((?:  .*\n|\n)+)', text, re.M).group(1)
    return re.findall(r"^  ([a-z_]+):", block, re.M)


def document_parameters() -> list[str]:
    block = re.search(r"^parameters:\n((?:  .*\n)+)", read(DOCUMENT), re.M).group(1)
    return re.findall(r"^  ([A-Z][A-Za-z]+):$", block, re.M)


# One resolved bash for the probe and the runs (a bare "bash" can resolve differently on Windows).
BASH = shutil.which("bash") or ""


def _bash_works() -> bool:
    if not BASH:
        return False
    probe = subprocess.run([BASH, "-c", "printf ok"], capture_output=True, text=True, check=False)
    return probe.returncode == 0 and probe.stdout == "ok"


HAVE_BASH = _bash_works()
if not HAVE_BASH and os.environ.get("CI"):
    raise RuntimeError("bash is required in CI for the deploy-console-lab step checks")


def run_step(script: str, env: dict[str, str]) -> subprocess.CompletedProcess:
    """Runs one step's script with only the given variables (plus PATH), as Actions would."""
    return subprocess.run([BASH, "-c", script], capture_output=True, text=True, check=False,
                          env={"PATH": os.environ.get("PATH", ""), **env})


class DeployConsoleLab(unittest.TestCase):
    text = read(WORKFLOWS / "deploy-console-lab.yml")

    def test_every_action_is_pinned_by_sha(self):
        uses = re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", self.text, re.M)
        self.assertTrue(uses)
        for ref in uses:
            self.assertRegex(ref, r"^[\w./-]+@[0-9a-f]{40}$")

    def test_permissions_empty_at_the_top(self):
        self.assertRegex(self.text, r"(?m)^permissions: \{\}$")

    def test_dispatch_is_the_only_trigger(self):
        self.assertEqual(triggers(self.text), ["workflow_dispatch"])

    def test_inputs_never_expanded_inside_run_scripts(self):
        for block in re.findall(r"run: \|\n((?:          .*\n|\n)+)", self.text):
            self.assertNotIn("${{", block, block[:200])

    def test_inputs_and_dry_run_default(self):
        head = self.text.split("jobs:")[0]
        for name in ("console_release", "backend_release", "jira_key", "dry_run"):
            self.assertRegex(head, rf"(?m)^      {name}:$")
        self.assertRegex(head, r"(?m)^      dry_run:\n(?:        .*\n)*?        default: true$")

    def test_concurrency_shared_with_the_other_lab_paths(self):
        self.assertRegex(self.text, r"(?m)^concurrency:\n  group: deploy-aws-lab\n  cancel-in-progress: false$")
        for other in ("deploy-lab.yml", "deploy-erp-lab.yml"):
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

    def test_preflight_runs_no_repository_code(self):
        self.assertNotIn("actions/checkout", job(self.text, "preflight"))

    def test_preflight_verifies_the_release_and_its_attestation_for_the_tag(self):
        pre = job(self.text, "preflight")
        self.assertIn(".isImmutable == true and .isDraft == false", pre)
        self.assertIn('compare/$SHA...main', pre)
        self.assertIn('sha256sum --check --strict "$REL.tar.gz.sha256"', pre)
        self.assertIn("--signer-workflow Kemetra-Labs/Retail-Tower-Erp/.github/workflows/release-admin-console.yml", pre)
        self.assertIn('--source-ref "refs/tags/$CONSOLE_RELEASE"', pre)
        self.assertIn("'.app == \"retail-tower-console\" and .sha == $sha'", pre)

    def test_pin_rule_runs_before_the_ledger_and_the_live_job(self):
        pre = job(self.text, "preflight")
        self.assertLess(pre.index("- name: Apply the pin rule"), pre.index("- name: Write the planned ledger"))
        self.assertIn('[ "$PIN" = "$BACKEND_SHA" ]', step_script(self.text, "Apply the pin rule"))

    def test_environment_gate_is_read_back_before_live(self):
        pre = job(self.text, "preflight")
        self.assertIn("repos/$REPO/environments/aws-lab", pre)
        self.assertIn("environment_gate", pre)
        self.assertIn('[ "$ENVIRONMENT_GATE" = "reviewed" ]', job(self.text, "live"))

    def test_node_by_tags_lab01(self):
        live = job(self.text, "live")
        self.assertIn('"Key=tag:Environment,Values=lab" "Key=tag:Host,Values=lab-01"', live)
        self.assertIn("^mi-[0-9a-f]{17}$", live)

    def test_only_the_console_document_is_sent_with_its_exact_parameters(self):
        live = job(self.text, "live")
        self.assertEqual(re.findall(r"--document-name (\S+)", live), ["RT-ConsoleLabDeploy"])
        self.assertNotIn("AWS-RunShellScript", self.text)
        self.assertNotIn("start-session", self.text)
        params = re.findall(r"\b([A-Z][A-Za-z]+): \[\$", live)
        self.assertEqual(sorted(params), sorted(document_parameters()))

    def test_only_strict_result_lines_reach_the_log(self):
        live = job(self.text, "live")
        self.assertIn("RESULT_RE='^RT_(GATE|FAIL|PRIOR|TARGET|SWAP|REVERT|DONE)( [A-Za-z0-9=:._/-]+)*$'", live)
        self.assertIn('| grep -E "$RESULT_RE" > "$LIVE/deploy.lines"', live)
        self.assertIn('grep -qxF "RT_DONE release=$CONSOLE_RELEASE"', live)

    def test_claims_are_printed_for_this_workflow_file(self):
        self.assertIn("--workflow-file deploy-console-lab.yml", job(self.text, "live"))

    @unittest.skipUnless(HAVE_BASH, "bash not available")
    def test_guard_refuses_other_refs_and_malformed_inputs(self):
        guard = step_script(self.text, "Guard (main only, validated inputs)")
        good = {"RUN_REF": "refs/heads/main", "CONSOLE_RELEASE": "admin-console/v0.1.0",
                "BACKEND_RELEASE": "backend-core/v0.3.2", "JIRA_KEY": "RT-1007", "DRY_RUN": "true"}
        self.assertEqual(run_step(guard, good).returncode, 0)
        for key, bad in (("RUN_REF", "refs/heads/feature"), ("CONSOLE_RELEASE", "admin-console-50d8aa029177"),
                         ("CONSOLE_RELEASE", "admin-console/v0.1.0; id"), ("BACKEND_RELEASE", "backend-core-046b7f7cff53"),
                         ("JIRA_KEY", "RT-0"), ("DRY_RUN", "maybe")):
            result = run_step(guard, {**good, key: bad})
            self.assertNotEqual(result.returncode, 0, f"{key}={bad} passed the guard")

    @unittest.skipUnless(HAVE_BASH, "bash not available")
    def test_pin_rule_passes_on_equal_commits_and_refuses_a_mismatch(self):
        rule = step_script(self.text, "Apply the pin rule")
        env = {"PIN": SHA, "BACKEND_SHA": SHA, "BACKEND_RELEASE": "backend-core/v0.3.2"}
        self.assertEqual(run_step(rule, env).returncode, 0)
        mismatch = run_step(rule, {**env, "BACKEND_SHA": OTHER})
        self.assertNotEqual(mismatch.returncode, 0)
        self.assertIn("pin rule:", mismatch.stdout + mismatch.stderr)
        for key in ("PIN", "BACKEND_SHA"):
            self.assertNotEqual(run_step(rule, {**env, key: ""}).returncode, 0)


if __name__ == "__main__":
    unittest.main()
