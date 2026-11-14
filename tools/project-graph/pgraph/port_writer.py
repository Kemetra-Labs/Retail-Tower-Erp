"""Dry-run-first executor for the Port `affected_services` writer (Phase 4, slice S2, RT-1391).

The S1 planner (`pgraph.port_sync`) decides what a trusted writer would send. This module decides
whether that one write is safe to send *now*, sends it only on explicit approval, and checks the
result. GitHub and Port are reached only through injected transport objects: this module has no
HTTP client, holds no credential, reads no process settings and never imports PR code. The
classifier and planner are reused unchanged, so there is no second classifier or field list.

Transports (duck-typed; the real ones are a later, separately authorized slice):
    github.main_sha()          -> full SHA of the trusted protected branch tip right now
    github.get_pr(number)      -> the PR snapshot `port_sync` documents, or None
    port.find_entities(number) -> every Port pull-request entity whose PR number matches (any
                                  repository; each read resolves ours with `port_sync.find_entity`)
    port.service_ids()         -> identifiers of the Port service entities
    port.patch_entity(request) -> sends exactly the validated partial update (the only write)

Safety rules (PORT_WRITER.md): dry-run is the default; apply needs the digest of the reviewed plan;
at most one entity per run; everything is re-read immediately before the write because Port has no
conditional write; the result is read back and compared; a rollback request is prepared and
reported but never sent; a failed write is never retried.
"""

import argparse
import copy
import hashlib
import json
import pathlib
import sys

from . import port_sync

REPORT_SCHEMA = "retail-tower/port-writer-report@1"
DEFAULT_MAX_WRITES = 1
_HEX = frozenset("0123456789abcdef")


def _is_count(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _is_number(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _is_digest(value):
    return isinstance(value, str) and len(value) == 64 and set(value) <= _HEX


def _read(fn, *args):
    """Run one transport read. A failing read is a blocked run, never an exception."""
    try:
        return True, fn(*args)
    except Exception:       # noqa: BLE001 - any transport failure must fail closed, not crash mid-run
        return False, None


def _report(mode, result, *reasons, **fields):
    report = {"schema": REPORT_SCHEMA, "mode": mode, "result": result, "reasons": sorted(set(reasons)),
              "pr": None, "entity": None, "main_tip": None, "head_sha": None, "plan": None,
              "request": None, "digest": None, "before": None, "after": None,
              "rollback_request": None, "rollback_note": None, "writes": 0, "checks": [],
              "violations": [], "error_type": None}
    report.update(fields)
    return report


def _writer_view(entity):
    """The writer-owned part of a stored entity, as plain JSON."""
    stored = port_sync._stored(entity)
    return {"properties": dict(stored["properties"]), "services": list(stored["services"])}


def _preserved(entity):
    """Everything the writer must never change: all other properties and relations."""
    props = entity.get("properties") or {}
    rels = entity.get("relations") or {}
    return {"identifier": entity.get("identifier"), "title": entity.get("title"),
            "properties": {k: props[k] for k in sorted(props) if k not in port_sync.WRITER_PROPERTIES},
            "relations": {k: sorted(set(port_sync._rel_ids(rels[k])))
                          for k in sorted(rels) if k != port_sync.WRITER_RELATION}}


def _resolve(entities, number):
    """The one entity of this repository for this PR number, or None.

    Every read goes through the planner's own resolution (`port_sync.find_entity`), so an entity of
    another repository that happens to share the number is ignored, exactly as it is when planning."""
    if not isinstance(entities, list) or not all(isinstance(e, dict) for e in entities):
        return None
    entity, problem = port_sync.find_entity(entities, number)
    return None if problem else entity


def _fingerprint(entity):
    return {"preserved": _preserved(entity), "writer": port_sync._stored(entity)}


def _pr_key(pr):
    """What must not change between snapshot and write, except the head (reported on its own)."""
    return [pr.get(k) for k in ("state", "merged", "base_ref", "head_repo", "merge_commit_sha")]


def _digest(item, before):
    canonical = json.dumps({"entity": item["entity"], "head_sha": item["head_sha"],
                            "request": item["request"], "before": before},
                           sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _rollback(entity_id, before):
    """The request that restores the previous writer values, or None when it cannot be expressed."""
    desired = {"properties": dict(before["properties"]),
               "relations": {port_sync.WRITER_RELATION: list(before["services"])}}
    try:
        return port_sync.build_request(entity_id, desired), None
    except port_sync.PlanError:
        return None, "BEFORE_STATE_NOT_REPRESENTABLE"


def _snapshot(github, port, main_tip, number):
    """(data, reasons): the first read of everything the plan depends on."""
    ok_main, live_main = _read(github.main_sha)
    if not ok_main:
        return None, ["TRANSPORT_READ_FAILED"]
    if live_main != main_tip:
        return None, ["STALE_MAIN_TIP"]
    ok_pr, pr = _read(github.get_pr, number)
    ok_entities, entities = _read(port.find_entities, number)
    ok_services, services = _read(port.service_ids)
    if not (ok_pr and ok_entities and ok_services):
        return None, ["TRANSPORT_READ_FAILED"]
    if not isinstance(pr, dict):
        return None, ["PR_SNAPSHOT_UNAVAILABLE"]
    if port_sync._int(pr.get("number")) != number:
        return None, ["PR_NUMBER_MISMATCH"]
    try:
        services = frozenset(services)
    except TypeError:
        return None, ["TRANSPORT_READ_FAILED"]
    if not isinstance(entities, list) or not all(isinstance(e, dict) for e in entities):
        return None, ["TRANSPORT_READ_FAILED"]
    # Detached copies: the baselines for the recheck and the read-back must not move if a transport
    # hands out cached objects that a later read or the write itself changes in place.
    return {"pr": copy.deepcopy(pr), "entities": copy.deepcopy(entities), "services": services}, []


def _recheck(github, port, main_tip, number, item, first_pr, first_entity):
    """Re-read everything immediately before the write; every difference is a reason to stop."""
    ok_main, live_main = _read(github.main_sha)
    ok_pr, pr = _read(github.get_pr, number)
    ok_entities, entities = _read(port.find_entities, number)
    ok_services, services = _read(port.service_ids)
    if not (ok_main and ok_pr and ok_entities and ok_services):
        return ["TRANSPORT_READ_FAILED"]
    reasons = set()
    if live_main != main_tip:
        reasons.add("STALE_MAIN_TIP")
    if not isinstance(pr, dict) or port_sync._int(pr.get("number")) != number:
        reasons.add("PR_CHANGED")
    else:
        if port_sync.is_stale(item, pr.get("head_sha")):
            reasons.add("STALE_HEAD")
        if _pr_key(pr) != _pr_key(first_pr):
            reasons.add("PR_CHANGED")
    current = _resolve(entities, number)
    if current is None or _fingerprint(current) != _fingerprint(first_entity):
        reasons.add("ENTITY_CHANGED")
    try:
        present = set(services)
    except TypeError:
        return ["TRANSPORT_READ_FAILED"]
    if not set(item["desired"]["relations"][port_sync.WRITER_RELATION]) <= present:
        reasons.add("SERVICE_MISSING")
    return sorted(reasons)


def _best_effort_after(port, number):
    ok, entities = _read(port.find_entities, number)
    entity = _resolve(entities, number) if ok else None
    return _writer_view(entity) if entity is not None else None


def _verify(repo, main_tip, number, item, pr, before_entity, github, port):
    """Read the entity back after the write. Returns (after_view, checks, violations)."""
    violations, checks, after_view = set(), [], None
    ok_entities, entities = _read(port.find_entities, number)
    ok_pr, live_pr = _read(github.get_pr, number)
    ok_services, services = _read(port.service_ids)
    if not (ok_entities and ok_pr and ok_services) or not isinstance(entities, list):
        violations.add("READBACK_FAILED")
    else:
        after_entity = _resolve(entities, number)
        checks.append({"name": "entity_unique", "ok": after_entity is not None})
        if after_entity is None:
            violations.add("ENTITY_NOT_UNIQUE")
        else:
            after_view = _writer_view(after_entity)
            desired = item["desired"]
            took_effect = (after_view["properties"] == desired["properties"]
                           and after_view["services"] == desired["relations"][port_sync.WRITER_RELATION])
            checks.append({"name": "write_took_effect", "ok": took_effect})
            if not took_effect:
                violations.add("WRITER_FIELDS_MISMATCH")
            preserved = _preserved(after_entity) == _preserved(before_entity)
            checks.append({"name": "other_fields_preserved", "ok": preserved})
            if not preserved:
                violations.add("PRESERVED_FIELDS_CHANGED")
            try:
                replan = port_sync.plan_all(repo, [pr], [after_entity], main_tip, frozenset(services))
                noop = [i["action"] for i in replan["items"]] == ["noop"]
            except port_sync.PlanError:
                noop = False
            checks.append({"name": "replan_is_noop", "ok": noop})
            if not noop:
                violations.add("REPLAN_NOT_NOOP")
        unchanged = isinstance(live_pr, dict) and not port_sync.is_stale(item, live_pr.get("head_sha"))
        checks.append({"name": "head_unchanged_after_write", "ok": unchanged})
        if not unchanged:
            violations.add("STALE_HEAD_AFTER_WRITE")
    return after_view, checks, sorted(violations)


def run(repo, main_tip, number, github, port, *, apply=False, expected_digest=None,
        max_writes=DEFAULT_MAX_WRITES):
    """One PR, one run. Returns a JSON-serialisable report; `writes` is 0 or 1.

    Results: dry_run, noop, blocked (stale, missing or ambiguous evidence), refused (apply guard or a
    forbidden request), written (verified), verify_failed (written but the read-back disagrees; a
    rollback request is prepared, never sent) and error (the write itself failed; never retried)."""
    mode = "apply" if apply is True else "dry-run"
    if not (isinstance(apply, bool) and _is_number(number) and port_sync._sha(main_tip)
            and _is_count(max_writes)):
        return _report(mode, "refused", "INVALID_INPUT")
    if apply and not _is_digest(expected_digest):
        return _report(mode, "refused", "DIGEST_REQUIRED", pr=number, main_tip=main_tip)
    if apply and max_writes < 1:
        return _report(mode, "refused", "WRITE_CAP_EXHAUSTED", pr=number, main_tip=main_tip)

    snap, reasons = _snapshot(github, port, main_tip, number)
    if snap is None:
        return _report(mode, "blocked", *reasons, pr=number, main_tip=main_tip)
    pr, entities = snap["pr"], snap["entities"]
    common = {"pr": number, "main_tip": main_tip, "head_sha": pr.get("head_sha")}
    try:
        plan = port_sync.plan_all(repo, [pr], entities, main_tip, snap["services"])
    except port_sync.PlanError:
        return _report(mode, "blocked", "PLAN_REJECTED", **common)
    items = plan.get("items") or []
    if len(items) != 1:
        return _report(mode, "blocked", "PLAN_UNAVAILABLE", **common)
    item = items[0]
    common.update(entity=item.get("entity"),
                  plan={"action": item["action"], "reason": item["reason"], "desired": item["desired"]})
    if item["action"] == "skip":
        return _report(mode, "blocked", item["reason"], **common)
    if item["action"] == "noop":
        return _report(mode, "noop", item["reason"], **common)

    request = item["request"]
    try:
        port_sync.validate_request(request)
    except port_sync.PlanError:
        return _report(mode, "refused", "FORBIDDEN_REQUEST", **common)
    entity, _ = port_sync.find_entity(entities, number)
    before = _writer_view(entity)
    rollback, note = _rollback(item["entity"], before)
    digest = _digest(item, before)
    common.update(request=copy.deepcopy(request), digest=digest, before=before,
                  rollback_request=rollback, rollback_note=note)
    if not apply:
        return _report(mode, "dry_run", **common)
    if digest != expected_digest:
        return _report(mode, "refused", "PLAN_DIGEST_MISMATCH", **common)

    problems = _recheck(github, port, main_tip, number, item, pr, entity)
    if problems:
        return _report(mode, "blocked", *problems, **common)
    sent = copy.deepcopy(request)
    try:
        port_sync.validate_request(sent)       # again, on the exact object that is about to be sent
    except port_sync.PlanError:
        return _report(mode, "refused", "FORBIDDEN_REQUEST", **common)
    common["checks"] = [{"name": "pre_write_recheck", "ok": True}]
    try:
        port.patch_entity(sent)
    except Exception as exc:    # noqa: BLE001 - never retried; only the class name is kept (the text may hold secrets)
        return _report(mode, "error", "PATCH_FAILED", writes=1, error_type=type(exc).__name__,
                       after=_best_effort_after(port, number), **{k: v for k, v in common.items()})
    after, checks, violations = _verify(repo, main_tip, number, item, pr, entity, github, port)
    common["checks"] = common["checks"] + checks
    if violations:
        return _report(mode, "verify_failed", "VERIFY_FAILED", writes=1, after=after,
                       violations=violations, **common)
    return _report(mode, "written", writes=1, after=after, **common)


class SnapshotGithub:
    """Read-only transport over recorded PR snapshots, for the offline CLI and for tests."""

    def __init__(self, prs, main_sha):
        self._prs = [p for p in prs if isinstance(p, dict)] if isinstance(prs, list) else []
        self._main = main_sha

    def main_sha(self):
        return self._main

    def get_pr(self, number):
        matches = [p for p in self._prs if port_sync._int(p.get("number")) == number]
        return copy.deepcopy(matches[0]) if len(matches) == 1 else None


class SnapshotPort:
    """Read-only transport over recorded Port entities. It has no way to write."""

    def __init__(self, entities, services):
        self._entities = [e for e in entities if isinstance(e, dict)] if isinstance(entities, list) else []
        self._services = [str(s) for s in services] if isinstance(services, list) else []

    def find_entities(self, number):
        return copy.deepcopy([e for e in self._entities
                              if port_sync._int((e.get("properties") or {}).get("prNumber")) == number])

    def service_ids(self):
        return sorted(self._services)

    def patch_entity(self, request):
        raise port_sync.PlanError("snapshot transport is read-only")


def _load(path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Offline Port writer dry-run; no network, no Port writes")
    sub = parser.add_subparsers(dest="command", required=True)
    dry = sub.add_parser("dry-run")
    dry.add_argument("--repo", default=".", help="local Git object database")
    dry.add_argument("--main-sha", required=True, help="full SHA of the trusted protected branch tip")
    dry.add_argument("--pr", type=int, required=True, help="the one pull request number")
    dry.add_argument("--prs", required=True, help="JSON list of GitHub PR snapshots")
    dry.add_argument("--entities", required=True, help="JSON list of Port pull-request entities")
    dry.add_argument("--services", required=True, help="JSON list of Port service identifiers")
    dry.add_argument("--out", help="optional report JSON path")
    args = parser.parse_args(argv)
    if not port_sync._sha(args.main_sha):
        parser.error("--main-sha must be a full 40-hex commit SHA")
    report = run(args.repo, args.main_sha, args.pr, SnapshotGithub(_load(args.prs), args.main_sha),
                 SnapshotPort(_load(args.entities), _load(args.services)))
    output = json.dumps(report, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
    if args.out:
        pathlib.Path(args.out).write_text(output, encoding="utf-8")
    else:
        sys.stdout.write(output)
    return 0 if report["result"] in ("dry_run", "noop") else 2


if __name__ == "__main__":
    raise SystemExit(main())
