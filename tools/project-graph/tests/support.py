"""Test-only helpers: load fixtures and turn a fixture case into evaluator /
aggregator inputs. Production code never imports this module."""

import copy
import hashlib
import pathlib

import yaml

from pgraph import evaluate as ev
from pgraph.graph import load_graph

PG_ROOT = pathlib.Path(__file__).resolve().parents[1]
GRAPH_PATH = PG_ROOT / "graph.yaml"
FIXTURES = PG_ROOT / "fixtures"

BASE = "1" * 40
HEAD = "2" * 40


def trusted_text():
    return GRAPH_PATH.read_text(encoding="utf-8")


def fixture_files():
    return sorted(FIXTURES.glob("*.yaml"))


def load_fixture(path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _apply_patch(data, ops):
    data = copy.deepcopy(data)
    for op in ops:
        *parents, last = op["path"]
        node = data
        for key in parents:
            node = node[key]
        if op["op"] == "delete":
            del node[last]
        elif op["op"] == "set":
            node[last] = op["value"]
        elif op["op"] == "append":
            node[last].append(op["value"])
        else:
            raise ValueError(op["op"])
    return data


def _with_overrides(text, overrides):
    if not overrides:
        return text
    data = load_graph(text)
    data.update(overrides)
    return yaml.safe_dump(data, sort_keys=False)


def graph_texts(case):
    trusted = _with_overrides(trusted_text(), case.get("trusted_overrides"))
    proposed_spec = case.get("proposed")
    if proposed_spec is None:
        return trusted, None
    if "text" in proposed_spec:
        return trusted, proposed_spec["text"]
    patched = _apply_patch(load_graph(trusted), proposed_spec["patch"])
    return trusted, yaml.safe_dump(patched, sort_keys=False)


def _blob_for(path):
    return hashlib.sha1(path.encode("utf-8")).hexdigest()


def changes(entries):
    out = []
    for e in entries:
        out.append(ev.Change(
            status=e["status"],
            path=e["path"],
            old_path=e.get("old"),
            mode=e.get("mode", "100644"),
            blob=e.get("blob", _blob_for(e["path"])),
        ))
    return out


def guarded_workflows(graph):
    """Trusted root workflows as the RT-867 plan-guard rule expects them: one `plan` job per
    workflow, every graph job guarded on its own key, `always_jobs` unguarded. Job ids are the keys."""
    workflows = {}
    for key, path in graph["jobs"].items():
        jobs = workflows.setdefault(path, {"plan": {"name": "plan", "outputs": {"jobs": "${{ steps.plan.outputs.jobs }}"}}})
        if key in graph["always_jobs"]:
            jobs[key] = {"name": key}
        else:
            jobs[key] = {"name": key, "needs": "plan",
                         "if": f"contains(fromJSON(needs.plan.outputs.jobs), '{key}')"}
    return workflows


def eval_input(case):
    trusted, proposed = graph_texts(case)
    graph = load_graph(trusted)
    workflows = None
    if "workflows" in case:      # {patch: [...]} applied to guarded_workflows(trusted graph)
        workflows = _apply_patch(guarded_workflows(graph), case["workflows"].get("patch", []))
    return ev.EvalInput(
        event=case.get("event", "pull_request"),
        base_sha=BASE,
        head_sha=HEAD,
        changes=changes(case.get("changes", [])),
        trusted_text=trusted,
        proposed_text=proposed,
        workflow_jobs=dict(graph["jobs"]),
        workflows=workflows,
    )


def _run(name, graph, spec, run_id=1):
    return {
        "name": name,
        "app_id": spec.get("app_id", graph["trusted_check_producer"]["app_id"]),
        "workflow_path": spec.get("workflow", graph["jobs"].get(name, ".github/workflows/unknown.yml")),
        "event": spec.get("event", "pull_request"),
        "head_sha": spec.get("head", HEAD),
        "run_id": spec.get("run_id", run_id),
        "run_attempt": spec.get("attempt", 1),
        "status": spec.get("status", "completed"),
        "conclusion": spec.get("conclusion", "success"),
    }


def check_runs(case, plan, graph):
    if case.get("checks") != "auto":
        return []
    overrides = case.get("check_overrides", {})
    runs = []
    for job in plan["needed_jobs"]:
        if job in overrides:
            continue
        runs.append(_run(job, graph, {}))
    for job, specs in overrides.items():
        runs.extend(_run(job, graph, s) for s in specs)
    runs.extend(_run(s["name"], graph, s) for s in case.get("extra_checks", []))
    return runs


def approvals(case, plan):
    out = []
    for a in case.get("approvals", []):
        out.append({
            "login": a["login"],
            "actor_type": a.get("actor_type", "User"),
            "kind": a.get("kind", "review"),
            "head_sha": a.get("head", plan["head_sha"]),
            "base_sha": a.get("base", plan["base_sha"]),
            "fingerprint": a.get("fingerprint", plan["policy_fingerprint"]),
        })
    return out
