#!/usr/bin/env python3
"""Fail-closed lockfile diff audit behind the graph job `dependency-review` (RT-850).

Scans every lockfile in the head checkout and the same lockfiles in the base checkout with
osv-scanner, then fails on any (lockfile, ecosystem, package, version, advisory id) that
exists in head and not in base. Stdlib only. Exit codes: 0 pass, 1 new findings, 2 the audit
could not prove a result (scanner error, missing or empty required lockfile, bad input).
Every unclear situation is exit 2: this job must never pass because something was skipped.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__"}
LOCKFILE_NAMES = {
    "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock",
    "poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock", "Cargo.lock", "go.sum",
}
LOCKFILE_RE = re.compile(r"^(pylock(\.[^/]+)?\.toml|requirements[^/]*\.txt)$")
CONFIG_NAMES = {"osv-scanner.toml", ".osv-scanner.toml"}  # per-directory ignore lists
SCANNER_OK = (0, 1)  # 0 clean, 1 vulnerabilities found; 127 error and 128 no packages fail


class AuditError(Exception):
    """The audit cannot prove a result (always a failing exit)."""


def discover(root, skip=()):
    """Repo-relative lockfile paths under `root`, never descending into `skip` (the base
    checkout lives inside the head workspace, and its lockfiles are not head lockfiles)."""
    skipped = {os.path.abspath(s) for s in skip}
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames
                             if d not in SKIP_DIRS and os.path.abspath(os.path.join(dirpath, d)) not in skipped)
        for name in sorted(filenames):
            if name in LOCKFILE_NAMES or LOCKFILE_RE.match(name):
                rel = os.path.relpath(os.path.join(dirpath, name), root)
                found.append(rel.replace(os.sep, "/"))
    return sorted(found)


def find_ignore_configs(root, skip=()):
    """Any osv-scanner ignore config in the tree. Forbidden: this job has no ignore mechanism."""
    skipped = {os.path.abspath(s) for s in skip}
    hits = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames
                       if d not in SKIP_DIRS and os.path.abspath(os.path.join(dirpath, d)) not in skipped]
        hits += [os.path.relpath(os.path.join(dirpath, n), root).replace(os.sep, "/")
                 for n in filenames if n in CONFIG_NAMES]
    return sorted(hits)


def run_scanner(osv, root, lockfiles):
    """Run osv-scanner in `root` over `lockfiles`; return the parsed JSON report."""
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "osv.json")
        # A fixed empty config outside the checkout: stops osv-scanner from reading any
        # osv-scanner.toml in the scanned tree, whose [[IgnoredVulns]] would hide advisories.
        cfg = os.path.join(tmp, "empty-osv-scanner.toml")
        open(cfg, "w", encoding="utf-8").close()
        cmd = [*osv, "scan", "source", "--config", cfg, "--format", "json", "--all-packages",
               "--output-file", out]
        for lock in lockfiles:
            cmd += ["-L", lock]
        proc = subprocess.run(cmd, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        sys.stdout.write(proc.stdout)
        if proc.returncode not in SCANNER_OK:
            raise AuditError(f"osv-scanner exited {proc.returncode} in {root} (only 0 and 1 are results)")
        try:
            with open(out, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError) as exc:
            raise AuditError(f"osv-scanner wrote no readable JSON report in {root}: {exc}")


def summarize(report, root):
    """-> (packages per lockfile, set of findings). A finding is
    (lockfile, ecosystem, name, version, advisory id)."""
    counts, findings = {}, set()
    for result in report.get("results") or []:
        path = os.path.relpath(os.path.abspath(os.path.join(root, result["source"]["path"])), root)
        path = path.replace(os.sep, "/")
        for entry in result.get("packages") or []:
            pkg = entry["package"]
            counts[path] = counts.get(path, 0) + 1
            for vuln in entry.get("vulnerabilities") or []:
                findings.add((path, pkg["ecosystem"], pkg["name"], pkg["version"], vuln["id"]))
    return counts, findings


def check_head(counts, lockfiles, required):
    missing = [r for r in required if r not in lockfiles]
    if missing:
        raise AuditError(f"required lockfile(s) not in the checkout: {', '.join(missing)}")
    empty = [r for r in required if counts.get(r, 0) == 0]
    if empty:
        raise AuditError(f"required lockfile(s) scanned with 0 packages (unparsed?): {', '.join(empty)}")


def write_summary(path, head_counts, head_findings, base_findings, new):
    lines = ["## dependency-review", "", "| lockfile | packages | findings (head) | findings (base) | new |",
             "| --- | ---: | ---: | ---: | ---: |"]
    for lock in sorted(head_counts):
        row = [sum(1 for f in s if f[0] == lock) for s in (head_findings, base_findings, new)]
        lines.append(f"| `{lock}` | {head_counts[lock]} | {row[0]} | {row[1]} | {row[2]} |")
    lines.append("")
    if new:
        lines += ["### New findings (fail)", ""]
        lines += [f"- `{f[0]}`: {f[2]}@{f[3]} ({f[1]}) [{f[4]}](https://osv.dev/{f[4]})" for f in sorted(new)]
    else:
        lines.append("No new advisories compared with the base.")
    text = "\n".join(lines) + "\n"
    sys.stdout.write(text)
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(text)


def audit(osv, head_root, base_root, required, summary_path):
    configs = find_ignore_configs(head_root, skip=[base_root])
    if configs:
        raise AuditError(f"osv-scanner ignore config is not allowed (no ignore mechanism): {', '.join(configs)}")
    lockfiles = discover(head_root, skip=[base_root])
    if not lockfiles:
        raise AuditError("no lockfile found in the checkout")
    head_counts, head_findings = summarize(run_scanner(osv, head_root, lockfiles), head_root)
    check_head(head_counts, lockfiles, required)
    in_base = [lock for lock in lockfiles if os.path.isfile(os.path.join(base_root, lock))]
    base_findings = set()
    if in_base:
        _, base_findings = summarize(run_scanner(osv, base_root, in_base), base_root)
    new = head_findings - base_findings
    write_summary(summary_path, head_counts, head_findings, base_findings, new)
    return 1 if new else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--osv", action="append", required=True,
                    help="osv-scanner command; repeat to give an interpreter plus a script (tests)")
    ap.add_argument("--head", default=".", help="head checkout root")
    ap.add_argument("--base", required=True, help="base checkout root")
    ap.add_argument("--require", action="append", default=[], help="repo-relative lockfile that must be scanned")
    ap.add_argument("--summary", default=os.environ.get("GITHUB_STEP_SUMMARY"), help="markdown summary file")
    args = ap.parse_args(argv)
    if not args.require:
        print("dependency-review: no --require given; refusing to run unanchored", file=sys.stderr)
        return 2
    try:
        return audit(args.osv, os.path.abspath(args.head), os.path.abspath(args.base), args.require, args.summary)
    except AuditError as exc:
        print(f"dependency-review: FAIL (cannot prove a result): {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
