#!/usr/bin/env python3
"""Post the live system ledger summary as one comment on the authorizing Jira issue (RT-1086).

The last step of the live job of deploy-system-lab.yml. It writes one comment and nothing else: no
status transition, no field change (Jira status and the Closeout Gate stay the owner's, section 5A).
It runs on success, failure and cancellation. It is best effort by design: whatever goes wrong (a missing secret, an HTTP error, a timeout, an
unreadable summary) is reported as a `::warning::` and the exit code stays 0, so a Jira problem can never
change the deploy outcome.

The token is read from the environment (never from argv), masked, and never printed; neither is any
response body. The comment is an Atlassian Document Format code block, so nothing in the ledger text is
read as markup. The request goes to the fixed api.atlassian.com gateway of one validated cloud id, with
TLS verification and no redirect followed (a redirect would carry the Authorization header elsewhere).
A scoped API token (write:comment:jira) on a service account is the intended credential.

Stdlib only. Exit 0 always.
"""
import argparse
import base64
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

KEY = re.compile(r"^RT-[1-9][0-9]{0,5}\Z")
CLOUD_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
USER = re.compile(r"^[^@\s:]{1,128}@[A-Za-z0-9][A-Za-z0-9.-]{0,127}\Z")
RUN_URL = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]{1,20}\Z")
OUTCOMES = ("success", "failure", "cancelled")
COMMENT_ID = re.compile(r"^[0-9]{1,12}\Z")
API = "https://api.atlassian.com/ex/jira/{cloud}/rest/api/3/issue/{key}/comment"
MAX_SUMMARY = 20000  # Jira refuses a comment of more than 32767 characters; the margin covers escaping
FALLBACK = "(Jira refused the full ledger summary; read it in the run's ledger artifact)"
MAX_FILE = 1024 * 1024
TIMEOUT = 30
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class Skip(Exception):
    """Nothing was posted, and why (never a secret or a response body)."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def warn(text):
    print(f"::warning::Jira comment not posted: {' '.join(str(text).split())[:300]}")


def read_summary(path):
    """The ledger summary, bounded and free of control characters, or a note saying it is missing."""
    try:
        data = pathlib.Path(path).read_bytes()[:MAX_FILE]
    except OSError:
        return "(the ledger summary was not written; see the run)"
    text = CONTROL.sub("", data.decode("utf-8", errors="replace")).strip()
    if len(text) > MAX_SUMMARY:
        text = text[:MAX_SUMMARY] + "\n[truncated: the full summary is in the run's ledger artifact]"
    return text or "(the ledger summary is empty; see the run)"


def build_body(summary, outcome, run_url):
    header = (f"Automatic evidence from deploy-system-lab.yml, live job {outcome}. This is evidence only; "
              f"the owner reconciles the status. Run: {run_url}")
    return {"body": {"type": "doc", "version": 1, "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": header}]},
        {"type": "codeBlock", "content": [{"type": "text", "text": summary}]},
    ]}}


def check(env, run_url, outcome):
    """The validated settings, or Skip."""
    token, user, cloud, key = (env.get(name, "") for name in ("JIRA_COMMENT_TOKEN", "JIRA_COMMENT_USER", "JIRA_CLOUD_ID", "JIRA_KEY"))
    token, user, cloud = token.strip(), user.strip(), cloud.strip()
    if not token:
        raise Skip("JIRA_COMMENT_TOKEN is not set on the aws-lab environment")
    if not user:
        raise Skip("JIRA_COMMENT_USER is not set")
    if not cloud:
        raise Skip("JIRA_CLOUD_ID is not set")
    if not USER.match(user):
        raise Skip("JIRA_COMMENT_USER is not an email address")
    if not CLOUD_ID.match(cloud):
        raise Skip("JIRA_CLOUD_ID is not a cloud id (a UUID)")
    if not KEY.match(key):
        raise Skip("the Jira key is not RT-<number>")
    if outcome not in OUTCOMES:
        raise Skip("the job outcome is not success, failure or cancelled")
    if not RUN_URL.match(run_url):
        raise Skip("the run URL is not a GitHub Actions run URL")
    return token, user, cloud, key


def post(url, user, token, payload, opener=None):
    """(HTTP status, comment id or None). Raises on any HTTP or network error; never follows a redirect."""
    opener = opener or urllib.request.build_opener(NoRedirect)
    auth = base64.b64encode(f"{user}:{token}".encode("utf-8")).decode("ascii")
    request = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), method="POST", headers={
        "Authorization": f"Basic {auth}", "Content-Type": "application/json", "Accept": "application/json"})
    with opener.open(request, timeout=TIMEOUT) as response:
        status = response.status
        try:
            comment_id = str(json.loads(response.read(65536).decode("utf-8")).get("id"))
        except Exception:  # the comment exists already; a broken answer body must not read as "not posted"
            comment_id = None
    return status, comment_id if comment_id and COMMENT_ID.match(comment_id) else None


def run(env, summary_path, run_url, outcome, opener=None, url=None):
    try:
        token, user, cloud, key = check(env, run_url, outcome)
        print(f"::add-mask::{token}")
        summary = read_summary(summary_path)
        target = url or API.format(cloud=cloud, key=key)
        try:
            status, comment_id = post(target, user, token, build_body(summary, outcome, run_url), opener)
        except urllib.error.HTTPError as exc:
            if exc.code != 400:
                raise
            # Jira refused the body (size or content): one retry with a short one, so the evidence is not lost
            status, comment_id = post(target, user, token, build_body(FALLBACK, outcome, run_url), opener)
        if status != 201:
            raise Skip(f"Jira answered HTTP {status}")
        print(f"::notice::Jira comment {comment_id or '(id not read)'} posted to {key} (HTTP {status})")
    except Skip as exc:
        warn(exc)
    except urllib.error.HTTPError as exc:
        warn(f"Jira answered HTTP {exc.code} {exc.reason if isinstance(exc.reason, str) else ''}".strip())
    except Exception as exc:  # the deploy outcome must never depend on Jira
        warn(f"{exc.__class__.__name__} while calling Jira")
    return 0


def main(argv=None, env=None, opener=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--summary", required=True)
    parser.add_argument("--run-url", required=True)
    parser.add_argument("--outcome", required=True)
    try:
        args = parser.parse_args(argv)
    except SystemExit:  # a malformed call is a defect to fix, but it must not turn a finished deploy red
        warn("the step was called with wrong arguments")
        return 0
    return run(env if env is not None else os.environ, args.summary, args.run_url, args.outcome, opener)


if __name__ == "__main__":
    sys.exit(main())
