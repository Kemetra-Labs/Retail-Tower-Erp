"""RT-1084: the live-state record in the four lab deploy workflows.

AC5 evidence is SIMULATED, not a real AWS dry run: the real `Read the live-state record` step of
deploy-system-lab.yml is extracted from the YAML and run under bash, against a fake `aws` executable that
answers `ssm get-parameter` for the one fixed parameter (ParameterNotFound, access denied, throttling, a
malformed, dirty or inflight record, a valid one). The production parameter is never read or changed.
The other tests check the wiring of the begin/finish steps in the four workflows and that the shared
deploy-aws-lab concurrency lock is intact.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_live_state import SEED, dump
from test_system_deploy_workflow import WORKFLOWS, job, read, step, step_script

ROOT = Path(__file__).resolve().parents[2]
RELEASE_DIR = ROOT / ".github" / "release"
STATE_STEP = "Read the live-state record (G9, resolves current_manifest)"
BASH = shutil.which("bash")

SHIM = r'''import json, os, sys
expected = ["ssm", "get-parameter", "--name", "/rt/lab/live-state", "--region", "us-east-1", "--output", "json"]
if sys.argv[1:] != expected:
    sys.stderr.write("fake aws: unexpected arguments " + " ".join(sys.argv[1:]) + "\n")
    sys.exit(3)
mode = os.environ["FAKE_AWS_MODE"]
if mode == "not-found":
    sys.stderr.write("An error occurred (ParameterNotFound) when calling the GetParameter operation: \n")
    sys.exit(254)
if mode == "denied":
    sys.stderr.write("An error occurred (AccessDeniedException) when calling the GetParameter operation: not authorized\n")
    sys.exit(254)
if mode == "throttle":
    sys.stderr.write("An error occurred (ThrottlingException) when calling the GetParameter operation: slow down\n")
    sys.exit(255)
value = open(os.environ["FAKE_AWS_VALUE_FILE"], encoding="utf-8").read()
print(json.dumps({"Parameter": {"Name": "/rt/lab/live-state", "Type": "String", "Value": value, "Version": 4}}))
'''


def fake_aws(directory):
    (directory / "shim.py").write_text(SHIM, encoding="utf-8", newline="\n")
    python = sys.executable.replace("\\", "/")
    (directory / "aws").write_text(f'#!/bin/sh\nexec "{python}" "$(dirname "$0")/shim.py" "$@"\n', encoding="utf-8", newline="\n")
    (directory / "aws").chmod(0o755)
    (directory / "aws.cmd").write_text(f'@"{sys.executable}" "%~dp0shim.py" %*\r\n', encoding="utf-8", newline="")


@unittest.skipUnless(BASH, "bash is needed to run the workflow step")
class ExtractedStateStep(unittest.TestCase):
    """The real step script, run as the workflow runs it, with only `aws` replaced."""

    @classmethod
    def setUpClass(cls):
        cls.script = step_script(job(read(WORKFLOWS / "deploy-system-lab.yml"), "preflight"), STATE_STEP)

    def run_step(self, mode, record=None, given=""):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            bin_dir, runner = tmp / "bin", tmp / "runner"
            bin_dir.mkdir()
            runner.mkdir()
            fake_aws(bin_dir)
            value = tmp / "value.json"
            value.write_text(record if record is not None else dump(SEED), encoding="utf-8", newline="\n")
            output = tmp / "github_output"
            output.write_text("", encoding="utf-8")
            env = {**os.environ, "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"], "FAKE_AWS_MODE": mode,
                   "FAKE_AWS_VALUE_FILE": str(value), "GITHUB_OUTPUT": str(output), "RUNNER_TEMP": str(runner),
                   "GITHUB_WORKSPACE": str(ROOT), "CURRENT_MANIFEST": given}
            proc = subprocess.run([BASH, "-c", self.script], cwd=ROOT, env=env, capture_output=True, text=True, check=False, timeout=60)
            gates = runner / "plan" / "gates.txt"
            return (proc, output.read_text(encoding="utf-8"), gates.read_text(encoding="utf-8") if gates.is_file() else "",
                    (runner / "state" / "record.json").is_file())

    def refused(self, mode, text, record=None, given=""):
        proc, outputs, gates, wrote_record = self.run_step(mode, record, given)
        self.assertNotEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(outputs, "", "a refused step must leave no outputs for later steps to trust")
        self.assertEqual(len([line for line in gates.splitlines() if line.startswith("G9")]), 1)
        self.assertRegex(gates, r"^G9 FAIL: record: ")
        self.assertIn(text, gates)
        self.assertFalse(wrote_record)

    def test_AC5_a_missing_record_is_refused_in_the_preflight_step(self):
        """SIMULATED evidence (mocked aws, ParameterNotFound), not a real AWS dry run."""
        self.refused("not-found", "does not exist (ParameterNotFound)")

    def test_a_valid_record_resolves_the_current_manifest_and_writes_the_outputs(self):
        proc, outputs, gates, wrote_record = self.run_step("ok")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        lines = dict(line.split("=", 1) for line in outputs.splitlines())
        self.assertEqual(lines["manifest"], "system/releases/lab-2026.11.3.json")
        self.assertEqual((lines["state_version"], lines["manifest_source"]), ("4", "record"))
        self.assertRegex(lines["state_sha256"], r"^[0-9a-f]{64}$")
        self.assertRegex(gates, r"^G9 pass: record: /rt/lab/live-state version 4")
        self.assertTrue(wrote_record)

    def test_a_given_current_manifest_must_be_the_one_the_record_names(self):
        proc, outputs, _, _ = self.run_step("ok", given="system/releases/lab-2026.11.3.json")
        self.assertEqual((proc.returncode, "manifest_source=given" in outputs), (0, True))
        self.refused("ok", "does not name the recorded versions", given="system/releases/lab-2026.11.2.json")

    def test_access_denied_is_refused(self):
        self.refused("denied", "was denied")

    def test_an_invalid_record_is_refused(self):
        self.refused("ok", "not JSON", record="{ not json")
        self.refused("ok", "schema", record=dump({**SEED, "schema": "retail-tower/lab-live-state@2"}))
        self.refused("ok", "is not a positive integer", record=dump({**SEED, "writer": {**SEED["writer"], "runId": 0}}))

    def test_a_dirty_product_is_refused(self):
        record = json.loads(dump(SEED))
        record["products"]["backend"].update(state="dirty", reason="run 5 may have changed lab-01")
        self.refused("ok", "backend is dirty: run 5 may have changed lab-01", record=dump(record))

    def test_an_inflight_run_is_refused(self):
        record = json.loads(dump(SEED))
        record["inflight"] = {"workflow": "deploy-system-lab.yml", "runId": 41800000001, "startedAt": "2026-11-04T09:00:00Z", "products": ["backend", "console"]}
        self.refused("ok", "marked backend, console inflight", record=dump(record))

    def test_a_read_that_keeps_failing_is_refused(self):
        self.refused("throttle", "failed 3 time(s)")


class Wiring(unittest.TestCase):
    PRODUCTS = {"deploy-lab": ("backend", "Run the SSM gates"), "deploy-console-lab": ("console", "Run RT-ConsoleLabDeploy"),
                "deploy-erp-lab": ("erp", "Run RT-ErpLabDeploy")}

    def test_every_lab_deploy_workflow_keeps_the_one_shared_lock(self):
        for name in ("deploy-system-lab", "deploy-lab", "deploy-console-lab", "deploy-erp-lab", "deploy-pos-lab"):
            self.assertRegex(read(WORKFLOWS / f"{name}.yml"), r"(?m)^concurrency:\n  group: deploy-aws-lab\n  cancel-in-progress: false$", name)

    def test_each_product_marks_the_record_before_its_document_and_records_after_its_ledger(self):
        for name, (kind, document) in self.PRODUCTS.items():
            text = read(WORKFLOWS / f"{name}.yml")
            live = job(text, "live")
            order = [live.index(f"- name: {title}") for title in (
                "Checkout main", "Assume the deploy role (GitHub OIDC", "Mark the live-state record inflight", document, "Write the live ledger",
                "Assume the deploy role to record the outcome", "Record the live state", "Upload the live ledger")]
            self.assertEqual(order, sorted(order), name)
            begin = step(live, "Mark the live-state record inflight")
            self.assertNotRegex(begin, r"(?m)^        if:", f"{name}: a failed marker must stop the run")
            script = step_script(live, "Mark the live-state record inflight")
            self.assertIn(f"live_state.py begin --kind {kind}", script, name)
            self.assertIn(f"--product {kind}", script, name)
            self.assertNotIn("--expect-version", script, name)  # a product preflight has no AWS: only the system one reads the record
            for title in ("Assume the deploy role to record the outcome", "Record the live state"):
                self.assertIn("if: ${{ always() && steps.begin.outcome == 'success' }}", step(live, title), f"{name} {title}")
            finish = step_script(live, "Record the live state")
            self.assertIn(f"live_state.py finish --kind {kind}", finish, name)
            self.assertIn("live-ledger/ledger.json", finish, name)
            self.assertIn('--begin-version "$BEGIN_VERSION"', finish, name)
            self.assertNotIn("continue-on-error", text, name)
            self.assertNotIn("live_state", job(text, "preflight"), f"{name}: the product preflight stays AWS-free")

    def test_the_deploy_role_and_the_read_role_are_different_and_only_the_read_role_is_in_a_preflight(self):
        for name in ("deploy-lab", "deploy-console-lab", "deploy-erp-lab"):
            self.assertNotIn("id-token", job(read(WORKFLOWS / f"{name}.yml"), "preflight"), name)
        system = read(WORKFLOWS / "deploy-system-lab.yml")
        self.assertNotIn("AWS_STATE_READ_ROLE_ARN", job(system, "live"))
        self.assertEqual(len(re.findall(r"vars\.AWS_STATE_READ_ROLE_ARN", system)), 1)

    def test_the_parameter_name_is_not_an_input_anywhere(self):
        for name in ("deploy-system-lab", "deploy-lab", "deploy-console-lab", "deploy-erp-lab"):
            text = read(WORKFLOWS / f"{name}.yml")
            code = " ".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))
            self.assertNotIn("/rt/lab/live-state", code, name)  # it lives in live_state.py only (comments may name it)
            self.assertNotRegex(text, r"(?m)^      (param|parameter|state_param)\w*:", name)


if __name__ == "__main__":
    unittest.main()
