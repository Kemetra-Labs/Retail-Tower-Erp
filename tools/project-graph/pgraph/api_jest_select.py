"""Backend-Core API Jest affected-test selector, SHADOW ONLY (RT-949 Phase 1, design RT-946 c14579).

Answers one question for a pull request head: could `bc/db-integration` have run only the specs
related to what changed since the last trusted full-green run (`fast`), or must it run the whole
suite (`full`)? In Phase 1 the answer is only reported beside the unchanged full run; it never
changes a job, its result or `required`.

`fast` needs ALL of:
  - an anchor: the newest PR commit (or the merge-base on main) whose latest `bc/db-integration`
    is green, judged with the same provenance rules as the gate (`aggregate._judge_job`), never
    "the previous push";
  - every path changed since the anchor is either outside Backend-Core and selects no job, or
    added/modified, in no Backend-Core tier, and inside the trusted graph's `api_jest_fast` class;
  - the base did not move in a way that selects any Backend-Core job. The base side is measured
    from `git merge-base(anchor, current base)`: the anchor's run tested the anchor merged with a
    main that already contained that commit, so this over-counts base changes and never misses one
    (the Actions API's `pull_requests[].base.sha` is not used: it is empty once a PR closes and is
    not documented as the base at trigger time);
  - at least one file to feed `jest --findRelatedTests`.
Anything else, including any error, is `full` with a reason."""

from dataclasses import dataclass

from . import gitio
from .aggregate import _judge_job
from .github import normalize_runs
from .globs import compile_glob, normalize_path
from .graph import Graph, GraphError, load_graph, validate_graph

PRODUCT = "backend-core"
FAST_KEY = "api_jest_fast"
JOB = "bc/db-integration"
WORKFLOW = ".github/workflows/backend-core.yml"
GRAPH_REPO_PATH = "tools/project-graph/graph.yaml"
REGULAR_MODES = ("100644", "100755")
FAST, FULL = "fast", "full"


@dataclass(frozen=True)
class Selection:
    mode: str
    reason: str
    anchor: str = None
    anchor_base: str = None
    files: tuple = ()

    def as_dict(self):
        return {"mode": self.mode, "reason": self.reason, "anchor": self.anchor,
                "anchor_base": self.anchor_base, "files": list(self.files)}


def _full(reason, anchor=None, anchor_base=None):
    return Selection(FULL, reason, anchor, anchor_base)


class AnchorUnavailable(Exception):
    pass


def fast_class(graph):
    """(globs, excludes) of the trusted graph's fast class, or None if it declares none."""
    spec = graph.data["products"].get(PRODUCT, {}).get(FAST_KEY)
    if not isinstance(spec, dict):
        return None
    return ([compile_glob(g) for g in spec["globs"]], [compile_glob(g) for g in spec.get("exclude", [])])


def _verdict(graph, fast, change, base_side=False):
    """('fast', path), ('ignore', None) or ('full', reason) for one changed path."""
    path = normalize_path(change.path)
    c = graph.classify(path)
    if c.kind == "class":
        selects = graph.shared_class(c.owner)["selects"]
        return ("ignore", None) if selects != "all" else ("full", f"CLASS:{c.owner}")
    if c.kind != "product":
        return ("full", f"{c.kind.upper()}_PATH")
    if c.owner != PRODUCT:
        return ("ignore", None)
    if base_side:
        return ("full", "BACKEND_CORE")
    if change.status not in ("M", "A") or change.old_path:
        return ("full", "DELETE_OR_RENAME")
    if change.mode not in REGULAR_MODES:
        return ("full", "SPECIAL_MODE")
    if c.tiers != ("high",):
        return ("full", "TIER:" + ",".join(sorted(c.tiers)))
    rel = path[len(graph.roots[PRODUCT]):]
    globs, excludes = fast
    if not any(g.match(rel) for g in globs) or any(x.match(rel) for x in excludes):
        return ("full", "NOT_FAST_ELIGIBLE")
    return ("fast", path)


def select(graph, anchor, pr_changes, base_changes, anchor_base=None):
    """Pure decision. `pr_changes`: anchor..head; `base_changes`: the anchor's base..current base."""
    fast = fast_class(graph)
    if fast is None:
        return _full("NO_FAST_CLASS", anchor, anchor_base)
    if anchor is None:
        return _full("NO_ANCHOR")
    for change in base_changes:
        kind, why = _verdict(graph, fast, change, base_side=True)
        if kind == "full":
            return _full(f"BASE_MOVED:{why}:{change.path}", anchor, anchor_base)
    files = set()
    for change in pr_changes:
        kind, value = _verdict(graph, fast, change)
        if kind == "full":
            return _full(f"{value}:{change.path}", anchor, anchor_base)
        if kind == "fast":
            files.add(value)
    if not files:
        return _full("NO_FILES", anchor, anchor_base)
    return Selection(FAST, "OK", anchor, anchor_base, tuple(sorted(files)))


def find_anchor(candidates, evidence, repo_name, graph_data):
    """Newest (sha, event) candidate whose latest `bc/db-integration` is a trusted success.

    `evidence[sha]` holds the raw REST payloads for that commit: `runs` (workflow runs),
    `jobs` (run id -> jobs, filter=all) and `checks` (check-runs), or `error`. Returns the
    anchor SHA; raises AnchorUnavailable otherwise."""
    for sha, event in candidates:
        ev = evidence.get(sha)
        if not isinstance(ev, dict) or "error" in ev:
            raise AnchorUnavailable("EVIDENCE_UNAVAILABLE")
        runs = [r for r in ev.get("runs") or [] if r.get("path") == WORKFLOW]
        jobs = {int(k): v for k, v in (ev.get("jobs") or {}).items()}
        records = [r for r in normalize_runs(repo_name, runs, jobs, ev.get("checks") or [])
                   if r["name"] == JOB]
        outcome = _judge_job(JOB, records, {"head_sha": sha, "job_event": event}, graph_data,
                             deadline_passed=True, rejected=[])
        if outcome == "DUPLICATE_CHECK":
            raise AnchorUnavailable("ANCHOR_AMBIGUOUS")
        if outcome is None:
            return sha
    raise AnchorUnavailable("NO_ANCHOR")


def _is_ancestor(repo, older, newer):
    return gitio._git(repo, "merge-base", "--is-ancestor", older, newer).returncode == 0


def _merge_base(repo, a, b):
    proc = gitio._git(repo, "merge-base", a, b)
    out = proc.stdout.decode("ascii", "replace").strip()
    return out if proc.returncode == 0 and len(out) == 40 else None


def select_from_repo(repo, base_rev, head, event, candidates, evidence, repo_name):
    """CLI path: trusted graph from `base_rev`, diffs from git plumbing, anchor from `evidence`."""
    if event != "pull_request":
        return _full("PUSH_EVENT")
    try:
        data = load_graph(gitio.read_text(repo, base_rev, GRAPH_REPO_PATH) or "")
    except GraphError:
        return _full("TRUSTED_GRAPH_INVALID")
    if validate_graph(data):
        return _full("TRUSTED_GRAPH_INVALID")
    graph = Graph(data)
    try:
        anchor = find_anchor(candidates, evidence, repo_name, data)
    except AnchorUnavailable as exc:
        return _full(str(exc))
    if not _is_ancestor(repo, anchor, head):
        return _full("ANCHOR_NOT_ANCESTOR", anchor)
    anchor_base = _merge_base(repo, anchor, base_rev)
    if anchor_base is None:
        return _full("NO_MERGE_BASE", anchor)
    try:
        pr_changes = gitio.read_changes(repo, anchor, head)
        base_changes = gitio.read_changes(repo, anchor_base, base_rev)
    except gitio.DiffUnavailable:
        return _full("DIFF_UNAVAILABLE", anchor, anchor_base)
    return select(graph, anchor, pr_changes, base_changes, anchor_base)


def report(selection, selected, total, results):
    """Shadow summary. `selected`: spec paths `jest --listTests --findRelatedTests` printed (fast
    only); `results`: the full run's `jest --json` output, or None if it is missing. Misses are
    failing specs the fast selection would not have run; never claimed without results."""
    failing = None if not isinstance(results, dict) else sorted(
        t.get("name") for t in results.get("testResults") or [] if t.get("status") == "failed")
    out = {"mode": selection.get("mode"), "reason": selection.get("reason"),
           "anchor": selection.get("anchor"), "files": len(selection.get("files") or []),
           "selected": len(selected), "total": total,
           "failing": None if failing is None else len(failing), "misses": None, "flag": None}
    if selection.get("mode") != FAST:
        return out
    if not selected:
        out["flag"] = "EMPTY_SELECTION"
    if failing is None:
        out["flag"] = out["flag"] or "NO_RESULTS"
        return out
    chosen = set(selected)
    out["misses"] = [n for n in failing if n not in chosen]
    return out
