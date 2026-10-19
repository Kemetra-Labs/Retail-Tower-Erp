"""Static privilege invariants for workflows PR activity can reach
(A.8 R5 and the A.3 T-A "base code only" rule).

Scope is an ALLOW-list: a workflow whose only triggers are push, schedule or
workflow_dispatch is out of scope; every other trigger (pull_request,
pull_request_target, workflow_run, issue_comment, pull_request_review,
check_*, workflow_call, ...) is in scope. For in-scope workflows:
  - token permissions must be declared and contain no `write` scope;
  - any `secrets` reference (secrets.X, secrets['X'], toJSON(secrets),
    `secrets: inherit`) may appear only inside a job whose environment is
    `ci-gate` (main-only), never at workflow level;
and for privileged triggers (anything in scope except pull_request):
  - actions/checkout may take no `repository` and only an absent ref, a
    40-hex literal or `${{ steps.<id>.outputs.base_sha }}`;
  - no checkout from run steps (gh pr checkout, git checkout/switch/worktree);
  - no actions/cache and no actions/download-artifact (untrusted inputs).
GitHub repo-scoped write tokens have no path restriction, so the only safe
PR-reachable token is read-only. This is defence in depth: the primary
control is that `.github/**` is a policy-class path."""

import pathlib
import re

import yaml

SAFE_TRIGGERS = frozenset({"push", "schedule", "workflow_dispatch"})
UNPRIVILEGED_PR = "pull_request"
GATE_ENVIRONMENT = "ci-gate"
SECRET_REF = re.compile(r"\bsecrets\b")
BASE_REF = re.compile(r"^(?:\$\{\{\s*steps\.[\w-]+\.outputs\.base_sha\s*\}\}|[0-9a-f]{40})$")
RUN_CHECKOUT = re.compile(r"\bgh\s+pr\s+checkout\b|\bgit\s+(?:checkout|switch|worktree\s+add)\b")


def _triggers(data):
    on = data.get("on", data.get(True))      # YAML 1.1 reads a bare `on` key as True
    if isinstance(on, str):
        return {on}
    if isinstance(on, list):
        return set(on)
    return set(on or {})


def _has_write(perms):
    if isinstance(perms, str):
        return perms == "write-all" or perms.endswith("write")
    if isinstance(perms, dict):
        return any(v == "write" for v in perms.values())
    return False


def _environment_name(job):
    env = job.get("environment")
    return env.get("name") if isinstance(env, dict) else env


def _mentions_secrets(node):
    return bool(SECRET_REF.search(yaml.safe_dump(node)))


def _step_problems(name, step):
    uses = str(step.get("uses", "")).lower()
    with_ = step.get("with") or {}
    if uses.startswith("actions/checkout@"):
        ref = str(with_.get("ref", "")).strip()
        if "repository" in with_ or (ref and not BASE_REF.match(ref)):
            yield ("HEAD_CHECKOUT_PRIVILEGED", f"job {name}")
    if RUN_CHECKOUT.search(str(step.get("run", ""))):
        yield ("HEAD_CHECKOUT_PRIVILEGED", f"job {name} (run step)")
    if uses.startswith("actions/cache"):
        yield ("CACHE_IN_PRIVILEGED", f"job {name}")
    if uses.startswith("actions/download-artifact"):
        yield ("ARTIFACT_IN_PRIVILEGED", f"job {name}")


def _job_problems(name, job, privileged):
    problems = []
    if _has_write(job.get("permissions")):
        problems.append(("PERM_WRITE", f"job {name}"))
    if _mentions_secrets(job) and _environment_name(job) != GATE_ENVIRONMENT:
        problems.append(("SECRET_OUTSIDE_ENV", f"job {name}"))
    if privileged:
        for step in job.get("steps") or []:
            if isinstance(step, dict):
                problems.extend(_step_problems(name, step))
    return problems


def scan_workflow(path, text):
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        return [{"file": path, "code": "WORKFLOW_INVALID", "detail": str(exc).splitlines()[0]}]
    if not isinstance(data, dict):
        return [{"file": path, "code": "WORKFLOW_INVALID", "detail": "not a mapping"}]
    triggers = _triggers(data)
    if not triggers - SAFE_TRIGGERS:
        return []
    privileged = bool(triggers - SAFE_TRIGGERS - {UNPRIVILEGED_PR})
    problems = []
    if "permissions" not in data:
        problems.append(("PERMISSIONS_MISSING", "top level"))
    elif _has_write(data["permissions"]):
        problems.append(("PERM_WRITE", "top level"))
    if _mentions_secrets({k: v for k, v in data.items() if k != "jobs"}):
        problems.append(("SECRET_OUTSIDE_ENV", "workflow level"))
    for name, job in (data.get("jobs") or {}).items():
        if isinstance(job, dict):
            problems.extend(_job_problems(name, job, privileged))
    return [{"file": path, "code": c, "detail": d} for c, d in problems]


def workflow_files(repo):
    root = pathlib.Path(repo)
    files = sorted((root / ".github" / "workflows").glob("*.y*ml"))
    files += sorted((root / "tools" / "ci-gate").glob("*.staged"))
    return files


def scan_repo(repo):
    out = []
    for f in workflow_files(repo):
        rel = f.relative_to(repo).as_posix()
        out.extend(scan_workflow(rel, f.read_text(encoding="utf-8")))
    return out
