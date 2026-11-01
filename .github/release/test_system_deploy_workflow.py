"""RT-1031: static checks of deploy-system-lab.yml, the one-system lab deploy (plan RT-1029, S2).

Like the RT-927 and RT-1007 workflow checks, they live here and run in project-graph-selftest
(`python -m unittest discover -s .github/release`). They cover the guards, the document order,
stop-on-failure (no document step may run after a failed one) and that each document gets exactly
the parameters it declares and the result pattern its own workflow uses. The ledger shape is
tested in test_system_ledger.py, the document runner in test_ssm_run.py.
"""
import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
BACKEND_SSM = ROOT / "services" / "backend-core" / "deploy" / "lab" / "ssm"
ERP_DOCUMENT = ROOT / "integrations" / "erpnext-connector" / "deploy" / "lab" / "ssm" / "RT-ErpLabDeploy.json"
SHA = "f351186493df79c4fdd781ad7416594cf4eaac92"
DIGEST = "sha256:" + "a" * 64
ORDER = [("Run RT-BackendLabBackup on lab-02", "backup", "lab-02", "RT-BackendLabBackup"),
         ("Run RT-BackendLabDeploy on lab-01", "backend", "lab-01", "RT-BackendLabDeploy"),
         ("Run RT-ConsoleLabDeploy on lab-01", "console", "lab-01", "RT-ConsoleLabDeploy"),
         ("Run RT-ErpLabDeploy on lab-03", "erp", "lab-03", "RT-ErpLabDeploy")]


def read(path):
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def job(text, name):
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [a-z][a-z0-9_-]*:\n|\Z)", text, re.M | re.S)
    if not match:
        raise AssertionError(f"job {name} missing")
    return match.group(1)


def step(text, name):
    """The whole step whose name starts with `name`."""
    match = re.search(rf"^      - name: {re.escape(name)}.*?\n(.*?)(?=^      - (?:name|uses): |\Z)", text, re.M | re.S)
    if not match:
        raise AssertionError(f"step {name} missing")
    return match.group(1)


def step_script(text, name):
    body = re.search(r"^        run: \|\n((?:          .*\n|\n)+)", step(text, name), re.M)
    if not body:
        raise AssertionError(f"step {name} has no run script")
    return "\n".join(line[10:] for line in body.group(1).split("\n"))


def step_env(text, name, key):
    match = re.search(rf"^          {key}: (.*)$", step(text, name), re.M)
    if not match:
        raise AssertionError(f"step {name} has no {key}")
    value = match.group(1)
    return value[1:-1] if value.startswith("'") else value.strip('"')


def triggers(text):
    block = re.search(r'^"on":\n((?:  .*\n|\n)+)', text, re.M).group(1)
    return re.findall(r"^  ([a-z_]+):", block, re.M)


def yaml_parameters(path):
    block = re.search(r"^parameters:\n((?:  .*\n)+)", read(path), re.M).group(1)
    return re.findall(r"^  ([A-Z][A-Za-z0-9]+):$", block, re.M)


def declared_parameters(document):
    if document == "RT-ErpLabDeploy":
        return list(json.loads(read(ERP_DOCUMENT))["parameters"])
    return yaml_parameters(BACKEND_SSM / f"{document}.yaml")


def result_re_of(path):
    return re.search(r"RESULT_RE='([^']+)'", read(path)).group(1)


BASH = shutil.which("bash") or ""


def _bash_works():
    if not BASH:
        return False
    probe = subprocess.run([BASH, "-c", "printf ok"], capture_output=True, text=True, check=False)
    return probe.returncode == 0 and probe.stdout == "ok"


HAVE_BASH = _bash_works()
if not HAVE_BASH and os.environ.get("CI"):
    raise RuntimeError("bash is required in CI for the deploy-system-lab step checks")


def run_step(script, env):
    return subprocess.run([BASH, "-c", script], capture_output=True, text=True, check=False,
                          env={"PATH": os.environ.get("PATH", ""), **env})


class DeploySystemLab(unittest.TestCase):
    text = read(WORKFLOWS / "deploy-system-lab.yml")

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
        for name in ("manifest", "current_manifest", "jira_key", "dry_run"):
            self.assertRegex(head, rf"(?m)^      {name}:$")
        self.assertRegex(head, r"(?m)^      dry_run:\n(?:        .*\n)*?        default: true$")

    def test_concurrency_shared_with_the_product_lab_paths(self):
        self.assertRegex(self.text, r"(?m)^concurrency:\n  group: deploy-aws-lab\n  cancel-in-progress: false$")
        for other in ("deploy-lab.yml", "deploy-console-lab.yml", "deploy-erp-lab.yml"):
            self.assertIn("group: deploy-aws-lab", read(WORKFLOWS / other))

    def test_main_only_in_both_jobs(self):
        self.assertIn('[ "$RUN_REF" = "refs/heads/main" ]', job(self.text, "preflight"))
        self.assertIn('[ "$RUN_REF" = "refs/heads/main" ]', job(self.text, "live"))

    def test_one_approval_environment_and_id_token_only_on_live(self):
        self.assertEqual(self.text.count("environment: aws-lab"), 1)
        live, pre = job(self.text, "live"), job(self.text, "preflight")
        self.assertIn("environment: aws-lab", live)
        self.assertIn("id-token: write", live)
        self.assertNotIn("id-token", pre)
        self.assertNotIn(": write", pre)
        self.assertNotIn("aws ", pre)

    def test_live_only_after_preflight_and_never_on_a_dry_run(self):
        live = job(self.text, "live")
        self.assertIn("needs: preflight", live)
        self.assertIn("if: ${{ inputs.dry_run == false }}", live)

    def test_checkouts_never_take_a_ref(self):
        for block in re.findall(r"uses: actions/checkout@\S+.*?\n((?:        .*\n)+)", self.text):
            self.assertNotIn("ref:", block)

    def test_preflight_runs_the_offline_gate_on_both_manifests_and_g4(self):
        gate = step_script(self.text, "System release gate (offline G1-G5)")
        self.assertIn('system_gate.py --manifest "$MANIFEST" --main origin/main', gate)
        self.assertIn('system_gate.py --manifest "$CURRENT_MANIFEST" --main origin/main', gate)
        self.assertIn("--contracts-args", gate)
        self.assertIn("--only pins", gate)

    def test_preflight_reuses_the_product_checks(self):
        pre = job(self.text, "preflight")
        self.assertIn('--signer-workflow "$REPO/.github/workflows/release-backend-core.yml"', pre)
        self.assertIn("services/backend-core/deploy/lab/verify-release.cjs", pre)
        self.assertIn("check-runs?per_page=100", pre)
        self.assertIn(".isImmutable == true and .isDraft == false", pre)
        self.assertIn("--signer-workflow Kemetra-Labs/Retail-Tower-Erp/.github/workflows/release-admin-console.yml", pre)
        self.assertIn('[ "$PIN" = "$BACKEND_SHA" ]', step_script(self.text, "Apply the pin rule"))
        self.assertIn("--signer-workflow Kemetra-Labs/Retail-Tower-Erp/.github/workflows/build-erp-image.yml", pre)
        self.assertIn("integrations/erpnext-connector/deploy/lab/rollback_class.py", pre)
        self.assertIn("repos/$REPO/environments/aws-lab", pre)

    def test_pins_shared_with_the_other_workflows(self):
        base = re.search(r"BASE_DIGEST: (sha256:[0-9a-f]{64})", self.text).group(1)
        self.assertIn(f"BASE_DIGEST: {base}", read(WORKFLOWS / "deploy-erp-lab.yml"))
        contracts = read(WORKFLOWS / "contracts.yml")
        for key in ("OASDIFF_VERSION", "OASDIFF_SHA256"):
            value = re.search(rf'{key}: ("[^"]+")', self.text).group(1)
            self.assertIn(f"{key}: {value}", contracts)

    def test_the_planned_ledger_is_written_even_on_a_refusal_and_uploaded(self):
        pre = job(self.text, "preflight")
        self.assertIn("if: ${{ !cancelled() && steps.checkout.outcome == 'success' }}", step(self.text, "Write the planned system ledger"))
        self.assertIn("system_ledger.py plan", pre)
        self.assertLess(pre.index("- name: Apply the pin rule"), pre.index("- name: Write the planned system ledger"))
        self.assertIn('[ "$DRY_RUN" = "false" ] && [ "$GATE" != "reviewed" ]', step_script(self.text, "Write the planned system ledger"))

    def test_documents_run_in_the_plan_order_on_their_hosts(self):
        live = job(self.text, "live")
        positions = [live.index(f"- name: {name}") for name, *_ in ORDER]
        self.assertEqual(positions, sorted(positions))
        for name, label, host, document in ORDER:
            self.assertEqual(step_env(self.text, name, "LABEL"), label)
            self.assertEqual(step_env(self.text, name, "HOST"), host)
            self.assertEqual(step_env(self.text, name, "DOCUMENT"), document)
            self.assertIn("bash .github/release/ssm-run.sh", step_script(self.text, name))
        self.assertEqual(re.findall(r"DOCUMENT: (\S+)", live), [document for *_, document in ORDER])
        self.assertNotIn("AWS-RunShellScript", self.text)
        self.assertNotIn("start-session", self.text)

    def test_a_role_is_assumed_before_each_document(self):
        live = job(self.text, "live")
        assumes = [m.start() for m in re.finditer(r"- name: Assume the deploy role", live)]
        runs = [live.index(f"- name: {name}") for name, *_ in ORDER]
        self.assertEqual(len(assumes), len(runs))
        for assume, run in zip(assumes, runs):
            self.assertLess(assume, run)
        self.assertLess(live.index("- name: Re-check the POS compat gate after approval"), assumes[0])
        self.assertLess(live.index("- name: Print the OIDC claims"), assumes[0])

    def test_stop_at_the_first_failure(self):
        live = job(self.text, "live")
        start = live.index("- name: Assume the deploy role for the backup")
        end = live.index("- name: Write the system ledger")
        self.assertNotIn("if:", live[start:end])
        self.assertNotIn("continue-on-error", self.text)
        self.assertIn("if: always()", step(self.text, "Write the system ledger"))
        self.assertIn("system_ledger.py final", step_script(self.text, "Write the system ledger"))

    def test_each_document_gets_exactly_its_declared_parameters(self):
        for name, _, _, document in ORDER:
            sent = re.findall(r"\b([A-Z][A-Za-z0-9]+): \[", step_script(self.text, name))
            self.assertEqual(sorted(sent), sorted(declared_parameters(document)), document)

    def test_each_document_keeps_the_result_pattern_of_its_own_workflow(self):
        backend = result_re_of(WORKFLOWS / "deploy-lab.yml")
        self.assertEqual(step_env(self.text, ORDER[0][0], "RESULT_RE"), backend)
        self.assertEqual(step_env(self.text, ORDER[1][0], "RESULT_RE"), backend)
        self.assertEqual(step_env(self.text, ORDER[2][0], "RESULT_RE"), result_re_of(WORKFLOWS / "deploy-console-lab.yml"))
        self.assertEqual(step_env(self.text, ORDER[3][0], "RESULT_RE"), result_re_of(WORKFLOWS / "deploy-erp-lab.yml"))

    def test_each_document_proves_completion(self):
        self.assertIn("DONE_RE: '^RT_BACKUP name=rtlab-", step(self.text, ORDER[0][0]))
        self.assertIn('DONE_LINE="RT_DONE release=$BACKEND_RELEASE"', step_script(self.text, ORDER[1][0]))
        self.assertIn('DONE_LINE="RT_DONE release=$CONSOLE_RELEASE"', step_script(self.text, ORDER[2][0]))
        self.assertEqual(step_env(self.text, ORDER[3][0], "DONE_LINE"), "RT_OUTCOME=deployed")

    def test_the_erp_document_never_holds_or_saves_images(self):
        script = step_script(self.text, ORDER[3][0])
        self.assertIn('Hold: ["false"]', script)
        self.assertIn('SaveCurrentImage: ["false"]', script)
        self.assertEqual(step_env(self.text, ORDER[3][0], "MIN_FREE_GIB"), "10")

    def test_claims_are_printed_for_this_workflow_file(self):
        self.assertIn("--workflow-file deploy-system-lab.yml", job(self.text, "live"))

    @unittest.skipUnless(HAVE_BASH, "bash not available")
    def test_preflight_guard_refuses_other_refs_and_malformed_inputs(self):
        guard = step_script(self.text, "Guard (main only, validated inputs)")
        good = {"RUN_REF": "refs/heads/main", "MANIFEST": "system/releases/lab-2026.11.0.json",
                "CURRENT_MANIFEST": "system/releases/lab-2026.11.0.json", "JIRA_KEY": "RT-1031", "DRY_RUN": "true"}
        self.assertEqual(run_step(guard, good).returncode, 0)
        for key, bad in (("RUN_REF", "refs/heads/feature"), ("MANIFEST", "../system/releases/lab-2026.11.0.json"),
                         ("MANIFEST", "system/releases/lab-2026.11.0.json; id"), ("CURRENT_MANIFEST", "lab-2026.11.0.json"),
                         ("JIRA_KEY", "RT-0"), ("DRY_RUN", "maybe")):
            self.assertNotEqual(run_step(guard, {**good, key: bad}).returncode, 0, f"{key}={bad} passed the guard")

    @unittest.skipUnless(HAVE_BASH, "bash not available")
    def test_live_guard_needs_the_verified_plan_and_every_rule_passed(self):
        guard = step_script(self.text, "Guard (main only, live run, verified plan)")
        good = {"RUN_REF": "refs/heads/main", "DRY_RUN": "false", "MANIFEST": "system/releases/lab-2026.11.0.json",
                "CURRENT_MANIFEST": "system/releases/lab-2026.11.0.json", "JIRA_KEY": "RT-1031",
                "BACKEND_RELEASE_SHA": SHA, "API_DIGEST": DIGEST, "WORKER_DIGEST": DIGEST, "MIGRATE_DIGEST": DIGEST,
                "ROLLBACK_ALLOWED": "true", "CONSOLE_ARCHIVE_DIGEST": DIGEST, "CONSOLE_RELEASE_SHA": SHA,
                "CONSOLE_CONTRACT_PIN": SHA, "ERP_EXPECTED_VERSION": "0.1.0", "ERP_CURRENT_TREE": SHA,
                "ERP_ROLLBACK_CLASS": "image-only", "ENVIRONMENT_GATE": "reviewed",
                "GATE_RESULTS": "G1=pass G2=pass G3=pass G4=pass G5=pass G6=pass G7=pass"}
        result = run_step(guard, good)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for key, bad in (("DRY_RUN", "true"), ("ENVIRONMENT_GATE", "unverified"), ("API_DIGEST", ""),
                         ("CONSOLE_CONTRACT_PIN", "35114fd49d7765dccf4e4c9f3b5c3a6e2d6dd828"), ("ROLLBACK_ALLOWED", ""),
                         ("ERP_ROLLBACK_CLASS", "maybe"), ("GATE_RESULTS", "G1=pass G2=pass G3=pass G4=FAIL G5=pass G6=pass G7=pass"),
                         ("GATE_RESULTS", "G1=pass G2=pass G3=pass G4=pass G5=pass G6=pass G7=unverified")):
            self.assertNotEqual(run_step(guard, {**good, key: bad}).returncode, 0, f"{key}={bad} passed the live guard")


if __name__ == "__main__":
    unittest.main()
