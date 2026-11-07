"""RT-1241: tests of sentry-release.sh and of how the three lab deploy workflows call it.

A stub `sentry-cli` (SENTRY_CLI_BIN) stands in for the pinned binary, so the real script runs: the
ledger gate, the token skip, the command sequence, the commits fallback and the never-fail rule. CI is
Linux; locally the script tests run only when bash works.
"""
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "sentry-release.sh"
WORKFLOWS = HERE.parent / "workflows"
BASH = shutil.which("bash") or ""
SHA = "a" * 40

STUB = """#!/usr/bin/env bash
echo "$* | org=$SENTRY_ORG url=$SENTRY_URL project=$SENTRY_PROJECT" >> "$STUB_LOG"
for fail in ${STUB_FAIL:-}; do
  case " $* " in *" $fail "*) echo "stub failure: $fail"; exit 1 ;; esac
done
echo "ok"
"""


def _bash_works():
    if not BASH:
        return False
    probe = subprocess.run([BASH, "-c", "printf ok"], capture_output=True, text=True, check=False)
    return probe.returncode == 0 and probe.stdout == "ok"


HAVE_BASH = _bash_works()
if not HAVE_BASH and os.environ.get("CI"):
    raise RuntimeError("bash is required in CI for the sentry-release.sh checks")


@unittest.skipUnless(HAVE_BASH, "bash not available")
class SentryRelease(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.cli = self.tmp / "sentry-cli"
        self.cli.write_text(STUB, encoding="utf-8", newline="\n")
        self.cli.chmod(self.cli.stat().st_mode | stat.S_IEXEC)
        self.log = self.tmp / "cli.log"
        self.ledger = self.tmp / "ledger.json"
        self.ledger.write_text(json.dumps({"outcome": "deployed"}), encoding="utf-8")

    def run_script(self, args=None, token="secret-token-value", **extra):
        env = {k: v for k, v in os.environ.items() if k != "SENTRY_AUTH_TOKEN"}
        env.update({"SENTRY_CLI_BIN": str(self.cli), "STUB_LOG": str(self.log), "GITHUB_REPOSITORY": "Kemetra-Labs/Retail-Tower-Erp"})
        if token:
            env["SENTRY_AUTH_TOKEN"] = token
        env.update(extra)
        args = args or ["backend-core", "v1.2.3", SHA, str(self.ledger)]
        # cwd is a fresh non-git dir, so HEAD never equals the release commit.
        out = subprocess.run([BASH, str(SCRIPT), *args], capture_output=True, text=True, cwd=self.tmp, env=env, check=False)
        return out, (self.log.read_text(encoding="utf-8").splitlines() if self.log.exists() else [])

    def test_runs_the_sequence_with_the_runtime_release_name(self):
        out, calls = self.run_script()
        self.assertEqual(out.returncode, 0)
        base = "org=kemetra url=https://de.sentry.io project=backend-core"
        self.assertEqual(calls, [
            f"releases new v1.2.3 | {base}",
            f"releases set-commits v1.2.3 --commit Kemetra-Labs/Retail-Tower-Erp@{SHA} | {base}",
            f"releases finalize v1.2.3 | {base}",
            f"deploys new --release v1.2.3 -e staging | {base}",
        ])
        self.assertNotIn("secret-token-value", out.stdout + out.stderr)

    def test_sha12_release_for_console_and_connector(self):
        for product in ("admin-console", "erpnext-connector"):
            out, calls = self.run_script([product, "0123456789ab", SHA, str(self.ledger)])
            self.assertEqual(out.returncode, 0)
            self.assertIn(f"project={product}", calls[0])
            self.assertTrue(calls[0].startswith("releases new 0123456789ab"))
            self.log.unlink()

    def test_missing_token_warns_once_and_succeeds(self):
        out, calls = self.run_script(token="")
        self.assertEqual(out.returncode, 0)
        self.assertEqual(calls, [])
        self.assertEqual(out.stdout.count("::warning::"), 1)
        self.assertIn("SENTRY_AUTH_TOKEN is not set", out.stdout)

    def test_only_a_deployed_ledger_is_recorded(self):
        for outcome in ("failed", "held", "unknown"):
            self.ledger.write_text(json.dumps({"outcome": outcome}), encoding="utf-8")
            out, calls = self.run_script()
            self.assertEqual((out.returncode, calls), (0, []), outcome)
        out, calls = self.run_script(["backend-core", "v1.2.3", SHA, str(self.tmp / "missing.json")])
        self.assertEqual((out.returncode, calls), (0, []))

    def test_bad_inputs_are_skipped_with_a_warning(self):
        for args in (["pos", "v1.2.3", SHA, str(self.ledger)],
                     ["backend-core", "backend-core/v1.2.3", SHA, str(self.ledger)],
                     ["admin-console", "0123456789a", SHA, str(self.ledger)],
                     ["backend-core", "v1.2.3", "abc", str(self.ledger)]):
            out, calls = self.run_script(args)
            self.assertEqual((out.returncode, calls), (0, []), args)
            self.assertIn("::warning::", out.stdout)

    def test_every_cli_failure_is_a_warning_never_a_failed_step(self):
        for fail in ("new", "set-commits", "finalize", "deploys"):
            self.log.unlink(missing_ok=True)
            out, _ = self.run_script(STUB_FAIL=fail)
            self.assertEqual(out.returncode, 0, fail)
            self.assertIn("::warning::", out.stdout, fail)

    def test_set_commits_failure_says_the_release_has_no_commits_and_still_deploys(self):
        out, calls = self.run_script(STUB_FAIL="set-commits")
        self.assertIn("NO commits", out.stdout)
        self.assertTrue(calls[-1].startswith("deploys new --release v1.2.3 -e staging"))

    def test_auto_is_used_when_head_is_the_release_commit(self):
        repo = self.tmp / "repo"
        repo.mkdir()
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid"]
        subprocess.run([*git, "init", "-q"], cwd=repo, check=True)
        subprocess.run([*git, "commit", "-q", "--allow-empty", "-m", "x"], cwd=repo, check=True)
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
        env = {**os.environ, "SENTRY_CLI_BIN": str(self.cli), "STUB_LOG": str(self.log), "SENTRY_AUTH_TOKEN": "t"}
        subprocess.run([BASH, str(SCRIPT), "backend-core", "v1.2.3", head, str(self.ledger)], cwd=repo, env=env, check=True, capture_output=True)
        self.assertIn("releases set-commits v1.2.3 --auto", self.log.read_text(encoding="utf-8"))


class WorkflowWiring(unittest.TestCase):
    CASES = {
        "deploy-lab.yml": "backend-core",
        "deploy-console-lab.yml": "admin-console",
        "deploy-erp-lab.yml": "erpnext-connector",
    }

    def test_each_live_deploy_calls_the_script_once_after_the_ledger(self):
        for name, product in self.CASES.items():
            text = (WORKFLOWS / name).read_text(encoding="utf-8")
            self.assertEqual(text.count("sentry-release.sh"), 1, name)
            self.assertIn(f"sentry-release.sh {product} ", text, name)
            live = text[text.index("\n  live:"):]
            step = "- name: Record the Sentry release and deploy (evidence only)"
            self.assertIn(step, live, name)
            self.assertLess(live.index("- name: Write the live ledger"), live.index(step), name)
            self.assertLess(live.index(step), live.index("- name: Record the live state"), name)
            block = live[live.index(step):live.index("- name: Assume the deploy role to record the outcome")]
            self.assertIn("if: always()", block, name)
            self.assertIn("SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}", block, name)
            self.assertEqual(len(re.findall(r"secrets\.SENTRY_AUTH_TOKEN", text)), 1, name)

    def test_the_token_is_only_read_in_the_aws_lab_live_job(self):
        for name in self.CASES:
            text = (WORKFLOWS / name).read_text(encoding="utf-8")
            live_at = text.index("\n  live:")
            self.assertNotIn("SENTRY_AUTH_TOKEN", text[:live_at], name)
            self.assertIn("environment: aws-lab", text[live_at:live_at + 600], name)

    def test_the_script_pins_the_cli_and_the_eu_region(self):
        text = SCRIPT.read_text(encoding="utf-8")
        self.assertRegex(text, r'SENTRY_CLI_VERSION="\d+\.\d+\.\d+"')
        self.assertRegex(text, r'SENTRY_CLI_SHA256="[0-9a-f]{64}"')
        self.assertIn('SENTRY_URL="https://de.sentry.io"', text)
        self.assertIn('SENTRY_ORG="kemetra"', text)
        self.assertNotIn("npm", text)


if __name__ == "__main__":
    unittest.main()
