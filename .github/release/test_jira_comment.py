"""RT-1086: tests of jira_comment.py (the Jira comment step of the live job) and of its wiring.

No test reaches Atlassian: the HTTP layer is a fake opener, or a throw-away server on 127.0.0.1. The
step must never change a deploy outcome, so every failure is a warning and the exit code is always 0.
"""
import base64
import contextlib
import http.client
import io
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import jira_comment
from test_system_deploy_workflow import WORKFLOWS, job, read, step, step_script

ROOT = pathlib.Path(__file__).resolve().parents[2]
BASH = shutil.which("bash")
TOKEN = "ATATT3xFfGF0-the-secret-token-value"
CLOUD = "78e4deee-429c-4a88-9c95-38ffe1708bf9"
RUN = "https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/41827372071"
SUMMARY = "## System lab deploy live: DEPLOYED\n\nlab-2026.11.3 over lab-2026.11.3, RT-1084.\n\n### backup (RT-BackendLabBackup on lab-02): ok\n```\nRT_BACKUP name=x sha256=y\n```\n"
ENV = {"JIRA_COMMENT_TOKEN": TOKEN, "JIRA_COMMENT_USER": "lab-bot@example.com", "JIRA_CLOUD_ID": CLOUD, "JIRA_KEY": "RT-1084"}


class FakeResponse:
    def __init__(self, status=201, body=b'{"id": "10500", "self": "https://x"}'):
        self.status, self.body = status, body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, limit=-1):
        return self.body


class FakeOpener:
    def __init__(self, response=None, error=None):
        self.response, self.error, self.requests = response or FakeResponse(), error, []

    def open(self, request, timeout=None):
        self.requests.append((request, timeout))
        if self.error:
            raise self.error
        return self.response


def http_error(code, reason="Nope", body=b"the response body names " + TOKEN.encode()):
    return urllib.error.HTTPError("https://api.atlassian.com/x", code, reason, {}, io.BytesIO(body))


def run(env=None, opener=None, summary=SUMMARY, outcome="success", run_url=RUN, url=None):
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "summary.md"
        if summary is not None:
            path.write_bytes(summary if isinstance(summary, bytes) else summary.encode("utf-8"))
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = jira_comment.run({**ENV, **(env or {})}, str(path), run_url, outcome, opener, url)
        return code, out.getvalue()


class Posting(unittest.TestCase):
    def test_a_summary_is_posted_as_one_code_block_comment(self):
        opener = FakeOpener()
        code, out = run(opener=opener)
        self.assertEqual(code, 0)
        self.assertEqual(len(opener.requests), 1)
        request, timeout = opener.requests[0]
        self.assertEqual(request.full_url, f"https://api.atlassian.com/ex/jira/{CLOUD}/rest/api/3/issue/RT-1084/comment")
        self.assertEqual((request.get_method(), timeout), ("POST", 30))
        self.assertEqual(request.get_header("Authorization"), "Basic " + base64.b64encode(f"lab-bot@example.com:{TOKEN}".encode()).decode())
        self.assertEqual(request.get_header("Content-type"), "application/json")
        doc = json.loads(request.data)["body"]
        self.assertEqual((doc["type"], doc["version"]), ("doc", 1))
        paragraph, block = doc["content"]
        self.assertIn("deploy-system-lab.yml, live job success", paragraph["content"][0]["text"])
        self.assertIn("evidence only", paragraph["content"][0]["text"])
        self.assertIn(RUN, paragraph["content"][0]["text"])
        self.assertEqual((block["type"], block["content"][0]["text"]), ("codeBlock", SUMMARY.strip()))
        self.assertEqual(set(json.loads(request.data)), {"body"})  # a comment only: no transition, no field
        self.assertIn("::notice::Jira comment 10500 posted to RT-1084 (HTTP 201)", out)

    def test_the_token_and_the_responses_are_never_printed(self):
        for error in (http_error(401), http_error(500), None):
            _, out = run(opener=FakeOpener(error=error, response=FakeResponse(body=b'{"id":"1","note":"' + TOKEN.encode() + b'"}')))
            self.assertNotIn(TOKEN, out.replace(f"::add-mask::{TOKEN}", ""))
            self.assertNotIn(base64.b64encode(f"lab-bot@example.com:{TOKEN}".encode()).decode(), out)
        self.assertIn(f"::add-mask::{TOKEN}", run(opener=FakeOpener())[1])

    def test_every_outcome_the_job_can_have_is_posted(self):
        for outcome in ("success", "failure", "cancelled"):
            opener = FakeOpener()
            code, _ = run(opener=opener, outcome=outcome)
            self.assertEqual((code, len(opener.requests)), (0, 1), outcome)
            self.assertIn(f"live job {outcome}", json.loads(opener.requests[0][0].data)["body"]["content"][0]["content"][0]["text"])

    def test_non_ascii_text_is_sent_as_utf8_not_as_escapes(self):
        opener = FakeOpener()
        run(opener=opener, summary="تم النشر ✓ \"quoted\"\n")
        raw = opener.requests[0][0].data
        self.assertNotIn(b"\\u", raw)
        self.assertEqual(json.loads(raw)["body"]["content"][1]["content"][0]["text"], 'تم النشر ✓ "quoted"')


class Failures(unittest.TestCase):
    """Whatever goes wrong is a warning and exit 0: Jira can never change the deploy outcome."""

    def assert_skipped(self, opener, out, text):
        self.assertEqual(opener.requests, [])
        self.assertIn("::warning::Jira comment not posted: ", out)
        self.assertIn(text, out)

    def test_missing_settings_skip_without_a_request(self):
        for name, text in (("JIRA_COMMENT_TOKEN", "JIRA_COMMENT_TOKEN is not set"), ("JIRA_COMMENT_USER", "JIRA_COMMENT_USER is not set"),
                           ("JIRA_CLOUD_ID", "JIRA_CLOUD_ID is not set")):
            opener = FakeOpener()
            code, out = run({name: ""}, opener)
            self.assertEqual(code, 0, name)
            self.assert_skipped(opener, out, text)

    def test_malformed_settings_skip_without_a_request(self):
        cases = (({"JIRA_KEY": "RT-0"}, "not RT-<number>"), ({"JIRA_KEY": "RT-1; id"}, "not RT-<number>"), ({"JIRA_KEY": ""}, "not RT-<number>"),
                 ({"JIRA_CLOUD_ID": "../evil"}, "not a cloud id"), ({"JIRA_COMMENT_USER": "not-an-email"}, "not an email"),
                 ({"JIRA_COMMENT_USER": "a:b@example.com"}, "not an email"))
        for env, text in cases:
            opener = FakeOpener()
            code, out = run(env, opener)
            self.assertEqual(code, 0, env)
            self.assert_skipped(opener, out, text)
        for kwargs, text in (({"outcome": "weird"}, "job outcome"), ({"run_url": "https://evil.example/actions/runs/1"}, "run URL")):
            opener = FakeOpener()
            code, out = run(opener=opener, **kwargs)
            self.assertEqual(code, 0)
            self.assert_skipped(opener, out, text)

    def test_every_http_error_is_a_warning_with_the_status_only(self):
        for status, reason in ((400, "Bad Request"), (401, "Unauthorized"), (403, "Forbidden"), (404, "Not Found"), (429, "Too Many Requests"), (500, "Server Error")):
            code, out = run(opener=FakeOpener(error=http_error(status, reason)))
            self.assertEqual(code, 0, status)
            self.assertIn(f"::warning::Jira comment not posted: Jira answered HTTP {status} {reason}", out)
            self.assertNotIn(TOKEN, out.replace(f"::add-mask::{TOKEN}", ""))

    def test_network_errors_and_a_wrong_success_status_are_warnings(self):
        for error in (TimeoutError("slow"), urllib.error.URLError("no route"), OSError("reset"), ValueError("odd")):
            code, out = run(opener=FakeOpener(error=error))
            self.assertEqual(code, 0, error)
            self.assertIn(f"{error.__class__.__name__} while calling Jira", out)
            self.assertNotIn("slow", out)
        code, out = run(opener=FakeOpener(response=FakeResponse(status=200)))
        self.assertEqual(code, 0)
        self.assertIn("Jira answered HTTP 200", out)
        self.assertNotIn("::notice::", out)

    def test_a_trailing_newline_never_passes_validation(self):
        # the key and the run URL come from the workflow, not from a pasted secret: a trailing newline is invalid there
        for env in ({"JIRA_KEY": "RT-1084\n"},):
            opener = FakeOpener()
            code, out = run(env, opener)
            self.assertEqual((code, opener.requests), (0, []), env)
            self.assertIn("::warning::", out)
        opener = FakeOpener()
        run(opener=opener, run_url=RUN + "\n")
        self.assertEqual(opener.requests, [])

    def test_a_secret_pasted_with_a_trailing_newline_or_space_still_works(self):
        opener = FakeOpener()
        run({"JIRA_COMMENT_TOKEN": TOKEN + "\n", "JIRA_COMMENT_USER": " lab-bot@example.com\n", "JIRA_CLOUD_ID": CLOUD + " "}, opener)
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(opener.requests[0][0].get_header("Authorization"),
                         "Basic " + base64.b64encode(f"lab-bot@example.com:{TOKEN}".encode()).decode())

    def test_a_broken_answer_after_a_201_is_not_reported_as_not_posted(self):
        class Broken(FakeResponse):
            def read(self, limit=-1):
                raise http.client.IncompleteRead(b"par")

        code, out = run(opener=FakeOpener(response=Broken()))
        self.assertEqual(code, 0)
        self.assertNotIn("not posted", out)
        self.assertIn("::notice::Jira comment (id not read) posted to RT-1084 (HTTP 201)", out)

    def test_when_jira_refuses_the_body_one_short_note_is_posted_instead(self):
        calls = []

        class Opener(FakeOpener):
            def open(self, request, timeout=None):
                calls.append(json.loads(request.data)["body"]["content"][1]["content"][0]["text"])
                if len(calls) == 1:
                    raise http_error(400, "Bad Request")
                return FakeResponse()

        code, out = run(opener=Opener())
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 2)
        self.assertIn("read it in the run's ledger artifact", calls[1])
        self.assertIn("::notice::Jira comment 10500 posted", out)
        # a second refusal, or any other status, is not retried
        calls.clear()
        code, out = run(opener=FakeOpener(error=http_error(400, "Bad Request")))
        self.assertIn("Jira answered HTTP 400", out)
        for status in (401, 500):
            seen = FakeOpener(error=http_error(status))
            run(opener=seen)
            self.assertEqual(len(seen.requests), 1, status)

    def test_a_response_without_an_id_still_counts_as_posted(self):
        for body in (b"not json", b"{}", b'{"id": "not-a-number"}'):
            code, out = run(opener=FakeOpener(response=FakeResponse(body=body)))
            self.assertEqual(code, 0)
            self.assertIn("::notice::Jira comment (id not read) posted to RT-1084", out)

    def test_wrong_arguments_are_a_warning_not_an_exit_code(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = jira_comment.main(["--token", TOKEN], env=ENV, opener=FakeOpener())
        self.assertEqual(code, 0)
        self.assertIn("wrong arguments", out.getvalue())
        self.assertNotIn(TOKEN, out.getvalue())

    def test_the_token_has_no_command_line_option(self):
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(jira_comment.main(["--summary", "x", "--run-url", RUN, "--outcome", "success", "--token", "t"], env=ENV, opener=FakeOpener()), 0)


class Summary(unittest.TestCase):
    def test_a_missing_summary_still_posts_a_note(self):
        opener = FakeOpener()
        run(opener=opener, summary=None)
        text = json.loads(opener.requests[0][0].data)["body"]["content"][1]["content"][0]["text"]
        self.assertIn("the ledger summary was not written", text)

    def test_a_long_summary_is_truncated_below_the_jira_limit(self):
        opener = FakeOpener()
        run(opener=opener, summary="x" * 100000)
        text = json.loads(opener.requests[0][0].data)["body"]["content"][1]["content"][0]["text"]
        self.assertLess(len(text), 29000)
        self.assertIn("[truncated", text)

    def test_control_characters_are_removed_and_binary_is_tolerated(self):
        opener = FakeOpener()
        run(opener=opener, summary=b"ok\x00\x07line\x1b[31m\nnext\xff\xfe")
        text = json.loads(opener.requests[0][0].data)["body"]["content"][1]["content"][0]["text"]
        self.assertTrue(text.startswith("okline"))
        self.assertNotRegex(text, r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

    def test_an_empty_summary_posts_a_note(self):
        opener = FakeOpener()
        run(opener=opener, summary="   \n")
        self.assertIn("is empty", json.loads(opener.requests[0][0].data)["body"]["content"][1]["content"][0]["text"])


class Handler(BaseHTTPRequestHandler):
    mode = "created"
    seen = []

    def do_POST(self):
        Handler.seen.append((self.path, self.headers.get("Authorization"), self.rfile.read(int(self.headers.get("Content-Length", 0)))))
        if Handler.mode == "redirect":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/elsewhere")
            self.end_headers()
            return
        self.send_response(201 if Handler.mode == "created" else 500)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"id":"77"}')

    def log_message(self, *args):
        pass


class RealHttp(unittest.TestCase):
    """The real urllib path against a local server: status handling and no redirect."""

    def setUp(self):
        Handler.seen = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/ex/jira/c/rest/api/3/issue/RT-1084/comment"

    def test_a_201_posts_and_reads_the_comment_id(self):
        Handler.mode = "created"
        code, out = run(url=self.url)
        self.assertEqual(code, 0)
        self.assertIn("::notice::Jira comment 77 posted to RT-1084 (HTTP 201)", out)
        self.assertEqual(len(Handler.seen), 1)
        self.assertTrue(Handler.seen[0][1].startswith("Basic "))

    def test_a_500_is_a_warning(self):
        Handler.mode = "error"
        code, out = run(url=self.url)
        self.assertEqual(code, 0)
        self.assertIn("Jira answered HTTP 500", out)

    def test_a_redirect_is_not_followed_so_the_credentials_go_nowhere_else(self):
        Handler.mode = "redirect"
        code, out = run(url=self.url)
        self.assertEqual(code, 0)
        self.assertIn("Jira answered HTTP 302", out)
        self.assertEqual(len(Handler.seen), 1)  # the Location was never requested


class Wiring(unittest.TestCase):
    NAME = "Post the ledger summary to the Jira issue"

    @classmethod
    def setUpClass(cls):
        cls.text = read(WORKFLOWS / "deploy-system-lab.yml")
        cls.live = job(cls.text, "live")

    def test_it_is_the_last_step_of_the_live_job_and_runs_on_success_and_failure(self):
        steps = re.findall(r"^      - (?:name|uses): (.+)$", self.live, re.M)
        self.assertEqual(steps[-1], self.NAME)
        self.assertLess(self.live.index("- name: Upload the system ledger"), self.live.index(f"- name: {self.NAME}"))
        self.assertRegex(step(self.live, self.NAME), r"(?m)^        if: always\(\)$")
        self.assertNotIn("continue-on-error", self.text)

    def test_the_secret_only_reaches_the_live_job_and_only_this_step(self):
        self.assertEqual(self.text.count("secrets.JIRA_COMMENT_TOKEN"), 1)
        self.assertEqual(step(self.live, self.NAME).count("secrets.JIRA_COMMENT_TOKEN"), 1)
        self.assertNotIn("secrets.", job(self.text, "preflight"))
        for name in ("deploy-lab", "deploy-console-lab", "deploy-erp-lab", "deploy-pos-lab"):
            self.assertNotIn("JIRA_COMMENT", read(WORKFLOWS / f"{name}.yml"), name)  # the per-product workflows are out of scope

    def test_no_new_permission_and_no_deployment_of_its_own(self):
        self.assertIn("permissions: {}", self.text)
        self.assertEqual(re.findall(r"^      ([a-z-]+): write", self.live, re.M), ["id-token"])
        self.assertNotIn("deployments:", self.text)
        self.assertNotIn("/deployments", self.text)

    def test_the_step_passes_the_settings_by_environment_and_never_inline(self):
        block = step(self.live, self.NAME)
        for env in ("JIRA_KEY: ${{ inputs.jira_key }}", "JIRA_COMMENT_USER: ${{ vars.JIRA_COMMENT_USER }}", "JIRA_CLOUD_ID: ${{ vars.JIRA_CLOUD_ID }}",
                    "JOB_STATUS: ${{ job.status }}"):
            self.assertIn(env, block)
        script = step_script(self.live, self.NAME)
        self.assertNotIn("${{", script)
        self.assertIn("jira_comment.py", script)
        self.assertIn('--summary "$RUNNER_TEMP/live-ledger/summary.md"', script)
        self.assertNotIn("TOKEN", script)  # the token is read from the environment by the helper, never an argument
        self.assertIn("timeout 120 python3 .github/release/jira_comment.py", script)
        self.assertIn('|| echo "::warning::Jira comment not posted', script)  # a timeout or crash is a warning, never a failed step

    def test_the_summary_it_posts_is_the_one_the_ledger_step_writes(self):
        self.assertIn("summary.md", step_script(self.live, "Write the system ledger"))
        self.assertIn('--out "$RUNNER_TEMP/live-ledger"', step_script(self.live, "Write the system ledger"))

    @unittest.skipUnless(BASH, "bash is needed to run the workflow step")
    def test_the_real_step_without_its_secret_warns_and_exits_zero(self):
        script = step_script(self.live, self.NAME)
        with tempfile.TemporaryDirectory() as tmp:
            runner = pathlib.Path(tmp)
            (runner / "live-ledger").mkdir()
            (runner / "live-ledger" / "summary.md").write_text(SUMMARY, encoding="utf-8")
            env = {**os.environ, "RUNNER_TEMP": str(runner), "JIRA_KEY": "RT-1084", "JIRA_COMMENT_TOKEN": "", "JIRA_COMMENT_USER": "",
                   "JIRA_CLOUD_ID": "", "JOB_STATUS": "failure", "RUN_URL": RUN}
            proc = subprocess.run([BASH, "-c", script], cwd=ROOT, env=env, capture_output=True, text=True, check=False, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("::warning::Jira comment not posted: JIRA_COMMENT_TOKEN is not set on the aws-lab environment", proc.stdout)


if __name__ == "__main__":
    unittest.main()
