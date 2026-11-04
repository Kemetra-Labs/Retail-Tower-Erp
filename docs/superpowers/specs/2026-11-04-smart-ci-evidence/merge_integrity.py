#!/usr/bin/env python3
"""Was each merged PR green before it merged? (RT-866 / smart CI Phase 0.)

For every merged PR, reads the `required` check-runs on its final head and
classifies the merge:
  GREEN_BEFORE_MERGE   the latest `required` completed before the merge was `success`
  RED_AT_MERGE         the latest `required` completed before the merge was not `success`
  MERGED_BEFORE_GREEN  `required` existed but none had completed when the PR merged
  NO_REQUIRED          no `required` check-run was ever posted on the head

Read-only: uses `gh` for the PR list and check-runs. ASCII output.

usage: merge_integrity.py --repo OWNER/NAME --merged-since 2026-11-04T00:00:00Z [--limit 50]
"""
import argparse
import datetime as dt
import json
import subprocess
import time

CAIRO = dt.timezone(dt.timedelta(hours=2))  # winter time (EET) from 2026-10-30


def _ts(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def classify_merge(merged_at, required_runs):
    if not required_runs:
        return "NO_REQUIRED"
    merged = _ts(merged_at)
    done = [r for r in required_runs if r.get("completed_at") and _ts(r["completed_at"]) <= merged]
    if not done:
        return "MERGED_BEFORE_GREEN"
    latest = max(done, key=lambda r: _ts(r["completed_at"]))
    return "GREEN_BEFORE_MERGE" if latest.get("conclusion") == "success" else "RED_AT_MERGE"


def _gh(args, attempts=3):
    # GitHub answers 5xx now and then (seen 2026-11-04); retry, then fail loudly with gh's stderr.
    for i in range(attempts):
        proc = subprocess.run(["gh", *args], capture_output=True, text=True)
        if proc.returncode == 0:
            return json.loads(proc.stdout)
        if i < attempts - 1:
            time.sleep(2 * (i + 1))
    raise SystemExit(f"gh {' '.join(args[:2])} failed: {proc.stderr.strip()}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--repo", required=True)
    p.add_argument("--merged-since", required=True, help="ISO-8601 UTC, e.g. 2026-11-04T00:00:00Z")
    p.add_argument("--limit", type=int, default=50)
    a = p.parse_args()
    prs = _gh(["pr", "list", "--repo", a.repo, "--state", "merged", "--limit", str(a.limit),
               "--search", f"merged:>={a.merged_since}", "--json", "number,headRefOid,mergedAt"])
    green = 0
    for pr in sorted(prs, key=lambda x: x["mergedAt"]):
        runs = _gh(["api", f"repos/{a.repo}/commits/{pr['headRefOid']}/check-runs?check_name=required&filter=all",
                    "--jq", ".check_runs"])
        cls = classify_merge(pr["mergedAt"], runs)
        green += cls == "GREEN_BEFORE_MERGE"
        cairo = _ts(pr["mergedAt"]).astimezone(CAIRO).strftime("%Y-%m-%d %H:%M")
        print(f"#{pr['number']} {cls} merged={cairo} Cairo head={pr['headRefOid'][:8]}")
    print(f"green_before_merge={green}/{len(prs)}")


if __name__ == "__main__":
    main()
