"""Command line entry points used by the selftest workflow and the staged gate.

  evaluate       trusted base + head (data only) -> plan.json
  aggregate      plan.json + check-runs + approvals -> `required` verdict
  classify-tree  classify every tracked path at a rev (exit 1 on unknown/ambiguous)
  boundary       layer-1 boundary check of the blobs at --rev (exit 1 on violations or stale ratchet)

Output is ASCII JSON so it is safe on any console encoding."""

import argparse
import json
import pathlib
import sys

from . import aggregate as ag
from . import boundary as bd
from . import evaluate as ev
from . import github as gh
from . import gitio
from .graph import Graph, GraphError, load_graph

GRAPH_REPO_PATH = "tools/project-graph/graph.yaml"
DEFAULT_GRAPH = pathlib.Path(__file__).resolve().parents[1] / "graph.yaml"
EXIT = {"success": 0, "failure": 1, "pending": 3}


def _emit(obj):
    sys.stdout.write(json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=True) + "\n")


def _read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def cmd_evaluate(args):
    trusted = gitio.read_text(args.repo, args.base, GRAPH_REPO_PATH)
    head_graph = gitio.read_text(args.repo, args.head, GRAPH_REPO_PATH)
    proposed = None if head_graph == trusted else (head_graph or "")
    try:
        changes = tuple(gitio.read_changes(args.repo, args.base, args.head))
        base_tree = frozenset(gitio.list_tree(args.repo, args.base))
        head_tree = frozenset(gitio.list_tree(args.repo, args.head))
        diff_error = False
    except gitio.DiffUnavailable:
        changes, base_tree, head_tree, diff_error = (), None, None, True
    inp = ev.EvalInput(
        event=args.event, base_sha=args.base_sha or args.base, head_sha=args.head_sha or args.head,
        changes=changes, trusted_text=trusted or "", proposed_text=proposed, diff_error=diff_error,
        workflow_jobs=None if diff_error else gitio.workflow_jobs(args.repo, args.base),
        base_tree=base_tree, head_tree=head_tree,
    )
    plan = ev.evaluate(inp)
    pathlib.Path(args.out).write_text(json.dumps(plan, indent=2, sort_keys=True, ensure_ascii=True),
                                      encoding="utf-8")
    _emit({"graph_validation": plan["graph_validation"]["status"],
           "reasons": plan["graph_validation"]["reasons"], "select_all": plan["select_all"]})
    return 0


def cmd_aggregate(args):
    plan = _read_json(args.plan)
    checks = _read_json(args.checks) or []
    approvals = _read_json(args.approvals) or []
    if not ag.plan_ok(plan):
        result = ag.aggregate(plan, [], [], {})
        _emit(result)
        return EXIT[result["conclusion"]]
    try:
        graph = load_graph(gitio.read_text(args.repo, args.base, GRAPH_REPO_PATH) or "")
    except GraphError:
        _emit({"conclusion": "failure", "reasons": ["TRUSTED_GRAPH_UNREADABLE"]})
        return 1
    result = ag.aggregate(plan, checks, approvals, graph, deadline_passed=args.deadline_passed)
    _emit(result)
    return EXIT[result["conclusion"]]


def cmd_normalize(args):
    """Raw REST dumps (written by the gate with read-only tokens) -> records."""
    runs = (_read_json(args.workflow_runs) or {}).get("workflow_runs", [])
    jobs = {int(k): v for k, v in (_read_json(args.jobs) or {}).items()}
    checks = (_read_json(args.check_runs) or {}).get("check_runs", [])
    reviews = _read_json(args.reviews) or []
    pathlib.Path(args.out_checks).write_text(
        json.dumps(gh.normalize_runs(args.repo_name, runs, jobs, checks)), encoding="utf-8")
    pathlib.Path(args.out_approvals).write_text(
        json.dumps(gh.approvals_from_reviews(reviews)), encoding="utf-8")
    _emit({"all_runs_completed": gh.all_runs_completed(runs)})
    return 0


def _graph_from(path):
    return Graph(load_graph(pathlib.Path(path).read_text(encoding="utf-8")))


def cmd_classify_tree(args):
    graph = _graph_from(args.graph)
    paths = sorted(gitio.list_tree(args.repo, args.rev))
    by_owner, unknown, ambiguous = {}, [], []
    for p in paths:
        c = graph.classify(p)
        if c.kind == "unknown":
            unknown.append(p)
        elif c.kind == "ambiguous":
            ambiguous.append(p)
        else:
            by_owner[c.owner] = by_owner.get(c.owner, 0) + 1
    products = set(graph.roots)
    _emit({"rev": args.rev, "total": len(paths), "by_owner": by_owner,
           "product_paths": sum(n for o, n in by_owner.items() if o in products),
           "shared_paths": sum(n for o, n in by_owner.items() if o not in products),
           "unknown": unknown, "ambiguous": ambiguous})
    return 1 if unknown or ambiguous else 0


def cmd_boundary(args):
    graph = _graph_from(args.graph)
    files, unscanned = bd.read_rev_files(args.repo, args.rev)
    result = bd.scan(graph, files, bd.load_ratchet(args.repo, args.rev), unscanned=unscanned)
    _emit({"rev": args.rev, "scanned_files": len(files), **result})
    return 0 if result["ok"] else 1


def cmd_privileges(args):
    from .privileges import scan_repo
    problems = scan_repo(args.repo)
    _emit({"problems": problems})
    return 1 if problems else 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="pgraph")
    sub = p.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("evaluate")
    e.add_argument("--repo", default=".")
    e.add_argument("--base", required=True)
    e.add_argument("--head", required=True)
    e.add_argument("--base-sha")
    e.add_argument("--head-sha")
    e.add_argument("--event", required=True)
    e.add_argument("--out", required=True)
    e.set_defaults(func=cmd_evaluate)

    a = sub.add_parser("aggregate")
    a.add_argument("--plan", required=True)
    a.add_argument("--checks", required=True)
    a.add_argument("--approvals", required=True)
    a.add_argument("--repo", default=".")
    a.add_argument("--base", required=True, help="trusted rev whose graph.yaml is used")
    a.add_argument("--deadline-passed", action="store_true")
    a.set_defaults(func=cmd_aggregate)

    n = sub.add_parser("normalize")
    n.add_argument("--repo-name", required=True)
    for opt in ("--workflow-runs", "--jobs", "--check-runs", "--reviews", "--out-checks", "--out-approvals"):
        n.add_argument(opt, required=True)
    n.set_defaults(func=cmd_normalize)

    for name, func in (("classify-tree", cmd_classify_tree), ("boundary", cmd_boundary)):
        c = sub.add_parser(name)
        c.add_argument("--repo", default=".")
        c.add_argument("--rev", default="HEAD")
        c.add_argument("--graph", default=str(DEFAULT_GRAPH))
        c.set_defaults(func=func)

    pv = sub.add_parser("privileges")
    pv.add_argument("--repo", default=".")
    pv.set_defaults(func=cmd_privileges)

    args = p.parse_args(argv)
    return args.func(args)
