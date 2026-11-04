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
FLAGS = {"backup": "run_backup", "backend": "run_backend", "console": "run_console", "erp": "run_erp"}
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
        for name in ("manifest", "current_manifest", "jira_key", "dry_run", "force_all"):
            self.assertRegex(head, rf"(?m)^      {name}:$")
        self.assertRegex(head, r"(?m)^      dry_run:\n(?:        .*\n)*?        default: true$")
        self.assertRegex(head, r"(?m)^      force_all:\n(?:        .*\n)*?        type: boolean\n        default: false$")

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
        # RT-1084: the preflight holds the OIDC token for one reason, the read-only state role (G9). It never
        # assumes the deploy role and writes nothing: id-token is its only `write` permission.
        self.assertEqual(pre.count("id-token: write"), 1)
        self.assertEqual(re.findall(r"^      ([a-z-]+): write", pre, re.M), ["id-token"])
        self.assertEqual(re.findall(r"^          role-to-assume: (.+)$", pre, re.M), ["${{ vars.AWS_STATE_READ_ROLE_ARN }}"])
        self.assertNotIn("AWS_ROLE_ARN", pre.replace("AWS_STATE_READ_ROLE_ARN", ""))
        self.assertNotIn("put-parameter", pre)
        self.assertNotIn("ssm-run.sh", pre)
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

    def test_g8_checks_the_live_lab_after_the_gate_and_before_any_online_evidence(self):
        pre = job(self.text, "preflight")
        script = step_script(self.text, "Live lab check (G8")
        self.assertIn('python3 .github/release/live_check.py --repo "$REPO" --current-manifest "$CURRENT_MANIFEST"', script)
        self.assertIn('--gates-file "$RUNNER_TEMP/plan/gates.txt"', script)
        self.assertEqual(step_env(self.text, "Live lab check (G8", "GH_TOKEN"), "${{ github.token }}")
        self.assertLess(pre.index("- name: System release gate"), pre.index("- name: Live lab check (G8"))
        self.assertLess(pre.index("- name: Live lab check (G8"), pre.index("- name: Log in to GHCR"))
        self.assertIn("actions: read", pre)
        self.assertNotIn("actions: write", self.text)

    def test_a_g8_refusal_stops_the_live_job_through_the_guard_and_the_plan(self):
        plan = step(self.text, "Write the planned system ledger")
        self.assertIn("OUTCOME_LIVE_LAB: ${{ steps.live_lab.outcome }}", plan)
        self.assertIn(" LIVE_LAB ", re.search(r"for NAME in ([A-Z_ ]+); do", plan).group(1))
        self.assertIn("G8=pass", step_script(self.text, "Guard (main only, live run, verified plan)"))

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

    def test_every_preflight_check_step_must_succeed_for_a_planned_ledger(self):
        plan = step(self.text, "Write the planned system ledger")
        loop = re.search(r"for NAME in ([A-Z_ ]+); do", plan).group(1).split()
        self.assertIn('if [ "${!VAR}" != success ]', plan)
        ids = re.findall(r"^        id: ([a-z_]+)$", job(self.text, "preflight"), re.M)
        exempt = {"guard", "checkout", "logout", "plan"}
        for step_id in ids:
            if step_id in exempt:
                continue
            name = {"backend_plan": "BACKEND", "pin_rule": "PIN"}.get(step_id, step_id.upper())
            self.assertIn(name, loop, step_id)
            self.assertIn(f"OUTCOME_{name}: ${{{{ steps.{step_id}.outcome }}}}", plan)
        self.assertIn('cp -R "$RUNNER_TEMP/backend-ledger" "$RUNNER_TEMP/plan/backend-core"', plan)

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
        assumes = [m.start() for m in re.finditer(r"- name: Assume the deploy role for the", live)]
        runs = [live.index(f"- name: {name}") for name, *_ in ORDER]
        self.assertEqual(len(assumes), len(runs))
        for assume, run in zip(assumes, runs):
            self.assertLess(assume, run)
        self.assertLess(live.index("- name: Re-check the POS compat gate after approval"), assumes[0])
        self.assertLess(live.index("- name: Print the OIDC claims"), assumes[0])

    def test_stop_at_the_first_failure(self):
        """RT-1085: the only `if:`s between the first role and the ledger are the step plan's own flags.
        They hold no status function, so GitHub adds success() and a failed step still stops the rest."""
        live = job(self.text, "live")
        start = live.index("- name: Assume the deploy role for the backup")
        end = live.index("- name: Write the system ledger")
        conditions = re.findall(r"^        if: (.*)$", live[start:end], re.M)
        self.assertEqual(len(conditions), 2 * len(ORDER))
        for condition in conditions:
            self.assertRegex(condition, r"^\$\{\{ needs\.preflight\.outputs\.run_(backup|backend|console|erp) == 'true' \}\}$")
            for status in ("always()", "failure()", "cancelled()", "success()"):
                self.assertNotIn(status, condition)
        self.assertNotIn("continue-on-error", self.text)
        self.assertIn("if: always()", step(self.text, "Write the system ledger"))
        self.assertIn("system_ledger.py final", step_script(self.text, "Write the system ledger"))

    def test_each_role_and_document_runs_on_its_own_step_flag(self):
        live = job(self.text, "live")
        assumes = [m.start() for m in re.finditer(r"- name: Assume the deploy role for the", live)]
        for (name, label, *_), assume in zip(ORDER, assumes):
            flag = f"if: ${{{{ needs.preflight.outputs.{FLAGS[label]} == 'true' }}}}"
            self.assertIn(flag, step(self.text, name))
            self.assertIn(flag, live[assume:live.index(f"- name: {name}")])

    def test_the_step_plan_reaches_the_live_job_and_its_ledger(self):
        pre = job(self.text, "preflight")
        for flag in (*FLAGS.values(), "run_steps"):
            self.assertIn(f"{flag}: ${{{{ steps.plan.outputs.{flag} }}}}", pre)
        plan = step_script(self.text, "Write the planned system ledger")
        for key in ("target_backend_release", "current_backend_release", "target_console_release", "current_console_release"):
            self.assertIn(f'--commit "{key}=$(tag_sha "${key.upper()}")"', plan)
        self.assertIn('git rev-parse --verify --quiet "refs/tags/$1^{commit}"', plan)
        self.assertIn("$LIVE_FLAG $FORCE_FLAG", plan)
        self.assertIn('"run_\\(.step)=\\(.action == "run")"', plan)
        self.assertEqual(step_env(self.text, "Write the planned system ledger", "FORCE_ALL"), "${{ inputs.force_all }}")
        self.assertEqual(step_env(self.text, "Write the system ledger", "RUN_STEPS"), "${{ needs.preflight.outputs.run_steps }}")
        self.assertIn('--run-steps "$RUN_STEPS"', step_script(self.text, "Write the system ledger"))

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
                "CURRENT_MANIFEST": "system/releases/lab-2026.11.0.json", "JIRA_KEY": "RT-1031", "DRY_RUN": "true", "FORCE_ALL": "false"}
        self.assertEqual(run_step(guard, good).returncode, 0)
        for key, bad in (("RUN_REF", "refs/heads/feature"), ("MANIFEST", "../system/releases/lab-2026.11.0.json"),
                         ("MANIFEST", "system/releases/lab-2026.11.0.json; id"), ("CURRENT_MANIFEST", "lab-2026.11.0.json"),
                         ("JIRA_KEY", "RT-0"), ("DRY_RUN", "maybe"), ("FORCE_ALL", ""), ("FORCE_ALL", "yes")):
            self.assertNotEqual(run_step(guard, {**good, key: bad}).returncode, 0, f"{key}={bad} passed the guard")

    @unittest.skipUnless(HAVE_BASH, "bash not available")
    # ---- RT-1084: the live-state record (G9), one resolved current manifest, the inflight marker

    def test_current_manifest_is_resolved_once_and_never_read_from_the_input_again(self):
        """Only the first guard (a pattern check of the optional input) and the state step read the input;
        every other step of both jobs takes the one resolved value."""
        self.assertEqual(self.text.count("inputs.current_manifest"), 3)  # guard, state step, and a comment
        self.assertIn("${{ inputs.current_manifest }}", step(self.text, "Guard (main only, validated inputs)"))
        self.assertIn("${{ inputs.current_manifest }}", step(self.text, "Read the live-state record (G9, resolves current_manifest)"))
        pre, live = job(self.text, "preflight"), job(self.text, "live")
        for name in ("Read the manifests", "System release gate (offline G1-G5)", "Live lab check (G8, current_manifest matches the live ledgers)",
                     "Write the planned system ledger"):
            self.assertEqual(step_env(pre, name, "CURRENT_MANIFEST"), "${{ steps.state.outputs.manifest }}", name)
        for name in ("Guard (main only, live run, verified plan)", "Read the manifests", "Write the system ledger"):
            self.assertEqual(step_env(live, name, "CURRENT_MANIFEST"), "${{ needs.preflight.outputs.current_manifest }}", name)
        self.assertIn("current_manifest: ${{ steps.state.outputs.manifest }}", pre)
        self.assertIn("required: false", re.search(r"      current_manifest:\n(?:        .*\n)+", self.text).group(0))
        guard = step_script(self.text, "Guard (main only, validated inputs)")
        self.assertIn('[ -z "$CURRENT_MANIFEST" ] ||', guard)

    def test_the_state_steps_come_after_the_checkout_and_before_any_manifest_is_read(self):
        pre = job(self.text, "preflight")
        order = [pre.index(f"- name: {name}") for name in (
            "Checkout main", "Assume the state-read role", "Read the live-state record (G9, resolves current_manifest)", "Read the manifests",
            "System release gate (offline G1-G5)", "Live lab check (G8")]
        self.assertEqual(order, sorted(order))
        self.assertNotRegex(step(pre, "Assume the state-read role"), r"(?m)^        if:")
        self.assertNotRegex(step(pre, "Read the live-state record"), r"(?m)^        if:")  # a failed assume or read stops every later step
        self.assertIn("live_state.py read", step_script(pre, "Read the live-state record"))
        self.assertIn('>> "$GITHUB_OUTPUT"', step_script(pre, "Read the live-state record"))
        # the gate step must not truncate the G9 line the state step wrote
        self.assertNotIn(': > "$GATES"', step_script(pre, "System release gate (offline G1-G5)"))

    def test_the_state_read_credentials_reach_no_later_preflight_step(self):
        pre = job(self.text, "preflight")
        drop = step(pre, "Drop the state-read credentials from the environment")
        self.assertIn("if: ${{ always() && steps.state_auth.outcome == 'success' }}", drop)
        script = step_script(pre, "Drop the state-read credentials from the environment")
        for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION"):
            self.assertIn(name, script)
        self.assertIn('>> "$GITHUB_ENV"', script)
        order = [pre.index(f"- name: {name}") for name in (
            "Read the live-state record (G9, resolves current_manifest)", "Drop the state-read credentials from the environment", "Read the manifests")]
        self.assertEqual(order, sorted(order))

    def test_g8_is_not_changed_and_g9_is_its_own_rule(self):
        pre = job(self.text, "preflight")
        script = step_script(pre, "Live lab check (G8, current_manifest matches the live ledgers)")
        self.assertIn("live_check.py", script)
        self.assertNotIn("live_state", script)
        plan = step(pre, "Write the planned system ledger")
        self.assertIn("for NAME in STATE_AUTH STATE VALUES GATE LIVE_LAB", plan)
        self.assertIn("OUTCOME_STATE_AUTH: ${{ steps.state_auth.outcome }}", plan)
        self.assertIn("OUTCOME_STATE: ${{ steps.state.outcome }}", plan)
        # a refused G9 leaves no current manifest: the ledger is still written, refused, with no --current-manifest
        self.assertIn('CURRENT_ARGS=(--current-manifest "$CURRENT_MANIFEST")', plan)
        self.assertIn("if: ${{ !cancelled() && steps.checkout.outcome == 'success' }}", plan)

    def test_the_live_job_marks_the_record_before_any_document_and_records_after_the_ledger(self):
        live = job(self.text, "live")
        order = [live.index(f"- name: {name}") for name in (
            "Guard (main only, live run, verified plan)", "Checkout main", "Re-check the POS compat gate after approval", "Print the OIDC claims",
            "Assume the deploy role to mark the live-state record", "Mark the live-state record inflight", "Assume the deploy role for the backup",
            "Run RT-BackendLabBackup on lab-02", "Write the system ledger", "Assume the deploy role to record the outcome", "Record the live state",
            "Upload the system ledger")]
        self.assertEqual(order, sorted(order))
        begin = step(live, "Mark the live-state record inflight")
        self.assertNotRegex(begin, r"(?m)^        if:")  # a failed marker stops every later step: no document is sent
        script = step_script(live, "Mark the live-state record inflight")
        for text in ("live_state.py begin --kind system", '--expect-version "$STATE_VERSION"', '--expect-sha256 "$STATE_SHA256"', '--run-steps "$RUN_STEPS"'):
            self.assertIn(text, script)
        for name in ("Assume the deploy role to record the outcome", "Record the live state"):
            self.assertIn("if: ${{ always() && steps.begin.outcome == 'success' }}", step(live, name), name)
        finish = step_script(live, "Record the live state")
        for text in ("live_state.py finish --kind system", "ledger.json", '--begin-version "$BEGIN_VERSION"', '--manifest "$MANIFEST"'):
            self.assertIn(text, finish)
        self.assertIn("if: always()", step(live, "Upload the system ledger"))
        self.assertNotIn("continue-on-error", self.text)

    def test_the_ledgers_carry_the_live_state_the_preflight_read(self):
        self.assertIn("--state-version", step_script(job(self.text, "preflight"), "Write the planned system ledger"))
        self.assertIn("--state-version", step_script(job(self.text, "live"), "Write the system ledger"))

    def test_the_lab_deploy_lock_is_the_shared_one(self):
        self.assertRegex(self.text, r"(?m)^concurrency:\n  group: deploy-aws-lab\n  cancel-in-progress: false$")

    def test_live_guard_needs_the_verified_plan_and_every_rule_passed(self):
        guard = step_script(self.text, "Guard (main only, live run, verified plan)")
        good = {"RUN_REF": "refs/heads/main", "DRY_RUN": "false", "MANIFEST": "system/releases/lab-2026.11.0.json",
                "CURRENT_MANIFEST": "system/releases/lab-2026.11.0.json", "JIRA_KEY": "RT-1031",
                "BACKEND_RELEASE_SHA": SHA, "API_DIGEST": DIGEST, "WORKER_DIGEST": DIGEST, "MIGRATE_DIGEST": DIGEST,
                "ROLLBACK_ALLOWED": "true", "CONSOLE_ARCHIVE_DIGEST": DIGEST, "CONSOLE_RELEASE_SHA": SHA,
                "CONSOLE_CONTRACT_PIN": SHA, "ERP_EXPECTED_VERSION": "0.1.0", "ERP_CURRENT_TREE": SHA,
                "ERP_ROLLBACK_CLASS": "image-only", "ENVIRONMENT_GATE": "reviewed",
                "GATE_RESULTS": "G1=pass G2=pass G3=pass G4=pass G5=pass G6=pass G7=pass G8=pass G9=pass",
                "STATE_VERSION": "1", "STATE_SHA256": "a" * 64, "MANIFEST_SOURCE": "record",
                "RUN_BACKUP": "true", "RUN_BACKEND": "true", "RUN_CONSOLE": "true", "RUN_ERP": "true",
                "RUN_STEPS": "backup,backend,console,erp"}
        result = run_step(guard, good)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        partial = {**good, "RUN_BACKUP": "false", "RUN_BACKEND": "false", "RUN_CONSOLE": "false", "RUN_STEPS": "erp"}
        self.assertEqual(run_step(guard, partial).returncode, 0)
        for change in ({"RUN_ERP": ""}, {"RUN_CONSOLE": "yes"}, {"RUN_BACKUP": "false", "RUN_STEPS": "backend,console,erp"},
                       {"RUN_STEPS": "backup,backend,console"}, {"RUN_STEPS": "erp,console,backend,backup"},
                       {**{key: "false" for key in ("RUN_BACKUP", "RUN_BACKEND", "RUN_CONSOLE", "RUN_ERP")}, "RUN_STEPS": ""}):
            self.assertNotEqual(run_step(guard, {**good, **change}).returncode, 0, f"{change} passed the live guard")
        for key, bad in (("DRY_RUN", "true"), ("ENVIRONMENT_GATE", "unverified"), ("API_DIGEST", ""),
                         ("CURRENT_MANIFEST", ""), ("STATE_VERSION", ""), ("STATE_VERSION", "0"), ("STATE_SHA256", "abc"),
                         ("MANIFEST_SOURCE", "input"),
                         ("CONSOLE_CONTRACT_PIN", "35114fd49d7765dccf4e4c9f3b5c3a6e2d6dd828"), ("ROLLBACK_ALLOWED", ""),
                         ("ERP_ROLLBACK_CLASS", "maybe"), ("GATE_RESULTS", "G1=pass G2=pass G3=pass G4=FAIL G5=pass G6=pass G7=pass G8=pass G9=pass"),
                         ("GATE_RESULTS", "G1=pass G2=pass G3=pass G4=pass G5=pass G6=pass G7=unverified G8=pass G9=pass"),
                         ("GATE_RESULTS", "G1=pass G2=pass G3=pass G4=pass G5=pass G6=pass G7=pass G8=FAIL G9=pass"),
                         ("GATE_RESULTS", "G1=pass G2=pass G3=pass G4=pass G5=pass G6=pass G7=pass G8=pass"),
                         ("GATE_RESULTS", "G1=pass G2=pass G3=pass G4=pass G5=pass G6=pass G7=pass G8=pass G9=FAIL"),
                         ("GATE_RESULTS", "G1=pass G2=pass G3=pass G4=pass G5=pass G6=pass G7=pass G8=pass G9=not-run"),
                         ("GATE_RESULTS", "G1=pass G2=pass G3=pass G4=pass G5=pass G6=pass G7=pass"),
                         ("GATE_RESULTS", "G1=pass G2=pass G3=pass G4=pass G5=pass G6=pass G7=pass G8=not-run G9=pass")):
            self.assertNotEqual(run_step(guard, {**good, key: bad}).returncode, 0, f"{key}={bad} passed the live guard")


if __name__ == "__main__":
    unittest.main()
