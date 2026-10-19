"""Turn GitHub REST payloads into aggregator records (pure functions).

Check-run provenance (A.8 R2): a job record carries the attempt number from
the Actions jobs API (`filter=all`), the workflow path and event from its
workflow run (only if that run belongs to THIS repository), and the producer
App id from the joined check-run. Missing joins leave the field None, which
the aggregator rejects.

Approval (A.8 R1): an APPROVED pull request review whose body has a line
exactly `policy-change-approved: base=<40 hex> fingerprint=<64 hex>`. The head
SHA is the review's own `commit_id`. Only APPROVED counts: GitHub does not let
a PR author approve their own PR, so this also blocks self-approval. Labels are
never approvals."""

import re

ATTESTATION = re.compile(r"^policy-change-approved: base=([0-9a-f]{40}) fingerprint=([0-9a-f]{64})\s*$", re.M)
REVIEW_STATES = ("APPROVED",)


def _check_run_id(url):
    tail = (url or "").rstrip("/").rsplit("/", 1)[-1]
    return int(tail) if tail.isdigit() else None


def normalize_runs(repo_full_name, workflow_runs, jobs_by_run, check_runs):
    apps = {c.get("id"): (c.get("app") or {}).get("id") for c in check_runs}
    records = []
    for run in workflow_runs:
        own_repo = (run.get("repository") or {}).get("full_name") == repo_full_name
        for job in jobs_by_run.get(run.get("id"), []):
            records.append({
                "name": job.get("name"),
                "app_id": apps.get(_check_run_id(job.get("check_run_url"))),
                "workflow_path": run.get("path") if own_repo else None,
                "event": run.get("event"),
                "head_sha": job.get("head_sha"),
                "run_id": run.get("id"),
                "run_attempt": job.get("run_attempt"),
                "status": job.get("status"),
                "conclusion": job.get("conclusion"),
            })
    return records


def all_runs_completed(workflow_runs):
    """True only when there is at least one run and none is still active.
    Used as the `deadline_passed` signal: an absent job is then truly absent."""
    return bool(workflow_runs) and all(r.get("status") == "completed" for r in workflow_runs)


def approvals_from_reviews(reviews):
    out = []
    for review in reviews:
        if review.get("state") not in REVIEW_STATES:
            continue
        m = ATTESTATION.search(review.get("body") or "")
        if not m:
            continue
        user = review.get("user") or {}
        out.append({
            "login": user.get("login"),
            "actor_type": user.get("type"),
            "kind": "review",
            "head_sha": review.get("commit_id"),
            "base_sha": m.group(1),
            "fingerprint": m.group(2),
        })
    return out
