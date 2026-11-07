"""Bulk GitHub evidence for reconciling RT Jira issues with Kemetra-Labs/Retail-Tower-Erp.

Never writes to Jira or GitHub: it calls `gh` with GET requests only and runs `git log`.
The only file it writes is the `prs` output (default: the system temp directory).

Subcommands:
  prs     List PRs (merged since a date, plus open) with their primary RT key.
  ci      For given PR numbers: head and merge SHAs, the newest `required` run on the head,
          push runs on the merge commit, and reverts on origin/main.
  issues  Join a saved Jira search result (JSON from the Jira MCP search tool, shape
          {"issues": {"nodes": [...]}}) with the output of `prs`: own PRs, mentions and
          stale blocker links per issue.

Run with:  python -X utf8 scripts/rt_reconcile.py <subcommand> --help
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

REPO = "Kemetra-Labs/Retail-Tower-Erp"
KEY = re.compile(r"\bRT-\d+\b")
DEFAULT_PRS = str(Path(tempfile.gettempdir()) / "rt_reconcile_prs.json")


def run(cmd: list[str]) -> str:
    """Run a command and return stdout as UTF-8 text; raise RuntimeError on any failure."""
    try:
        res = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace"
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"{cmd[0]} is not installed or not on PATH") from exc
    if res.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed: {res.stderr.strip()[:300]}")
    return res.stdout.replace("\r\n", "\n")


def gh_json(args: list[str]) -> Any:
    """Run `gh` with the given arguments and parse its stdout as JSON (None when empty)."""
    return json.loads(run(["gh", *args]) or "null")


def warn(msg: str) -> None:
    """Print a warning to stderr so it never mixes with the evidence on stdout."""
    print(f"warning: {msg}", file=sys.stderr)


def primary_key(title: str, branch: str) -> str | None:
    """The PR belongs to the first RT key in its title, else the first in its branch."""
    keys = KEY.findall(title) or KEY.findall(branch.upper())
    return keys[0] if keys else None


def cmd_prs(a: argparse.Namespace) -> None:
    """Write merged (since --since) and open PRs with their primary RT key to --out."""
    fields = "number,title,headRefName,state,mergedAt,url"
    merged = (
        gh_json(
            [
                "pr",
                "list",
                "--repo",
                a.repo,
                "--state",
                "merged",
                "--limit",
                str(a.limit),
                "--search",
                f"merged:>={a.since}",
                "--json",
                fields,
            ]
        )
        or []
    )
    opened = (
        gh_json(
            [
                "pr",
                "list",
                "--repo",
                a.repo,
                "--state",
                "open",
                "--limit",
                str(a.limit),
                "--json",
                fields,
            ]
        )
        or []
    )
    for name, got in (("merged", merged), ("open", opened)):
        if len(got) >= a.limit:
            warn(
                f"{name} PR list hit --limit {a.limit}; results are truncated, raise --limit"
            )
    out = []
    for p in merged + opened:
        refs = sorted(
            set(KEY.findall(p["title"]) + KEY.findall(p["headRefName"].upper()))
        )
        own = primary_key(p["title"], p["headRefName"])
        out.append(
            {
                "number": p["number"],
                "state": p["state"],
                "merged": (p.get("mergedAt") or "")[:10],
                "own_key": own,
                "mentions": [k for k in refs if k != own],
                "is_revert": p["title"].lower().startswith("revert"),
                "title": p["title"],
            }
        )
    Path(a.out).write_text(
        json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8"
    )
    unkeyed = [p["number"] for p in out if not p["own_key"] and p["state"] == "MERGED"]
    reverts = [p["number"] for p in out if p["is_revert"]]
    print(f"{len(out)} PRs written to {a.out}")
    print(
        f"merged PRs with no RT key: {unkeyed}; revert PRs (not counted as work): {reverts}"
    )


def required_summary(repo: str, sha: str) -> str:
    """Apply CLAUDE.md 11.6: judge the newest run by started_at, and say what is unfinished."""
    runs = (
        gh_json(
            [
                "api",
                f"repos/{repo}/commits/{sha}/check-runs?check_name=required&filter=all",
                "--jq",
                "[.check_runs[]|{status,conclusion,started_at}]",
            ]
        )
        or []
    )
    if not runs:
        return "no required run on this head"
    runs.sort(key=lambda r: r.get("started_at") or "")
    newest = runs[-1]
    done = [r for r in runs if r["status"] == "completed"]
    if newest["status"] == "completed":
        older_pending = sum(1 for r in runs if r["status"] != "completed")
        return f"newest = completed/{newest['conclusion']}; older unfinished runs = {older_pending}"
    last_done = f"completed/{done[-1]['conclusion']}" if done else "none completed"
    return f"newest = {newest['status']} (started after the last completed run: {last_done})"


def revert_lines(pr: int, shas: list[str]) -> tuple[list[str], str]:
    """Commits on origin/main that revert the PR, matched two ways.

    A commit counts when its body says "This reverts commit <sha>" for the merge SHA or any
    PR commit, whatever its subject (this repo also writes `revert(scope): ...` subjects),
    or when its subject starts with 'Revert "' and names #<pr>. A manual revert that uses
    neither form is not detectable here, so the scope line says what was searched.
    """
    try:
        base = run(["git", "rev-parse", "--short", "origin/main"]).strip()
        log = run(["git", "log", "origin/main", "--format=%H%x00%s%x00%b%x1e"])
    except RuntimeError as exc:
        warn(f"revert check skipped: {exc}")
        return [], "not checked"
    targets = {s.lower() for s in shas if s}
    hits = []
    for rec in log.split("\x1e"):
        parts = rec.strip("\n").split("\x00")
        if len(parts) < 3 or parts[0].lower() in targets:
            continue
        sha, subject, body = parts[0], parts[1], parts[2]
        reverted = {
            m.lower() for m in re.findall(r"reverts commit ([0-9a-f]{7,40})", body)
        }
        by_body = any(
            t.startswith(r) or r.startswith(t) for r in reverted for t in targets
        )
        by_subject = subject.startswith('Revert "') and re.search(rf"#{pr}\b", subject)
        if by_body or by_subject:
            hits.append(f"{sha[:9]} {subject}")
    scope = (
        f"origin/main {base}; searched 'Revert \"' subjects naming #{pr} and "
        f"'This reverts commit' bodies (any subject) for {len(targets)} SHAs "
        "(merge + PR commits); "
        "run `git fetch origin` first if it may be stale"
    )
    return hits, scope


def cmd_ci(a: argparse.Namespace) -> None:
    """Print head/merge SHAs, newest `required`, push runs and reverts for each PR."""
    for n in a.prs:
        d = gh_json(
            [
                "pr",
                "view",
                str(n),
                "--repo",
                a.repo,
                "--json",
                "headRefOid,mergeCommit,mergedAt,state,title,commits",
            ]
        )
        head = d["headRefOid"]
        merge = (d.get("mergeCommit") or {}).get("oid", "")
        push = []
        if merge:
            # Ask for push events only, with a high limit: a merge commit also collects many
            # gate `workflow_run` entries, and the default limit (20) can hide the push runs.
            push = (
                gh_json(
                    [
                        "run",
                        "list",
                        "--repo",
                        a.repo,
                        "--commit",
                        merge,
                        "--event",
                        "push",
                        "--limit",
                        "100",
                        "--json",
                        "workflowName,databaseId,conclusion",
                    ]
                )
                or []
            )
        push = [
            f"{r['workflowName']}={r['conclusion']}({r['databaseId']})"
            for r in push
            if r["workflowName"] in a.workflows
        ]
        pr_shas = [c.get("oid", "") for c in d.get("commits") or []]
        hits, checked = revert_lines(n, [merge, *pr_shas])
        print(
            f"#{n} {d['state']} merged {(d.get('mergedAt') or '')[:10]} head {head[:9]} merge {merge[:9]}"
        )
        print(f"   required: {required_summary(a.repo, head)}")
        print(f"   push runs on merge: {', '.join(push) or 'none found'}")
        print(f"   reverts: {hits or 'none'} [{checked}]")


def load_issues(files: list[str]) -> list[dict[str, Any]]:
    """Read saved Jira search results; skip files that lack {"issues": {"nodes": [...]}}."""
    nodes: list[dict[str, Any]] = []
    for f in files:
        data = json.loads(Path(f).read_text(encoding="utf-8", errors="replace"))
        issues = data.get("issues") if isinstance(data, dict) else None
        got = issues.get("nodes") if isinstance(issues, dict) else None
        if not isinstance(got, list):
            warn(f"{f}: expected {{'issues': {{'nodes': [...]}}}}; skipped")
            continue
        nodes += got
    if not nodes:
        warn("no issues loaded")
    return nodes


def cmd_issues(a: argparse.Namespace) -> None:
    """Join Jira issues with the `prs` output: own PRs, mentions and stale blocker links."""
    prs = json.loads(Path(a.prs).read_text(encoding="utf-8"))
    own: dict[str, list[str]] = {}
    ment: dict[str, list[str]] = {}
    for p in prs:
        if p.get("is_revert"):
            continue
        tag = f"#{p['number']}" + (
            "" if p["state"] == "MERGED" else f"({p['state'].lower()})"
        )
        if p["own_key"]:
            own.setdefault(p["own_key"], []).append(tag)
        for k in p["mentions"]:
            ment.setdefault(k, []).append(tag)
    rows = []
    for n in load_issues(a.jira_file):
        f = n["fields"]
        wm = f.get("customfield_10135")
        stale = [
            link["inwardIssue"]["key"]
            for link in f.get("issuelinks") or []
            if link.get("type", {}).get("name") == "Blocks"
            and "inwardIssue" in link
            and link["inwardIssue"]["fields"]["status"]["statusCategory"]["key"]
            == "done"
        ]
        rows.append(
            {
                "key": n["key"],
                "status": f["status"]["name"],
                "work_mode": wm.get("value") if isinstance(wm, dict) else wm,
                "own_prs": own.get(n["key"], []),
                "mentioned_in": ment.get(n["key"], []),
                "stale_blockers": stale,
                "summary": f.get("summary", "")[:80],
            }
        )
    rows.sort(key=lambda r: int(r["key"].split("-")[1]))
    if a.out:
        Path(a.out).write_text(
            json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8"
        )
    for r in rows:
        if r["own_prs"] or r["stale_blockers"] or a.all:
            print(
                f"{r['key']} [{r['status']}/{r['work_mode']}] own={r['own_prs']} "
                f"mentioned={r['mentioned_in'][:5]} stale_blockers={r['stale_blockers']} | {r['summary']}"
            )


def main() -> None:
    """Parse arguments, run the chosen subcommand, and exit non-zero on a command failure."""
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--repo", default=REPO)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prs", help="list PRs with their primary RT key")
    p.add_argument(
        "--since", required=True, help="YYYY-MM-DD, e.g. 2026-10-25 (the cutover)"
    )
    p.add_argument("--limit", type=int, default=1000)
    p.add_argument(
        "--out", default=DEFAULT_PRS, help=f"output file (default {DEFAULT_PRS})"
    )
    p.set_defaults(fn=cmd_prs)
    c = sub.add_parser("ci", help="CI and revert evidence for PR numbers")
    c.add_argument("prs", nargs="+", type=int)
    c.add_argument(
        "--workflows",
        nargs="*",
        default=[
            "pos",
            "backend-core",
            "admin-console",
            "erpnext-connector",
            "contracts",
            "e2e",
        ],
    )
    c.set_defaults(fn=cmd_ci)
    i = sub.add_parser("issues", help="join a saved Jira search with the prs output")
    i.add_argument(
        "--jira-file", nargs="+", required=True, help="saved Jira search JSON file(s)"
    )
    i.add_argument("--prs", default=DEFAULT_PRS)
    i.add_argument("--out")
    i.add_argument(
        "--all",
        action="store_true",
        help="print every issue, not only ones with PRs or stale links",
    )
    i.set_defaults(fn=cmd_issues)
    a = ap.parse_args()
    try:
        a.fn(a)
    except RuntimeError as exc:
        sys.exit(f"error: {exc}")


if __name__ == "__main__":
    main()
