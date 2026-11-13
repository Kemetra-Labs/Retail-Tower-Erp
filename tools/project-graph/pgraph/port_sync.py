"""Offline planning for the Port `affected_services` writer (Phase 4, slice S1).

This module decides what a future trusted writer *would* send to Port for each pull
request. It never contacts Port or GitHub, holds no credentials and writes nothing: its
inputs are Git objects plus JSON snapshots, its output is a plan. It reuses
`pgraph.port_attribution` unchanged for the classification itself.

Rules, all fail closed (see PORT_SYNC.md):
- Only the existing Port fields are written: `affected_services` plus the four
  `attribution_*` / `classification_*` properties. The legacy `service` relation is never sent.
- A classifier result whose reason is an infrastructure problem is never a verdict.
- Merged pull requests are classified from the PR head, not from the landed commit, so a
  rebase merge is not reduced to its last replayed commit.
"""

import argparse
import json
import pathlib
import re
import sys

from . import gitio, port_attribution

REPOSITORY = port_attribution.REPOSITORY
REPO_NAME = REPOSITORY.split("/", 1)[1]
SERVICES = frozenset(("pos", "admin-console", "backend-core", "erpnext-connector"))
BLUEPRINT = "githubPullRequest"
WRITER_PROPERTIES = ("attribution_scope", "attribution_status",
                     "classification_policy_ref", "classification_evidence_url")
WRITER_RELATION = "affected_services"
PLAN_SCHEMA = "retail-tower/port-sync-plan@1"
POLICY_PATHS = (port_attribution.GRAPH_PATH, "tools/project-graph/pgraph")
# Classifier reason codes that describe our environment, not the pull request.
INFRA_REASONS = frozenset(("GIT_OR_GRAPH_EVIDENCE_UNAVAILABLE", "TRUSTED_GRAPH_UNAVAILABLE",
                           "TRUSTED_GRAPH_INVALID", "INVALID_COMMIT_SHA", "INVALID_PR_NUMBER"))
_SCOPES = frozenset(("single", "multi", "shared", "unknown"))
_STATUSES = frozenset(("classified", "pending", "insufficient_evidence"))
_SHA = re.compile(r"[0-9a-f]{40}\Z")
_COMPARE = f"https://github.com/{REPOSITORY}/compare/"
_COMPARE_URL = re.compile(re.escape(_COMPARE) + r"[0-9a-f]{40}\.\.\.([0-9a-f]{40})\Z")
_PATH = re.compile(rf"/v1/blueprints/{BLUEPRINT}/entities/{re.escape(REPO_NAME)}-pr-[1-9][0-9]*\Z")
_QUERY = {"create_missing_related_entities": "false"}


class PlanError(ValueError):
    """A desired state or request that must never be sent."""


def _sha(value):
    return isinstance(value, str) and bool(_SHA.fullmatch(value))


def _int(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return value if isinstance(value, int) and value > 0 else None


def _git_ok(repo, *args):
    return gitio._git(repo, *args).returncode == 0


def _is_ancestor(repo, ancestor, descendant):
    return _git_ok(repo, "merge-base", "--is-ancestor", ancestor, descendant)


def _parents(repo, sha):
    proc = gitio._git(repo, "rev-list", "--parents", "-n1", sha)
    fields = proc.stdout.decode("ascii", "replace").split()
    return fields[1:] if proc.returncode == 0 and fields[:1] == [sha] else None


def policy_ref(repo, main_tip):
    """Last commit on the trusted tip that touched the graph or the classifier code, or None.

    Stable across unrelated merges, so open PRs are not rewritten on every push to main.
    Verified: the graph blob and classifier tree at that commit equal the ones at the tip."""
    if not _sha(main_tip) or not gitio._commit_exists(repo, main_tip):
        return None
    proc = gitio._git(repo, "log", "-1", "--format=%H", main_tip, "--", *POLICY_PATHS)
    ref = proc.stdout.decode("ascii", "replace").strip()
    if proc.returncode != 0 or not _sha(ref):
        return None
    for path in POLICY_PATHS:
        a = gitio._git(repo, "rev-parse", f"{ref}:{path}")
        b = gitio._git(repo, "rev-parse", f"{main_tip}:{path}")
        if a.returncode != 0 or b.returncode != 0 or a.stdout != b.stdout:
            return None
    return ref


def evidence_url(diff_base, head):
    """Compare view that encodes both SHAs, so it shows exactly the classified diff."""
    return f"{_COMPARE}{diff_base}...{head}" if _sha(diff_base) and _sha(head) else None


def parse_evidence_head(url):
    match = _COMPARE_URL.fullmatch(url) if isinstance(url, str) else None
    return match.group(1) if match else None


def _refuse(kind, *reasons, head=None):
    return {"ok": False, "kind": kind, "reasons": sorted(reasons), "head": head}


def choose_evidence(repo, pr, main_tip):
    """Pick the (base, head) pair the classifier should read, or refuse."""
    number, head = _int(pr.get("number")), pr.get("head_sha")
    if number is None or not _sha(head) or pr.get("state") not in ("open", "closed") \
            or not isinstance(pr.get("merged"), bool):
        return _refuse("infra", "INVALID_PR_SNAPSHOT")
    if pr.get("base_ref") != "main":
        return _refuse("insufficient", "NON_MAIN_BASE", head=head)
    if pr.get("head_repo") != REPOSITORY:
        return _refuse("insufficient", "FOREIGN_HEAD_REPO", head=head)
    if not _sha(main_tip) or not gitio._commit_exists(repo, main_tip):
        return _refuse("infra", "TRUSTED_TIP_UNAVAILABLE", head=head)
    if not gitio._commit_exists(repo, head):
        return _refuse("infra", "HEAD_OBJECT_MISSING", head=head)
    if not _is_ancestor(repo, head, main_tip):
        return {"ok": True, "base": main_tip, "head": head, "basis": "pr_head"}
    # The head is already in main: a merge-commit merge is the only case with a usable base.
    merge = pr.get("merge_commit_sha")
    parents = _parents(repo, merge) if pr["merged"] and _sha(merge) else None
    if parents and len(parents) == 2 and parents[1] == head and _is_ancestor(repo, merge, main_tip):
        return {"ok": True, "base": parents[0], "head": head, "basis": "merge_first_parent"}
    return _refuse("insufficient", "HEAD_ALREADY_IN_BASE", head=head)


def classify_pr(repo, pr, main_tip):
    """Outcome: `classified`, `insufficient` (deterministic) or `infra` (no verdict)."""
    evidence = choose_evidence(repo, pr, main_tip)
    empty = {"services": [], "scope": "unknown", "shared": [], "diff_base": None, "basis": None}
    if not evidence["ok"]:
        return {**empty, "outcome": evidence["kind"], "head_sha": evidence["head"],
                "reasons": evidence["reasons"]}
    result = port_attribution.classify_git(repo, evidence["base"], evidence["head"], _int(pr["number"]))
    if result["attribution_status"] == "classified":
        return {"outcome": "classified", "services": list(result["affected_services"]),
                "scope": result["attribution_scope"], "shared": list(result["shared_classes"]),
                "diff_base": result["diff_base_sha"], "head_sha": evidence["head"],
                "basis": evidence["basis"], "reasons": []}
    reasons = list(result["reason_codes"])
    kind = "infra" if INFRA_REASONS & set(reasons) else "insufficient"
    return {**empty, "outcome": kind, "head_sha": evidence["head"], "reasons": reasons}


def _pending():
    return {"properties": {"attribution_scope": "unknown", "attribution_status": "pending",
                           "classification_policy_ref": None, "classification_evidence_url": None},
            "relations": {WRITER_RELATION: []}}


def desired_state(outcome, ref):
    """Writer-owned fields for a verdict; None when there is no verdict (infrastructure)."""
    kind = outcome["outcome"]
    if kind == "infra":
        return None
    if kind == "insufficient":
        return {"properties": {"attribution_scope": "unknown", "attribution_status": "insufficient_evidence",
                               "classification_policy_ref": ref, "classification_evidence_url": None},
                "relations": {WRITER_RELATION: []}}
    services = sorted(set(outcome["services"]))
    if not set(services) <= SERVICES:
        raise PlanError("classifier named a service outside the Retail Tower allow-list")
    url = evidence_url(outcome["diff_base"], outcome["head_sha"])
    if url is None:
        raise PlanError("classified result without usable evidence SHAs")
    return {"properties": {"attribution_scope": outcome["scope"], "attribution_status": "classified",
                           "classification_policy_ref": ref, "classification_evidence_url": url},
            "relations": {WRITER_RELATION: services}}


def _rel_ids(value):
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [i for v in value for i in _rel_ids(v)]
    if isinstance(value, dict):
        return _rel_ids(value.get("identifier"))
    return [value] if isinstance(value, str) else []


def find_entity(entities, number):
    """The one Port PR entity for this number, or (None, problem). Never guesses."""
    candidates = []
    for entity in entities:
        props, rels = entity.get("properties") or {}, entity.get("relations") or {}
        if _int(props.get("prNumber")) == number and _rel_ids(rels.get("repository")) == [REPO_NAME]:
            candidates.append(entity)
    if not candidates:
        return None, "PORT_ENTITY_MISSING"
    if len(candidates) > 1:
        return None, "PORT_ENTITY_AMBIGUOUS"
    if candidates[0].get("identifier") != f"{REPO_NAME}-pr-{number}":
        return None, "PORT_IDENTIFIER_MISMATCH"
    return candidates[0], None


def _stored(entity):
    props = entity.get("properties") or {}
    rels = entity.get("relations") or {}
    return {"properties": {k: props.get(k) for k in WRITER_PROPERTIES},
            "services": sorted(set(_rel_ids(rels.get(WRITER_RELATION)))),
            "status": props.get("attribution_status"),
            "head": parse_evidence_head(props.get("classification_evidence_url"))}


def validate_request(request):
    """Raise PlanError unless this is exactly the one partial PATCH the writer may send."""
    body = request.get("body") if isinstance(request, dict) else None
    problems = []
    if not isinstance(request, dict) or request.get("method") != "PATCH":
        problems.append("method")
    if not isinstance(request, dict) or not _PATH.fullmatch(str(request.get("path"))):
        problems.append("path")
    if not isinstance(request, dict) or request.get("query") != _QUERY:
        problems.append("query")
    if not isinstance(body, dict) or set(body) != {"properties", "relations"}:
        problems.append("body keys")
    else:
        props, rels = body["properties"], body["relations"]
        if not isinstance(props, dict) or set(props) != set(WRITER_PROPERTIES):
            problems.append("properties")
        else:
            if props["attribution_scope"] not in _SCOPES | {None} \
                    or props["attribution_status"] not in _STATUSES | {None}:
                problems.append("enum value")
            if any(v is not None and not isinstance(v, str) for v in props.values()):
                problems.append("property type")
        services = rels.get(WRITER_RELATION) if isinstance(rels, dict) else None
        if not isinstance(rels, dict) or set(rels) != {WRITER_RELATION}:
            problems.append("relations")
        elif not isinstance(services, list) or services != sorted(set(services)) \
                or not set(services) <= SERVICES:
            problems.append("services")
    if problems:
        raise PlanError("forbidden request: " + ", ".join(problems))


def build_request(entity_id, desired):
    request = {"method": "PATCH", "path": f"/v1/blueprints/{BLUEPRINT}/entities/{entity_id}",
               "query": dict(_QUERY),
               "body": {"properties": dict(desired["properties"]),
                        "relations": {WRITER_RELATION: list(desired["relations"][WRITER_RELATION])}}}
    validate_request(request)
    return request


def is_stale(item, live_head):
    """True unless the PR head GitHub reports right now is the head this item was planned for."""
    return not _sha(live_head) or item.get("head_sha") != live_head


def _item(pr, entity, action, reason, desired=None, request=None):
    return {"pr": pr.get("number"), "entity": entity.get("identifier") if entity else None,
            "head_sha": pr.get("head_sha"), "action": action, "reason": reason,
            "desired": desired, "request": request}


def plan_pr(pr, outcome, ref, entity, port_services):
    stored = _stored(entity)
    if pr.get("merged") is True and stored["status"] == "classified" and stored["head"] == pr.get("head_sha"):
        return _item(pr, entity, "noop", "FROZEN_MERGED")
    if outcome["outcome"] == "infra":
        if stored["status"] is None:
            return _item(pr, entity, "noop", "INFRA_NOT_YET_ATTRIBUTED")
        if stored["head"] == pr.get("head_sha"):
            return _item(pr, entity, "noop", "INFRA_KEEP_CURRENT")
        desired = _pending()
    else:
        desired = desired_state(outcome, ref)
        if not set(desired["relations"][WRITER_RELATION]) <= set(port_services):
            return _item(pr, entity, "skip", "PORT_SERVICE_MISSING", desired)
    if desired["properties"] == stored["properties"] \
            and desired["relations"][WRITER_RELATION] == stored["services"]:
        return _item(pr, entity, "noop", "UP_TO_DATE", desired)
    return _item(pr, entity, "patch", "CHANGED", desired, build_request(entity["identifier"], desired))


def plan_all(repo, prs, entities, main_tip, port_services):
    ref = policy_ref(repo, main_tip)
    numbers = [_int(pr.get("number")) if isinstance(pr, dict) else None for pr in prs]
    duplicated = {n for n in numbers if n is not None and numbers.count(n) > 1}
    items = []
    for pr, number in zip(prs, numbers):
        shell = pr if isinstance(pr, dict) else {}
        if number is None:
            items.append(_item(shell, None, "skip", "INVALID_PR_SNAPSHOT"))
        elif number in duplicated:     # two snapshots of one PR could send two different PATCHes
            items.append(_item(shell, None, "skip", "DUPLICATE_PR_SNAPSHOT"))
        elif ref is None:
            items.append(_item(shell, None, "skip", "POLICY_REF_UNAVAILABLE"))
        else:
            entity, problem = find_entity(entities, number)
            if problem:
                items.append(_item(shell, None, "skip", problem))
            else:
                items.append(plan_pr(shell, classify_pr(repo, shell, main_tip), ref, entity, port_services))
    summary = {action: sum(1 for i in items if i["action"] == action) for action in ("patch", "noop", "skip")}
    return {"schema": PLAN_SCHEMA, "repository": REPOSITORY, "main_tip": main_tip,
            "policy_ref": ref, "items": items, "summary": summary}


def _load(path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Offline Port sync plan; no network, no Port writes")
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan")
    plan.add_argument("--repo", default=".", help="local Git object database")
    plan.add_argument("--main-sha", required=True, help="full SHA of the trusted origin/main tip")
    plan.add_argument("--prs", required=True, help="JSON list of GitHub PR snapshots")
    plan.add_argument("--entities", required=True, help="JSON list of Port githubPullRequest entities")
    plan.add_argument("--services", required=True, help="JSON list of Port service identifiers")
    plan.add_argument("--out", help="optional plan JSON path")
    args = parser.parse_args(argv)
    if not _sha(args.main_sha):
        parser.error("--main-sha must be a full 40-hex commit SHA")
    result = plan_all(args.repo, _load(args.prs), _load(args.entities), args.main_sha,
                      frozenset(_load(args.services)))
    output = json.dumps(result, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
    if args.out:
        pathlib.Path(args.out).write_text(output, encoding="utf-8")
    else:
        sys.stdout.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
