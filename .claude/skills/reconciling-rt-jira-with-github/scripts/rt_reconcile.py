"""Bulk GitHub evidence for reconciling RT Jira issues with Kemetra-Labs/Retail-Tower-Erp.

Read-only: it calls `gh` (GET only) and reads files. It never writes to Jira or GitHub.

Subcommands:
  prs     List PRs (merged since a date, plus open) with their primary RT key.
  ci      For given PR numbers: head and merge SHAs, newest completed `required` run on the
          head, push runs on the merge commit, and reverts on origin/main.
  issues  Join a saved Jira search result (JSON from the Jira MCP search tool) with the
          output of `prs`: own PRs, referenced-only PRs and stale blocker links per issue.

Run with:  python -X utf8 scripts/rt_reconcile.py <subcommand> --help
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO = "Kemetra-Labs/Retail-Tower-Erp"
KEY = re.compile(r"\bRT-\d+\b")


def run(cmd: list[str]) -> str:
    """Run a command and return stdout as UTF-8 text; raise with stderr on failure."""
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if res.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed: {res.stderr.strip()[:300]}")
    return res.stdout.replace("\r\n", "\n")


def gh_json(args: list[str]) -> Any:
    return json.loads(run(["gh", *args]) or "null")


def primary_key(title: str, branch: str) -> str | None:
    """The PR belongs to the first RT key in its title, else the first in its branch."""
    keys = KEY.findall(title) or KEY.findall(branch.upper())
    return keys[0] if keys else None


def cmd_prs(a: argparse.Namespace) -> None:
    fields = "number,title,headRefName,state,mergedAt,url"
    merged = gh_json(["pr", "list", "--repo", a.repo, "--state", "merged", "--limit", str(a.limit),
                      "--search", f"merged:>={a.since}", "--json", fields])
    opened = gh_json(["pr", "list", "--repo", a.repo, "--state", "open", "--limit", "200", "--json", fields])
    out = []
    for p in merged + opened:
        refs = sorted(set(KEY.findall(p["title"]) + KEY.findall(p["headRefName"].upper())))
        own = primary_key(p["title"], p["headRefName"])
        out.append({"number": p["number"], "state": p["state"], "merged": (p.get("mergedAt") or "")[:10],
                    "own_key": own, "mentions": [k for k in refs if k != own], "title": p["title"]})
    Path(a.out).write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    unkeyed = [p["number"] for p in out if not p["own_key"] and p["state"] == "MERGED"]
    print(f"{len(out)} PRs written to {a.out}; merged PRs with no RT key: {unkeyed}")


def required_runs(repo: str, sha: str) -> list[dict[str, Any]]:
    runs = gh_json(["api", f"repos/{repo}/commits/{sha}/check-runs?check_name=required&filter=all",
                    "--jq", "[.check_runs[]|{status,conclusion,started_at}]"]) or []
    return sorted(runs, key=lambda r: r.get("started_at") or "")


def cmd_ci(a: argparse.Namespace) -> None:
    log = ""
    try:
        log = run(["git", "log", "origin/main", "--oneline", "-i", "--grep=revert"])
    except RuntimeError:
        print("note: no git clone here; revert check skipped", file=sys.stderr)
    for n in a.prs:
        d = gh_json(["pr", "view", str(n), "--repo", a.repo, "--json", "headRefOid,mergeCommit,mergedAt,state,title"])
        head = d["headRefOid"]
        merge = (d.get("mergeCommit") or {}).get("oid", "")
        runs = required_runs(a.repo, head)
        done = [r for r in runs if r["status"] == "completed"]
        newest = done[-1]["conclusion"] if done else "none completed"
        pending = sum(1 for r in runs if r["status"] != "completed")
        push = []
        if merge:
            push = gh_json(["run", "list", "--repo", a.repo, "--commit", merge, "--json",
                            "workflowName,databaseId,conclusion,event"]) or []
        push = [f"{r['workflowName']}={r['conclusion']}({r['databaseId']})" for r in push
                if r["event"] == "push" and r["workflowName"] in a.workflows]
        reverts = [ln for ln in log.splitlines() if re.search(rf"\(#{n}\)|#{n}\b", ln)
                   and "Kemetra/" not in ln]
        print(f"#{n} {d['state']} merged {(d.get('mergedAt') or '')[:10]} head {head[:9]} merge {merge[:9]}")
        print(f"   required: newest completed = {newest}; unfinished runs = {pending}")
        print(f"   push runs on merge: {', '.join(push) or 'none found'}")
        print(f"   reverts on main: {reverts or 'none'}")


def load_issues(files: list[str]) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    for f in files:
        data = json.loads(Path(f).read_text(encoding="utf-8", errors="replace"))
        nodes += data.get("issues", {}).get("nodes", [])
    return nodes


def cmd_issues(a: argparse.Namespace) -> None:
    prs = json.loads(Path(a.prs).read_text(encoding="utf-8"))
    own: dict[str, list[str]] = {}
    ment: dict[str, list[str]] = {}
    for p in prs:
        tag = f"#{p['number']}" + ("" if p["state"] == "MERGED" else f"({p['state'].lower()})")
        if p["own_key"]:
            own.setdefault(p["own_key"], []).append(tag)
        for k in p["mentions"]:
            ment.setdefault(k, []).append(tag)
    rows = []
    for n in load_issues(a.jira_file):
        f = n["fields"]
        wm = f.get("customfield_10135")
        stale = [l["inwardIssue"]["key"] for l in f.get("issuelinks") or []
                 if l.get("type", {}).get("name") == "Blocks" and "inwardIssue" in l
                 and l["inwardIssue"]["fields"]["status"]["statusCategory"]["key"] == "done"]
        rows.append({"key": n["key"], "status": f["status"]["name"],
                     "work_mode": wm.get("value") if isinstance(wm, dict) else wm,
                     "own_prs": own.get(n["key"], []), "mentioned_in": ment.get(n["key"], []),
                     "stale_blockers": stale, "summary": f.get("summary", "")[:80]})
    rows.sort(key=lambda r: int(r["key"].split("-")[1]))
    if a.out:
        Path(a.out).write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    for r in rows:
        if r["own_prs"] or r["stale_blockers"] or a.all:
            print(f"{r['key']} [{r['status']}/{r['work_mode']}] own={r['own_prs']} "
                  f"mentioned={r['mentioned_in'][:5]} stale_blockers={r['stale_blockers']} | {r['summary']}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=REPO)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prs", help="list PRs with their primary RT key")
    p.add_argument("--since", required=True, help="YYYY-MM-DD, e.g. 2026-10-25 (the cutover)")
    p.add_argument("--limit", type=int, default=1000)
    p.add_argument("--out", default="prs.json")
    p.set_defaults(fn=cmd_prs)
    c = sub.add_parser("ci", help="CI and revert evidence for PR numbers")
    c.add_argument("prs", nargs="+", type=int)
    c.add_argument("--workflows", nargs="*", default=["pos", "backend-core", "admin-console",
                                                     "erpnext-connector", "contracts", "e2e"])
    c.set_defaults(fn=cmd_ci)
    i = sub.add_parser("issues", help="join a saved Jira search with prs.json")
    i.add_argument("--jira-file", nargs="+", required=True, help="saved Jira search JSON file(s)")
    i.add_argument("--prs", default="prs.json")
    i.add_argument("--out")
    i.add_argument("--all", action="store_true", help="print every issue, not only ones with PRs or stale links")
    i.set_defaults(fn=cmd_issues)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
