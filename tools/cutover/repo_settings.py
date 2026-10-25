#!/usr/bin/env python3
"""RT-715 settings-as-script: copy the GitHub repository settings of Shadow to the canonical repo.

  repo_settings.py export --repo OWNER/NAME --out SNAPSHOT.json [--skip-ruleset NAME ...]
  repo_settings.py plan   --snapshot SNAPSHOT.json --target OWNER/NAME
  repo_settings.py apply  --snapshot SNAPSHOT.json --target OWNER/NAME --yes

Covers: merge settings, secret scanning and push protection, Actions permissions, rulesets (by name),
environments with their deployment branch/tag policies and required reviewers, and the NAMES of
repository and environment secrets and variables.

Never reads, writes or prints a secret or variable VALUE: values are listed as owner TODOs. GitHub App
installation (for example kemetra-ci-gate, whose integration id is referenced by required status checks)
is an owner action and is listed as a TODO. All calls go through the authenticated `gh` CLI.
`export` and `plan` only read. `apply` writes only with --yes; without it, it prints the plan.
"""
import argparse
import json
import subprocess
import sys

REPO_KEYS = ["allow_merge_commit", "allow_squash_merge", "allow_rebase_merge", "delete_branch_on_merge",
             "allow_auto_merge", "allow_update_branch", "web_commit_signoff_required"]
SECURITY_KEYS = ["secret_scanning", "secret_scanning_push_protection"]
ACTIONS_KEYS = ["enabled", "allowed_actions"]
WORKFLOW_KEYS = ["default_workflow_permissions", "can_approve_pull_request_reviews"]
RULESET_KEYS = ["name", "target", "enforcement", "conditions", "bypass_actors", "rules"]


def gh(path, method="GET", body=None, paginate=False):
    """Call the GitHub REST API through `gh api`. Returns parsed JSON (None for empty bodies)."""
    cmd = ["gh", "api", "-X", method, path, "-H", "Accept: application/vnd.github+json"]
    if paginate:
        cmd.append("--paginate")
    if body is not None:
        cmd += ["--input", "-"]
    res = subprocess.run(cmd, input=json.dumps(body) if body is not None else None,
                         capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError("gh api %s %s failed: %s" % (method, path, res.stderr.strip()))
    out = res.stdout.strip()
    if not out:
        return None
    if paginate and out.startswith("[") and "][" in out:
        out = "[" + out[1:-1].replace("][", ",") + "]"
    return json.loads(out)


def pick(d, keys):
    return {k: d[k] for k in keys if k in d}


def normalize_ruleset(rs):
    """Keep only portable fields; drop ids, node ids, timestamps and links."""
    out = pick(rs, RULESET_KEYS)
    out["rules"] = [{k: v for k, v in r.items() if k in ("type", "parameters") and v is not None}
                    for r in rs.get("rules", [])]
    return out


def export(repo, skip):
    r = gh("repos/%s" % repo)
    snap = {"source": repo, "repo": pick(r, REPO_KEYS)}
    sa = r.get("security_and_analysis") or {}
    snap["security"] = {k: sa[k]["status"] for k in SECURITY_KEYS if k in sa}
    snap["actions"] = pick(gh("repos/%s/actions/permissions" % repo), ACTIONS_KEYS)
    snap["workflow"] = pick(gh("repos/%s/actions/permissions/workflow" % repo), WORKFLOW_KEYS)
    rulesets = []
    for rs in gh("repos/%s/rulesets" % repo, paginate=True) or []:
        if rs["name"] in skip or rs.get("source_type") != "Repository":
            continue
        rulesets.append(normalize_ruleset(gh("repos/%s/rulesets/%d" % (repo, rs["id"]))))
    snap["rulesets"] = sorted(rulesets, key=lambda x: x["name"])
    envs = []
    for e in (gh("repos/%s/environments" % repo) or {}).get("environments", []):
        name = e["name"]
        env = {"name": name, "deployment_branch_policy": e.get("deployment_branch_policy"), "reviewers": [],
               "wait_timer": 0, "branch_policies": [], "secret_names": [], "variable_names": []}
        for rule in e.get("protection_rules", []):
            if rule["type"] == "required_reviewers":
                env["reviewers"] = [{"type": x["type"], "id": x["reviewer"]["id"],
                                     "login": x["reviewer"].get("login") or x["reviewer"].get("slug")}
                                    for x in rule.get("reviewers", [])]
            elif rule["type"] == "wait_timer":
                env["wait_timer"] = rule.get("wait_timer", 0)
        if (env["deployment_branch_policy"] or {}).get("custom_branch_policies"):
            bp = gh("repos/%s/environments/%s/deployment-branch-policies" % (repo, name)) or {}
            env["branch_policies"] = sorted(({"name": p["name"], "type": p.get("type", "branch")}
                                             for p in bp.get("branch_policies", [])), key=lambda p: (p["type"], p["name"]))
        env["secret_names"] = sorted(s["name"] for s in (gh("repos/%s/environments/%s/secrets" % (repo, name)) or {}).get("secrets", []))
        env["variable_names"] = sorted(v["name"] for v in (gh("repos/%s/environments/%s/variables" % (repo, name)) or {}).get("variables", []))
        envs.append(env)
    snap["environments"] = sorted(envs, key=lambda x: x["name"])
    snap["secret_names"] = sorted(s["name"] for s in (gh("repos/%s/actions/secrets" % repo) or {}).get("secrets", []))
    snap["variable_names"] = sorted(v["name"] for v in (gh("repos/%s/actions/variables" % repo) or {}).get("variables", []))
    snap["app_integration_ids"] = sorted({c["integration_id"] for rs in snap["rulesets"] for r in rs["rules"]
                                          if r["type"] == "required_status_checks"
                                          for c in r["parameters"].get("required_status_checks", [])
                                          if c.get("integration_id")})
    return snap


def plan(snap, current):
    """Pure diff of a snapshot against the target's current export. Returns a list of (action, detail)."""
    acts = []
    for k, v in snap["repo"].items():
        if current["repo"].get(k) != v:
            acts.append(("repo", "%s: %s -> %s" % (k, current["repo"].get(k), v)))
    for k, v in snap["security"].items():
        if current["security"].get(k) != v:
            acts.append(("security", "%s: %s -> %s" % (k, current["security"].get(k), v)))
    for sect in ("actions", "workflow"):
        for k, v in snap[sect].items():
            if current[sect].get(k) != v:
                acts.append((sect, "%s: %s -> %s" % (k, current[sect].get(k), v)))
    cur_rs = {r["name"]: r for r in current["rulesets"]}
    for rs in snap["rulesets"]:
        if rs["name"] not in cur_rs:
            acts.append(("ruleset-create", rs["name"]))
        elif cur_rs[rs["name"]] != rs:
            acts.append(("ruleset-update", rs["name"]))
    cur_env = {e["name"]: e for e in current["environments"]}
    for e in snap["environments"]:
        c = cur_env.get(e["name"])
        if c is None:
            acts.append(("env-create", e["name"]))
        else:
            for k in ("deployment_branch_policy", "reviewers", "wait_timer", "branch_policies"):
                if c.get(k) != e.get(k):
                    acts.append(("env-update", "%s.%s" % (e["name"], k)))
        for n in e["secret_names"]:
            if c is None or n not in c["secret_names"]:
                acts.append(("todo-owner", "set environment secret %s/%s (value by the owner)" % (e["name"], n)))
        for n in e["variable_names"]:
            if c is None or n not in c["variable_names"]:
                acts.append(("todo-owner", "set environment variable %s/%s (value by the owner)" % (e["name"], n)))
    for n in snap["secret_names"]:
        if n not in current["secret_names"]:
            acts.append(("todo-owner", "set repository secret %s (value by the owner)" % n))
    for n in snap["variable_names"]:
        if n not in current["variable_names"]:
            acts.append(("todo-owner", "set repository variable %s (value by the owner)" % n))
    for i in snap["app_integration_ids"]:
        acts.append(("todo-owner", "make sure the GitHub App with integration id %d is installed on the target "
                                   "(required status checks reference it)" % i))
    return acts


def apply(snap, target, current):
    if snap["repo"]:
        gh("repos/%s" % target, "PATCH", dict(snap["repo"]))
    if snap["security"]:
        gh("repos/%s" % target, "PATCH", {"security_and_analysis": {k: {"status": v} for k, v in snap["security"].items()}})
    if snap["actions"]:
        gh("repos/%s/actions/permissions" % target, "PUT", dict(snap["actions"]))
    if snap["workflow"]:
        gh("repos/%s/actions/permissions/workflow" % target, "PUT", dict(snap["workflow"]))
    cur_ids = {rs["name"]: rs["id"] for rs in gh("repos/%s/rulesets" % target, paginate=True) or []}
    for rs in snap["rulesets"]:
        if rs["name"] in cur_ids:
            gh("repos/%s/rulesets/%d" % (target, cur_ids[rs["name"]]), "PUT", rs)
        else:
            gh("repos/%s/rulesets" % target, "POST", rs)
    for e in snap["environments"]:
        body = {"wait_timer": e["wait_timer"], "deployment_branch_policy": e["deployment_branch_policy"],
                "reviewers": [{"type": r["type"], "id": r["id"]} for r in e["reviewers"]] or None}
        gh("repos/%s/environments/%s" % (target, e["name"]), "PUT", body)
        if (e["deployment_branch_policy"] or {}).get("custom_branch_policies"):
            have = {(p["name"], p.get("type", "branch")) for p in (gh("repos/%s/environments/%s/deployment-branch-policies"
                                                                       % (target, e["name"])) or {}).get("branch_policies", [])}
            for p in e["branch_policies"]:
                if (p["name"], p["type"]) not in have:
                    gh("repos/%s/environments/%s/deployment-branch-policies" % (target, e["name"]), "POST", p)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("export")
    ex.add_argument("--repo", required=True)
    ex.add_argument("--out", required=True)
    ex.add_argument("--skip-ruleset", action="append", default=[])
    for name in ("plan", "apply"):
        p = sub.add_parser(name)
        p.add_argument("--snapshot", required=True)
        p.add_argument("--target", required=True)
        if name == "apply":
            p.add_argument("--yes", action="store_true", help="really write; without it only the plan is printed")
    a = ap.parse_args(argv)
    if a.cmd == "export":
        snap = export(a.repo, set(a.skip_ruleset))
        with open(a.out, "w", encoding="utf-8", newline="\n") as f:
            json.dump(snap, f, indent=2, sort_keys=True)
            f.write("\n")
        print("exported %s: %d rulesets, %d environments" % (a.repo, len(snap["rulesets"]), len(snap["environments"])))
        return 0
    with open(a.snapshot, encoding="utf-8") as f:
        snap = json.load(f)
    current = export(a.target, set())
    acts = plan(snap, current)
    for kind, detail in acts:
        print("%-15s %s" % (kind, detail))
    print("%d actions (%d owner TODOs)" % (len(acts), sum(1 for k, _ in acts if k == "todo-owner")))
    if a.cmd == "apply":
        if not a.yes:
            print("dry run: nothing written (pass --yes to apply)")
            return 0
        apply(snap, a.target, current)
        left = [x for x in plan(snap, export(a.target, set())) if x[0] != "todo-owner"]
        print("applied; remaining non-TODO differences: %d" % len(left))
        for kind, detail in left:
            print("%-15s %s" % (kind, detail))
        return 1 if left else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
