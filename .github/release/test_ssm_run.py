"""RT-1031: tests of ssm-run.sh, the one document runner of deploy-system-lab.yml.

A stub `aws` on PATH stands in for the CLI, so the real script runs: the node lookup, the send, the
poll, the strict-output filter, the completion proof and the failure record. CI is Linux; locally
the tests run only when bash works.
"""
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "ssm-run.sh"
RESULT_RE = r"^RT_(GATE|FAIL|PRIOR|TARGET|SWAP|REVERT|DONE)( [A-Za-z0-9=:._/-]+)*$"
BASH = shutil.which("bash") or ""

STUB = """#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1 $2" in
  "ssm describe-instance-information") echo "${STUB_NODE-mi-0123456789abcdef0}" ;;
  "ssm send-command") echo "${STUB_CMD-11111111-2222-3333-4444-555555555555}" ;;
  "ssm get-command-invocation")
    if [[ " $* " == *" Status "* ]]; then echo "${STUB_STATUS-Success}"; else printf '%b\\n' "${STUB_OUTPUT-}"; fi ;;
esac
"""


def _bash_works():
    if not BASH:
        return False
    probe = subprocess.run([BASH, "-c", "printf ok"], capture_output=True, text=True, check=False)
    return probe.returncode == 0 and probe.stdout == "ok"


HAVE_BASH = _bash_works()
if not HAVE_BASH and os.environ.get("CI"):
    raise RuntimeError("bash is required in CI for the ssm-run.sh checks")


@unittest.skipUnless(HAVE_BASH, "bash not available")
class SsmRun(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.live = self.tmp / "live"
        stub = self.tmp / "bin"
        stub.mkdir()
        aws = stub / "aws"
        aws.write_text(STUB, encoding="utf-8", newline="\n")
        aws.chmod(aws.stat().st_mode | stat.S_IEXEC)
        self.params = self.tmp / "params.json"
        self.params.write_text("{}", encoding="utf-8")
        self.log = self.tmp / "aws.log"
        self.base = {
            "PATH": f"{stub}{os.pathsep}{os.environ.get('PATH', '')}", "STUB_LOG": str(self.log),
            "LABEL": "console", "HOST": "lab-01", "DOCUMENT": "RT-ConsoleLabDeploy", "PARAMS": str(self.params),
            "LIMIT": "5", "INTERVAL": "0", "RESULT_RE": RESULT_RE, "DONE_LINE": "RT_DONE release=admin-console/v0.1.0",
            "LIVE": str(self.live), "RUN_ID": "123", "JIRA_KEY": "RT-1031",
        }

    def run_script(self, **override):
        env = {**self.base, **override}
        env = {key: value for key, value in env.items() if value is not None}
        return subprocess.run([BASH, str(SCRIPT)], capture_output=True, text=True, check=False, env=env)

    def failure(self):
        path = self.live / "failure.txt"
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def test_a_completed_document_writes_its_lines_and_the_ok_marker(self):
        result = self.run_script(STUB_OUTPUT="RT_GATE G-Host pass\\nSECRET=hunter2\\nRT_DONE release=admin-console/v0.1.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.live / "console.ok").exists())
        self.assertEqual((self.live / "console.status").read_text(encoding="utf-8").strip(), "Success")
        kept = (self.live / "console.lines").read_text(encoding="utf-8").splitlines()
        self.assertEqual(kept, ["RT_GATE G-Host pass", "RT_DONE release=admin-console/v0.1.0"])
        self.assertNotIn("hunter2", result.stdout + result.stderr)

    def test_the_command_goes_to_the_node_found_by_tags_with_the_default_document_version(self):
        self.run_script(STUB_OUTPUT="RT_DONE release=admin-console/v0.1.0")
        log = self.log.read_text(encoding="utf-8")
        self.assertIn("Key=tag:Environment,Values=lab Key=tag:Host,Values=lab-01", log)
        self.assertIn("--instance-ids mi-0123456789abcdef0 --document-name RT-ConsoleLabDeploy --document-version $DEFAULT", log)
        self.assertNotIn("AWS-RunShellScript", log)

    def test_a_failed_document_leaves_no_ok_marker_and_records_the_reason(self):
        result = self.run_script(STUB_STATUS="Failed", STUB_OUTPUT="RT_FAIL gate=G-Host")
        self.assertEqual(result.returncode, 1)
        self.assertFalse((self.live / "console.ok").exists())
        self.assertIn("console: the document ended Failed", self.failure())
        self.assertEqual((self.live / "console.lines").read_text(encoding="utf-8").strip(), "RT_FAIL gate=G-Host")

    def test_success_without_the_completion_line_is_a_failure(self):
        result = self.run_script(STUB_OUTPUT="RT_GATE G-Host pass")
        self.assertEqual(result.returncode, 1)
        self.assertFalse((self.live / "console.ok").exists())
        self.assertIn("did not report completion", self.failure())

    def test_a_document_still_running_when_polling_ends_is_a_failure(self):
        result = self.run_script(LIMIT="0")
        self.assertEqual(result.returncode, 1)
        self.assertIn("ended Pending", self.failure())

    def test_no_single_online_node_is_a_failure_before_any_send(self):
        for node in ("", "mi-1 mi-2", "i-0123456789abcdef0"):
            result = self.run_script(STUB_NODE=node)
            self.assertEqual(result.returncode, 1, node)
            self.assertIn("no single Online SSM node", self.failure())
        self.assertNotIn("send-command", self.log.read_text(encoding="utf-8"))

    def test_a_refused_command_id_is_a_failure(self):
        result = self.run_script(STUB_CMD="not-a-command-id")
        self.assertEqual(result.returncode, 1)
        self.assertIn("no command ID", self.failure())

    def test_the_pattern_form_of_the_completion_proof(self):
        done = {"DONE_LINE": None, "DONE_RE": r"^RT_BACKUP name=[a-z0-9.-]+ sha256=[0-9a-f]{64}$",
                "RESULT_RE": r"^RT_(GATE|FAIL|PRIOR|TARGET|BACKUP|REVERT|DONE)( [A-Za-z0-9=:._/-]+)*$"}
        good = self.run_script(**done, STUB_OUTPUT="RT_BACKUP name=rtlab-x.dump sha256=" + "f" * 64)
        self.assertEqual(good.returncode, 0, good.stderr)
        bad = self.run_script(**done, STUB_OUTPUT="RT_BACKUP name=rtlab-x.dump sha256=short")
        self.assertEqual(bad.returncode, 1)

    def test_exactly_one_completion_proof_is_required(self):
        self.assertEqual(self.run_script(DONE_LINE=None).returncode, 1)
        self.assertEqual(self.run_script(DONE_RE="^RT_DONE").returncode, 1)

    def test_unknown_labels_hosts_documents_and_limits_are_refused(self):
        for key, bad in (("LABEL", "../x"), ("HOST", "lab-09"), ("DOCUMENT", "AWS-RunShellScript"), ("LIMIT", "1;id"), ("INTERVAL", "-1")):
            result = self.run_script(**{key: bad})
            self.assertEqual(result.returncode, 1, f"{key}={bad}")
            self.assertNotIn("send-command", self.log.read_text(encoding="utf-8") if self.log.exists() else "")


if __name__ == "__main__":
    unittest.main()
