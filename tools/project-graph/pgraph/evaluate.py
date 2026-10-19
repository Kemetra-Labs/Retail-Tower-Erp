"""Fail-closed evaluator (RT-709 A.2): metadata in, plan.json out.

Inputs are the trusted graph (protected base), the proposed graph (head, parsed
as data only), the raw diff entries and their modes. PR code is never executed.
Every fail-closed case selects all products and all high-risk tiers."""

import hashlib
import json
from dataclasses import dataclass, field

from . import EVALUATOR_VERSION, PLAN_SCHEMA
from .globs import GlobError, compile_glob, normalize_path
from .graph import Graph, GraphError, load_graph, validate_graph

PR_EVENTS = ("pull_request", "pull_request_target", "workflow_run")
FULL_EVENTS = ("push", "schedule", "workflow_dispatch")
APPROVAL_REASONS = ("UNKNOWN_IN_TRUSTED_ONLY", "POLICY_CHANGE")
SYMLINK_MODE = "120000"
SUBMODULE_MODE = "160000"


@dataclass(frozen=True)
class Change:
    status: str
    path: str
    old_path: str = None
    mode: str = "100644"
    blob: str = None


@dataclass(frozen=True)
class EvalInput:
    event: str
    base_sha: str
    head_sha: str
    changes: tuple
    trusted_text: str
    proposed_text: str = None          # None: graph unchanged at head
    diff_error: bool = False
    workflow_jobs: dict = None         # job -> workflow at base (rule 5)
    base_tree: frozenset = None        # rule 4 for the trusted graph
    head_tree: frozenset = None        # rule 4 for the proposed graph


@dataclass
class _Acc:
    """Accumulates one evaluation; local to `evaluate`."""
    hard: dict = field(default_factory=dict)       # reason -> details
    approval: dict = field(default_factory=dict)
    notes: set = field(default_factory=set)
    select_all: list = field(default_factory=list)
    tiers: dict = field(default_factory=dict)       # product -> set
    reasons: dict = field(default_factory=dict)     # product -> set
    needed: set = field(default_factory=set)
    paths: list = field(default_factory=list)
    boundary_review: bool = False

    def fail(self, reason, detail):
        self.hard.setdefault(reason, []).append(detail)
        self.select_all.append(reason)

    def need_approval(self, reason, detail):
        self.approval.setdefault(reason, []).append(detail)
        self.select_all.append(reason)


def _sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _canonical(data):
    return json.dumps(data, sort_keys=True, separators=(",", ":"))


def policy_fingerprint(base_sha, trusted_sha, proposed_sha, changes):
    """Binds an approval to base, both graphs and every changed blob (A.8 R1)."""
    rows = sorted([c.status, c.old_path or "", normalize_path(c.path), c.mode or "", c.blob or ""]
                  for c in changes)
    payload = {"base": base_sha, "trusted_graph": trusted_sha, "proposed_graph": proposed_sha, "changes": rows}
    return hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()


def _load(text, workflow_jobs, tree):
    """Return (data, None) or (None, error-string)."""
    try:
        data = load_graph(text)
        errors = validate_graph(data, tree_paths=tree, workflow_jobs=workflow_jobs)
    except GraphError as exc:
        return None, str(exc)
    except (GlobError, TypeError, KeyError, AttributeError) as exc:
        # Defence in depth: any validator crash on hostile input fails closed with a reason.
        return None, f"validator error: {type(exc).__name__}: {exc}"
    return (None, "; ".join(errors)) if errors else (data, None)


def _paths_of(change):
    if change.status[:1] in ("R", "C") and change.old_path:
        return [change.old_path, change.path]
    return [change.path]


def _add_product(acc, graph, product, tiers, why):
    acc.tiers.setdefault(product, set()).update(tiers)
    acc.reasons.setdefault(product, set()).add(why)
    for tier in tiers:
        acc.needed |= graph.tier_jobs(product, tier)


def _apply_class(acc, graph, cls_name, path):
    cls = graph.shared_class(cls_name)
    if cls.get("policy_change"):
        acc.need_approval("POLICY_CHANGE", path)
    if cls["selects"] == "all":
        acc.select_all.append(f"CLASS_{cls_name.upper()}")
    elif "e2e" in cls["selects"]:
        acc.needed.add(graph.data["e2e_job"])


def _classify_path(acc, trusted, proposed, path, mode):
    ct = trusted.classify(path)
    cp = proposed.classify(path) if proposed else None
    entry = {"path": normalize_path(path), "trusted": _cls_dict(ct), "proposed": _cls_dict(cp) if cp else None}
    acc.paths.append(entry)
    if ct.kind == "ambiguous" or (cp and cp.kind == "ambiguous"):
        acc.fail("AMBIGUOUS_PATH", path)
    elif ct.kind == "unknown" and (cp is None or cp.kind == "unknown"):
        acc.fail("UNKNOWN_PATH", path)
    elif ct.kind == "unknown":
        acc.need_approval("UNKNOWN_IN_TRUSTED_ONLY", path)
    tiers = set()
    for graph, c in ((trusted, ct), (proposed, cp)):
        if c is None:
            continue
        if c.kind == "product":
            # proposed tiers can only ADD jobs to what the trusted graph selects
            _add_product(acc, graph, c.owner, c.tiers, f"path:{entry['path']}")
            tiers.update(c.tiers)
        elif c.kind == "class":
            _apply_class(acc, graph, c.owner, path)
    if "low" in tiers and len(tiers) > 1:
        tiers.discard("low")
    entry["tiers"] = sorted(tiers)
    if mode == SYMLINK_MODE and normalize_path(path) not in trusted.data["allowed_symlinks"]:
        acc.fail("SYMLINK", path)
    if mode == SUBMODULE_MODE:
        acc.fail("SUBMODULE", path)
    return ct


def _cls_dict(c):
    return {"kind": c.kind, "owner": c.owner, "tiers": list(c.tiers)}


def _check_generated(acc, trusted, changed):
    for rule in trusted.data["generated"]:
        outs = [compile_glob(g) for g in rule["outputs"]]
        srcs = [compile_glob(g) for g in rule["sources"]]
        touched = [p for p in changed if any(g.match(p) for g in outs)]
        if touched and not any(any(g.match(p) for g in srcs) for p in changed):
            acc.fail("GENERATED_WITHOUT_SOURCE", ",".join(touched))


def _apply_edges(acc, trusted, changed):
    for edge in trusted.data["edges"]:
        via = [compile_glob(g) for g in edge["via"]]
        if any(any(g.match(p) for g in via) for p in changed):
            tier = "contracts" if "contracts" in trusted.data["products"][edge["from"]]["tiers"] else "high"
            _add_product(acc, trusted, edge["from"], [tier], f"edge:{edge['to']}")


def _classify_changes(acc, trusted, proposed, changes):
    changed = []
    for change in changes:
        owners = []
        for path in _paths_of(change):
            ct = _classify_path(acc, trusted, proposed, path, change.mode)
            owners.append(ct.owner if ct.kind == "product" else None)
            changed.append(normalize_path(path))
        if len(owners) == 2 and owners[0] != owners[1]:
            acc.boundary_review = True
    _check_generated(acc, trusted, changed)
    _apply_edges(acc, trusted, changed)


def _finish(acc, inp, trusted, trusted_sha, proposed_sha):
    products = {}
    names = list(trusted.data["products"]) if trusted else []
    if acc.select_all and trusted:
        acc.needed |= trusted.all_jobs
        for name in names:
            acc.tiers.setdefault(name, set()).update(trusted.high_risk_tiers(name))
            acc.reasons.setdefault(name, set()).add("select_all")
    for name in names:
        own = acc.needed & set(trusted.data["products"][name]["ci_jobs"])
        if own and name not in acc.reasons:
            acc.reasons[name] = {"forced_by_tier"}
        products[name] = {"run": bool(own) or bool(acc.select_all),
                          "reasons": sorted(acc.reasons.get(name, ())),
                          "tiers": sorted(acc.tiers.get(name, ()))}
    e2e_run = False
    if trusted:
        e2e_job = trusted.data["e2e_job"]
        e2e_run = e2e_job in acc.needed or any(set(t) - {"low"} for t in acc.tiers.values())
        if e2e_run:
            acc.needed.add(e2e_job)
        acc.needed |= set(trusted.data["always_jobs"])
    reasons = sorted(set(acc.hard) | set(acc.approval))
    status = "fail" if acc.hard else ("needs_approval" if acc.approval else "pass")
    return {
        "schema": PLAN_SCHEMA,
        "evaluator_version": EVALUATOR_VERSION,
        "event": inp.event,
        "job_event": "pull_request" if inp.event in PR_EVENTS else inp.event,
        "base_sha": inp.base_sha,
        "head_sha": inp.head_sha,
        "trusted_graph_sha": trusted_sha,
        "proposed_graph_sha": proposed_sha,
        "select_all": bool(acc.select_all),
        "select_all_reasons": sorted(set(acc.select_all)),
        "products": products,
        "e2e": {"run": e2e_run},
        "needed_jobs": sorted(acc.needed),
        "policy_change": "POLICY_CHANGE" in acc.approval,
        "approval_required": bool(acc.approval),
        "policy_fingerprint": policy_fingerprint(inp.base_sha, trusted_sha, proposed_sha, inp.changes),
        "boundary_review": acc.boundary_review,
        "graph_validation": {"status": status, "reasons": reasons,
                             "details": {k: v for k, v in sorted({**acc.hard, **acc.approval}.items())}},
        "notes": sorted(acc.notes),
        "paths": acc.paths,
    }


def evaluate(inp):
    acc = _Acc()
    trusted_sha = _sha256(inp.trusted_text)
    trusted_data, err = _load(inp.trusted_text, inp.workflow_jobs, inp.base_tree)
    if trusted_data is None:
        acc.fail("GRAPH_INVALID", f"trusted: {err}")
        return _finish(acc, inp, None, trusted_sha, None)
    trusted = Graph(trusted_data)

    proposed, proposed_sha = trusted, trusted_sha
    if inp.proposed_text is not None:
        proposed_sha = _sha256(inp.proposed_text)
        proposed_data, perr = _load(inp.proposed_text, None, inp.head_tree)
        if proposed_data is None:
            acc.fail("GRAPH_INVALID", f"proposed: {perr}")
            acc.need_approval("POLICY_CHANGE", "graph unparsable or invalid")
            proposed = None
        elif _canonical(proposed_data) != _canonical(trusted_data):
            acc.need_approval("POLICY_CHANGE", "graph differs from trusted")
            proposed = Graph(proposed_data)

    if inp.event not in PR_EVENTS + FULL_EVENTS:
        acc.fail("UNKNOWN_EVENT", inp.event)
    if inp.diff_error:
        acc.fail("DIFF_UNAVAILABLE", "base/head unresolvable or diff failed")
        return _finish(acc, inp, trusted, trusted_sha, proposed_sha)
    if inp.event in FULL_EVENTS:
        acc.notes.add("FULL_RUN_EVENT")
        acc.select_all.append("FULL_RUN_EVENT")
    if not inp.changes:
        acc.notes.add("EMPTY_DIFF")
    _classify_changes(acc, trusted, proposed if proposed is not trusted else None, inp.changes)
    return _finish(acc, inp, trusted, trusted_sha, proposed_sha)
