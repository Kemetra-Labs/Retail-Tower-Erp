"""`required` aggregator (RT-709 A.5, hardened by A.8 R1 and R2).

A needed job counts only if its check-run came from the trusted producer App,
from the job's declared workflow, for the plan's exact head SHA and job event,
and is the single result of the latest run/attempt. Anything else (missing,
stale, duplicated, foreign, forged) can never turn `required` green.

Policy approval is valid only as a SHA-bound review by a human login listed in
the TRUSTED graph, matching the plan's head, base and policy fingerprint."""

from . import PLAN_SCHEMA

GATE_CONTEXT = "required"
PLAN_FIELDS = ("graph_validation", "needed_jobs", "head_sha", "base_sha",
               "policy_fingerprint", "approval_required", "job_event")
CONCLUSION_REASON = {
    "failure": "JOB_FAILED",
    "cancelled": "JOB_CANCELLED",
    "timed_out": "JOB_FAILED",
    "skipped": "UNEXPECTED_SKIP",
}
NON_FAILING = ("JOB_PENDING",)


def plan_ok(plan):
    return isinstance(plan, dict) and plan.get("schema") == PLAN_SCHEMA \
        and all(k in plan for k in PLAN_FIELDS)


def _provenance_problem(run, plan, producer_id, workflow):
    if run.get("app_id") != producer_id:
        return "WRONG_PRODUCER"
    if run.get("workflow_path") != workflow:
        return "WRONG_WORKFLOW"
    if run.get("head_sha") != plan["head_sha"]:
        return "FOREIGN_SHA"
    if run.get("event") != plan["job_event"]:
        return "WRONG_EVENT"
    return None


def _judge_job(job, runs, plan, graph, deadline_passed, rejected):
    producer = graph["trusted_check_producer"]["app_id"]
    workflow = graph["jobs"].get(job)
    if workflow is None:
        return "UNKNOWN_JOB"        # never green a job the trusted graph cannot place
    valid = []
    for run in runs:
        problem = _provenance_problem(run, plan, producer, workflow)
        if problem:
            rejected.append({"name": job, "run_id": run.get("run_id"), "problem": problem})
        else:
            valid.append(run)
    if not valid:
        return "ABSENT_JOB" if deadline_passed else "JOB_PENDING"
    run_id = max(r["run_id"] for r in valid)
    attempt = max(r["run_attempt"] for r in valid if r["run_id"] == run_id)
    latest = [r for r in valid if r["run_id"] == run_id and r["run_attempt"] == attempt]
    if len(latest) > 1:
        return "DUPLICATE_CHECK"
    run = latest[0]
    if run.get("status") != "completed":
        return "JOB_INCOMPLETE" if deadline_passed else "JOB_PENDING"
    if run.get("conclusion") == "success":
        return None
    return CONCLUSION_REASON.get(run.get("conclusion"), "JOB_NOT_SUCCESS")


def check_approval(plan, approvals, approvers):
    """Return (valid, problems). Problems are collected across all records."""
    if not approvers:
        return False, ["APPROVER_UNRESOLVED"]
    if not approvals:
        return False, ["NO_APPROVAL"]
    problems = []
    for a in approvals:
        issues = []
        if a.get("kind") != "review":
            issues.append("LABEL_NOT_SHA_BOUND")
        if a.get("login") not in approvers:
            issues.append("NOT_APPROVER")
        if a.get("actor_type") != "User":
            issues.append("NOT_HUMAN")
        if a.get("head_sha") != plan["head_sha"]:
            issues.append("STALE_HEAD")
        if a.get("base_sha") != plan["base_sha"]:
            issues.append("STALE_BASE")
        if a.get("fingerprint") != plan["policy_fingerprint"]:
            issues.append("STALE_POLICY")
        if not issues:
            return True, []
        problems.extend(issues)
    return False, sorted(set(problems))


def aggregate(plan, check_runs, approvals, graph, deadline_passed=False):
    """Decide the `required` conclusion: success, failure or pending."""
    if not plan_ok(plan):
        return {"conclusion": "failure", "reasons": ["NO_PLAN"], "jobs": {},
                "rejected": [], "ignored": [], "approval": {"required": None, "valid": False, "problems": []}}
    reasons = set()
    if plan["graph_validation"].get("status") == "fail":
        reasons.add("GRAPH_VALIDATION_FAILED")
    approval = {"required": bool(plan["approval_required"]), "valid": False, "problems": []}
    if approval["required"]:
        approval["valid"], approval["problems"] = check_approval(plan, approvals, graph["policy_approvers"])
        if not approval["valid"]:
            reasons.add("POLICY_APPROVAL_REQUIRED")

    ignored = [r for r in check_runs if r.get("name") == GATE_CONTEXT]
    by_name = {}
    for run in check_runs:
        if run.get("name") != GATE_CONTEXT:
            by_name.setdefault(run.get("name"), []).append(run)
    needed = set(plan["needed_jobs"])
    jobs, rejected = {}, []
    for job in sorted(needed):
        outcome = _judge_job(job, by_name.get(job, []), plan, graph, deadline_passed, rejected)
        jobs[job] = outcome or "ok"
        if outcome:
            reasons.add(outcome)
    for name in sorted(set(by_name) - needed):
        jobs[name] = "not_selected"

    failing = reasons - set(NON_FAILING)
    conclusion = "failure" if failing else ("pending" if reasons else "success")
    return {"conclusion": conclusion, "reasons": sorted(reasons), "jobs": jobs,
            "rejected": rejected, "ignored": ignored, "approval": approval}
