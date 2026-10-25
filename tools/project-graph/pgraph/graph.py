"""Loading, static validation (RT-709 A.1 rules 1-6, plus the RT-867 plan guard)
and path classification.

`load_graph` parses untrusted text: size-capped, YAML safe loader only, and it
rejects anchors, aliases and duplicate keys (all are ways for a proposed graph
to hide or override content). This module never imports PR-head code."""

import re
from collections import namedtuple

import yaml

from .globs import GlobError, compile_glob, normalize_path

SCHEMA = "retail-tower/project-graph@1"
MAX_GRAPH_BYTES = 256 * 1024
LOW_RISK_TIERS = ("low", "tooling")
PLAN_JOB = "plan"          # workflow job id of the RT-867 plan job
PLAN_OUTPUT = "jobs"       # its output: JSON list of selected graph job keys

Classification = namedtuple("Classification", "kind owner tiers")


class GraphError(ValueError):
    pass


class _StrictLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        seen = set()
        for key_node, _ in node.value:
            key = self.construct_object(key_node, deep=deep)
            if key in seen:
                raise GraphError(f"duplicate key: {key!r}")
            seen.add(key)
        return super().construct_mapping(node, deep=deep)


MAX_DEPTH = 32
_PLAIN_SCALARS = (str, int, float, bool, type(None))


def _check_plain(node, depth=0):
    """Only JSON-like data: str keys, no bytes/sets/dates from YAML tags."""
    if depth > MAX_DEPTH:
        raise GraphError("document nested too deeply")
    if isinstance(node, dict):
        for key, value in node.items():
            if not isinstance(key, str):
                raise GraphError(f"non-string key: {key!r}")
            _check_plain(value, depth + 1)
    elif isinstance(node, list):
        for value in node:
            _check_plain(value, depth + 1)
    elif not isinstance(node, _PLAIN_SCALARS):
        raise GraphError(f"unsupported YAML value type: {type(node).__name__}")


def _check_events(text):
    depth = 0
    for event in yaml.parse(text, Loader=yaml.SafeLoader):
        if isinstance(event, yaml.AliasEvent) or getattr(event, "anchor", None):
            raise GraphError("YAML anchors/aliases are not allowed")
        if isinstance(event, (yaml.MappingStartEvent, yaml.SequenceStartEvent)):
            depth += 1
            if depth > MAX_DEPTH:
                raise GraphError("document nested too deeply")
        elif isinstance(event, (yaml.MappingEndEvent, yaml.SequenceEndEvent)):
            depth -= 1


def _strict_load(text):
    if len(text.encode("utf-8")) > MAX_GRAPH_BYTES:
        raise GraphError("document exceeds size cap")
    try:
        _check_events(text)
        data = yaml.load(text, Loader=_StrictLoader)
    except yaml.YAMLError as exc:
        raise GraphError(f"YAML error: {exc}") from exc
    except (TypeError, RecursionError) as exc:      # e.g. unhashable `? [a]` keys
        raise GraphError(f"YAML structure error: {exc}") from exc
    _check_plain(data)
    return data


def load_graph(text):
    data = _strict_load(text)
    if not isinstance(data, dict):
        raise GraphError("graph must be a mapping")
    return data


def load_yaml_list(text):
    """Strictly load a YAML list of mappings (the boundary ratchet)."""
    data = _strict_load(text)
    if data is None:
        return []
    if not isinstance(data, list) or not all(isinstance(e, dict) for e in data):
        raise GraphError("expected a list of mappings")
    return data


# --------------------------------------------------------------- validation

def _is_str_list(value):
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


def _schema_errors(data):
    errs = []
    if data.get("schema") != SCHEMA:
        errs.append(f"SCHEMA: schema must be {SCHEMA}")
    expected = {
        "products": dict, "shared_classes": dict, "jobs": dict, "always_jobs": list,
        "e2e_job": str, "edges": list, "generated": list, "allowed_symlinks": list,
        "policy_approvers": list, "trusted_check_producer": dict,
    }
    for key, typ in expected.items():
        if not isinstance(data.get(key), typ):
            errs.append(f"SCHEMA: {key} must be a {typ.__name__}")
    if errs:
        return errs
    for section in ("products", "shared_classes", "jobs"):
        if not all(isinstance(k, str) for k in data[section]):
            errs.append(f"SCHEMA: {section} keys must be strings")
    if errs:
        return errs
    if not isinstance(data["trusted_check_producer"].get("app_id"), int):
        errs.append("SCHEMA: trusted_check_producer.app_id must be an int")
    if not _is_str_list(data["policy_approvers"]) or not _is_str_list(data["allowed_symlinks"]):
        errs.append("SCHEMA: policy_approvers/allowed_symlinks must be string lists")
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in data["jobs"].items()):
        errs.append("SCHEMA: jobs must map job name to workflow path")
    for name, prod in data["products"].items():
        if not isinstance(prod, dict) or not isinstance(prod.get("root"), str) \
                or not isinstance(prod.get("tiers"), dict) \
                or not _is_str_list(prod.get("ci_jobs")) or not _is_str_list(prod.get("high_jobs")) \
                or not _is_str_list((prod.get("toolchain") or {}).get("lockfiles")):
            errs.append(f"SCHEMA: product {name} is malformed")
            continue
        root = prod["root"]
        if not root.endswith("/") or root.startswith("/") or ".." in root.split("/"):
            errs.append(f"SCHEMA: product {name} root must be a relative dir ending in '/'")
        for tname, tier in prod["tiers"].items():
            if tname == "high" or not isinstance(tier, dict) or not _is_str_list(tier.get("globs")) \
                    or not _is_str_list(tier.get("jobs")) or not _is_str_list(tier.get("exclude", [])):
                errs.append(f"SCHEMA: tier {name}.{tname} is malformed")
    for name, cls in data["shared_classes"].items():
        if not isinstance(cls, dict) or not isinstance(cls.get("precedence"), int) \
                or not _is_str_list(cls.get("globs")) \
                or not (cls.get("selects") == "all"
                        or (_is_str_list(cls.get("selects")) and set(cls["selects"]) <= {"e2e"})):
            errs.append(f"SCHEMA: shared class {name} is malformed (selects must be all, [e2e] or [])")
    for edge in data["edges"]:
        if not isinstance(edge, dict) or edge.get("from") not in data["products"] \
                or edge.get("to") not in data["products"] or not _is_str_list(edge.get("via")):
            errs.append(f"SCHEMA: edge {edge!r} is malformed")
    for gen in data["generated"]:
        if not isinstance(gen, dict) or not _is_str_list(gen.get("outputs")) or not _is_str_list(gen.get("sources")):
            errs.append(f"SCHEMA: generated entry {gen!r} is malformed")
    return errs


def _compile_all(globs, code, errs):
    out = []
    for g in globs:
        try:
            out.append(compile_glob(g))
        except GlobError as exc:
            errs.append(f"{code}: {exc}")
    return out


def _prefix_overlaps(a, b):
    """True if literal path prefixes a and b can describe overlapping trees."""
    if not a or not b:
        return True
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def _check_roots(data, errs):
    roots = {n: p["root"] for n, p in data["products"].items()}
    names = sorted(roots)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if roots[a].startswith(roots[b]) or roots[b].startswith(roots[a]):
                errs.append(f"ROOT_OVERLAP: {a} and {b}")
    return roots


def _check_shared(data, roots, errs):
    by_prec = {}
    for name, cls in data["shared_classes"].items():
        for g in _compile_all(cls["globs"], "GLOB_INVALID", errs):
            prefix = g.literal_prefix()
            multi_segment = "/" in g.text
            if g.text.startswith("**"):
                errs.append(f"SHARED_GLOB_IN_PRODUCT: {name} glob {g.text} is unanchored")
                continue
            # A policy class outranks product ownership (Graph.classify), so it may reach into a
            # product root: it only ever adds approval and selects everything (fail closed).
            if cls.get("policy_change") is True:
                by_prec.setdefault(cls["precedence"], []).append((name, g))
                continue
            for pname, root in roots.items():
                inside = (prefix + "/").startswith(root)
                covers = multi_segment and (prefix == "" or root.startswith(prefix + "/"))
                if inside or covers:
                    errs.append(f"SHARED_GLOB_IN_PRODUCT: {name} glob {g.text} reaches {pname}")
            by_prec.setdefault(cls["precedence"], []).append((name, g))
    for prec, entries in by_prec.items():
        for i, (na, ga) in enumerate(entries):
            for nb, gb in entries[i + 1:]:
                if na != nb and _prefix_overlaps(ga.literal_prefix(), gb.literal_prefix()):
                    errs.append(f"SAME_PRECEDENCE_OVERLAP: {na}:{ga.text} vs {nb}:{gb.text} at {prec}")


def _check_tiers(data, errs):
    for pname, prod in data["products"].items():
        for tname, tier in prod["tiers"].items():
            for g in tier["globs"] + tier.get("exclude", []):
                if g.startswith("/") or ".." in g.split("/"):
                    errs.append(f"TIER_GLOB_OUTSIDE_PRODUCT: {pname}.{tname} {g}")
                    continue
                _compile_all([g], "GLOB_INVALID", errs)


def _job_refs(data):
    refs = list(data["always_jobs"]) + [data["e2e_job"]]
    for prod in data["products"].values():
        refs += prod["ci_jobs"] + prod["high_jobs"]
        for tier in prod["tiers"].values():
            refs += tier["jobs"]
    for members in (data.get("job_groups") or {}).values():
        refs += members
    return refs


def _check_jobs(data, workflow_jobs, errs):
    groups = data.get("job_groups") or {}
    for ref in _job_refs(data):
        if ref.startswith("@"):
            if ref[1:] not in groups:
                errs.append(f"UNKNOWN_JOB: group {ref}")
        elif ref not in data["jobs"]:
            errs.append(f"UNKNOWN_JOB: {ref}")
    owners = {}
    for pname, prod in data["products"].items():
        for job in prod["ci_jobs"]:
            if job in owners:
                errs.append(f"DUPLICATE_JOB: {job} owned by {owners[job]} and {pname}")
            owners[job] = pname
    if workflow_jobs is not None:
        for job, workflow in sorted(data["jobs"].items()):
            if workflow_jobs.get(job) != workflow:
                errs.append(f"CI_JOB_MISSING: {job}")


_GUARD_PREFIX = re.compile(r"^!\s*cancelled\(\s*\)\s*&&\s*needs\.plan\.result\s*==\s*'success'\s*&&\s*")
_GUARD_TERM = re.compile(r"^contains\(\s*fromJSON\(\s*needs\.plan\.outputs\.jobs\s*\)\s*,\s*'([^'\s]+)'\s*\)$")


def guard_keys(expr):
    """Graph job keys a job-level `if:` selects on, or None if it is not a plan guard.

    Only one canonical shape is accepted, so the rule can tell what the guard selects:
        [!cancelled() && needs.plan.result == 'success' &&] ( contains(fromJSON(needs.plan.outputs.jobs), 'KEY') [|| ...] )
    with or without the `${{ }}` wrapper and the outer parentheses. Without the prefix GitHub
    adds its implicit success(), so a failed or skipped plan skips the job."""
    if not isinstance(expr, str):
        return None
    body = expr.strip()
    if body.startswith("${{") and body.endswith("}}"):
        body = body[3:-2].strip()
    stripped = _GUARD_PREFIX.sub("", body, count=1)
    prefixed, body = stripped != body, stripped
    parenthesised = body.startswith("(") and body.endswith(")")
    if parenthesised:
        body = body[1:-1].strip()
    if prefixed and not parenthesised and "||" in body:
        return None        # `&&` binds tighter: `p && a || b` would run b without the prefix
    keys = []
    for term in body.split("||"):
        m = _GUARD_TERM.match(term.strip())
        if not m:
            return None
        keys.append(m.group(1))
    return frozenset(keys)


def _needs(job):
    needs = job.get("needs")
    if isinstance(needs, str):
        return [needs]
    return [n for n in needs if isinstance(n, str)] if isinstance(needs, list) else []


def _literal_name(job_id, job):
    name = job.get("name", job_id)
    return name if isinstance(name, str) and "${{" not in name else None


def _check_guards(data, workflows, errs):
    """Rule 5b (RT-867, MR-4): CI executes only what the graph selects.

    Every graph job outside `always_jobs` must need the workflow's `plan` job and carry a
    guard on its own key; every job it needs (transitively, e.g. POS shards, Schemathesis
    shards) must be guarded on that key too, so a selected job never waits on a skipped
    dependency. `always_jobs` must stay unguarded. `workflows` maps workflow path -> raw
    `jobs:` mapping, read from the TRUSTED rev."""
    always = set(data["always_jobs"])
    plan_checked = set()
    defined = {}                                      # key -> [(workflow, job id)] across ALL workflows
    for wpath, wjobs in sorted(workflows.items()):
        for jid, job in (wjobs.items() if isinstance(wjobs, dict) else ()):
            if isinstance(job, dict) and _literal_name(jid, job) in data["jobs"]:
                defined.setdefault(_literal_name(jid, job), []).append((wpath, jid))
    for key, path in sorted(data["jobs"].items()):
        jobs = workflows.get(path)
        if not isinstance(jobs, dict):
            continue                                  # rule 5 reports the missing job
        # rule 5's name -> workflow map keeps only one definition, so a second job with the
        # same key (here or in another workflow) would run unselected without this check.
        if len(defined.get(key, [])) > 1:
            errs.append(f"CI_JOB_UNGUARDED: {key} is defined by {len(defined[key])} jobs")
            continue
        ids = [i for i, j in jobs.items() if isinstance(j, dict) and _literal_name(i, j) == key]
        if len(ids) != 1:
            continue                                  # rule 5 reports the missing job
        job = jobs[ids[0]]
        if key in always:
            if PLAN_JOB in _needs(job) or "if" in job:
                errs.append(f"ALWAYS_JOB_GUARDED: {key}")
            continue
        if path not in plan_checked:
            plan_checked.add(path)
            plan = jobs.get(PLAN_JOB)
            if not isinstance(plan, dict) or PLAN_OUTPUT not in (plan.get("outputs") or {}) \
                    or "if" in plan or _needs(plan):
                errs.append(f"CI_PLAN_MISSING: {path}")
        stack, seen = [ids[0]], set()
        while stack:
            jid = stack.pop()
            if jid in seen or jid == PLAN_JOB:
                continue
            seen.add(jid)
            dep = jobs.get(jid)
            where = "" if jid == ids[0] else f" (via {jid})"
            if not isinstance(dep, dict):
                errs.append(f"CI_JOB_UNGUARDED: {key}{where} is not defined")
                continue
            keys = guard_keys(dep.get("if"))
            if PLAN_JOB not in _needs(dep) or keys is None or key not in keys:
                errs.append(f"CI_JOB_UNGUARDED: {key}{where}")
            stack.extend(_needs(dep))


def _check_tree(data, tree_paths, errs):
    def any_match(glob_text):
        g = compile_glob(glob_text)
        return any(g.match(p) for p in tree_paths)

    for pname, prod in data["products"].items():
        for lock in prod["toolchain"]["lockfiles"]:
            if lock not in tree_paths:
                errs.append(f"LOCKFILE_MISSING: {lock}")
    for edge in data["edges"]:
        for via in edge["via"]:
            if not any_match(via):
                errs.append(f"EDGE_VIA_MISSING: {via}")
    for gen in data["generated"]:
        for g in gen["outputs"] + gen["sources"]:
            if not any_match(g):
                errs.append(f"GENERATED_PATH_MISSING: {g}")


def validate_graph(data, tree_paths=None, workflow_jobs=None, workflows=None):
    """Return a list of 'CODE: detail' strings; empty means valid.

    `workflow_jobs` (job name -> workflow path) enables rule 5; `workflows` (workflow path ->
    raw `jobs:` mapping) enables the RT-867 plan-guard rule. Both come from the trusted rev."""
    errs = _schema_errors(data)
    if errs:
        return errs
    roots = _check_roots(data, errs)
    _check_shared(data, roots, errs)
    _check_tiers(data, errs)
    _check_jobs(data, workflow_jobs, errs)
    if workflows is not None:
        _check_guards(data, workflows, errs)
    for edge in data["edges"]:
        _compile_all(edge["via"], "GLOB_INVALID", errs)
    for gen in data["generated"]:
        _compile_all(gen["outputs"] + gen["sources"], "GLOB_INVALID", errs)
    for g in data["allowed_symlinks"]:
        if normalize_path(g) != g:
            errs.append(f"SCHEMA: allowed_symlinks entry not normalised: {g}")
    if tree_paths is not None and not errs:
        _check_tree(data, tree_paths, errs)
    return errs


# ------------------------------------------------------------ classification

class Graph:
    """Compiled view of a graph that passed `validate_graph`."""

    def __init__(self, data):
        self.data = data
        self.roots = {n: p["root"] for n, p in data["products"].items()}
        self._tiers = {}
        for pname, prod in data["products"].items():
            self._tiers[pname] = [
                (tname, [compile_glob(g) for g in t["globs"]], [compile_glob(g) for g in t.get("exclude", [])])
                for tname, t in prod["tiers"].items()
            ]
        self._classes = sorted(
            ((c["precedence"], name, [compile_glob(g) for g in c["globs"]])
             for name, c in data["shared_classes"].items()),
            key=lambda item: (item[0], item[1]),
        )
        self.job_owner = {j: p for p, prod in data["products"].items() for j in prod["ci_jobs"]}
        self._policy = {name for name, c in data["shared_classes"].items() if c.get("policy_change") is True}

    def product_of(self, path):
        """Product whose root contains `path` (None if none or overlapping), by root alone.
        The boundary check uses this: a product's own .github/ is still that product's code."""
        owners = [n for n, root in self.roots.items() if normalize_path(path).startswith(root)]
        return owners[0] if len(owners) == 1 else None

    def _class_hit(self, path, names=None):
        for prec in sorted({c[0] for c in self._classes}):
            hits = [name for p, name, globs in self._classes
                    if p == prec and (names is None or name in names) and any(g.match(path) for g in globs)]
            if len(hits) > 1:
                return Classification("ambiguous", tuple(hits), ())
            if hits:
                return Classification("class", hits[0], ())
        return None

    def classify(self, path):
        path = normalize_path(path)
        # Policy classes win over product ownership (RT-867): e.g. apps/*/.github/** holds
        # scripts that root CI jobs execute, so a change there needs approval like .github/**.
        policy = self._class_hit(path, self._policy)
        if policy:
            return policy
        owners = [n for n, root in self.roots.items() if path.startswith(root)]
        if len(owners) > 1:
            return Classification("ambiguous", tuple(sorted(owners)), ())
        if owners:
            return Classification("product", owners[0], self._product_tiers(owners[0], path))
        return self._class_hit(path) or Classification("unknown", None, ())

    def _product_tiers(self, product, path):
        rel = path[len(self.roots[product]):]
        tiers = [name for name, globs, excludes in self._tiers[product]
                 if any(g.match(rel) for g in globs) and not any(x.match(rel) for x in excludes)]
        if not tiers:
            return ("high",)
        if "low" in tiers and len(tiers) > 1:
            tiers.remove("low")
        return tuple(tiers)

    def shared_class(self, name):
        return self.data["shared_classes"][name]

    def expand_jobs(self, refs):
        groups = self.data.get("job_groups") or {}
        out = set()
        for ref in refs:
            out.update(groups[ref[1:]] if ref.startswith("@") else [ref])
        return out

    def tier_jobs(self, product, tier):
        prod = self.data["products"][product]
        refs = prod["high_jobs"] if tier == "high" else prod["tiers"][tier]["jobs"]
        return self.expand_jobs(refs)

    def high_risk_tiers(self, product):
        names = [t for t in self.data["products"][product]["tiers"] if t not in LOW_RISK_TIERS]
        return tuple(names) + ("high",)

    @property
    def all_jobs(self):
        return set(self.data["jobs"])
