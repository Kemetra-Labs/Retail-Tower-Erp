#!/usr/bin/env python3
"""Offline compatibility gate for one system release manifest (RT-1030, plan RT-1029).

A system release manifest (system/releases/<system>.json) names the product releases that make
up one lab system version: a Backend-Core release, an Admin Console release, the ERPNext image
and its commit (the Connector has no vX.Y.Z tags yet), and the POS build the terminals run.
This gate proves from git objects alone that they fit together:

  G1  the manifest has exactly the known keys, each value matches its pattern, and the file is
      named after its `system`;
  G2  each release tag resolves to a commit, and every commit is on --main;
  G3  the Admin Console release's contracts/backend-core/PIN `commit:` is the Backend-Core
      release commit (the RT-1007 pin rule, C7-D2);
  G5  the POS build is in `supported:` of the Backend-Core release's pos-supported.yaml.

G4 (each consumer PIN against the Backend-Core contract under `oasdiff breaking`) runs in
tools/contracts-check; `--contracts-args` prints its revision arguments. The checks that need the
GitHub API (release immutability, attestations, the compat check run, the ERP image attestation,
the aws-lab reviewer) belong to the deploy workflow preflight (RT-1031).

Stdlib only, reads git objects only (never the working tree), fails closed: anything it cannot
read is a failure. Exit 0 = every rule passed, 1 = a rule failed, 2 = usage error.
"""
import argparse
import json
import pathlib
import re
import subprocess
import sys

SCHEMA = "retail-tower/system-release@1"
CONSOLE_PIN = "apps/admin-console/contracts/backend-core/PIN"
POS_SUPPORTED = "services/backend-core/contracts-compat/pos-supported.yaml"
SHA = re.compile(r"^[0-9a-f]{40}$")
FIELDS = {
    "schema": None,
    "system": re.compile(r"^lab-[0-9]{4}\.[0-9]{2}\.[0-9]+$"),
    "backendCore": {"release": re.compile(r"^backend-core/v[0-9]+\.[0-9]+\.[0-9]+$")},
    "adminConsole": {"release": re.compile(r"^admin-console/v[0-9]+\.[0-9]+\.[0-9]+$")},
    "erpnext": {"image": re.compile(r"^ghcr\.io/kemetra-labs/rt-erpnext@sha256:[0-9a-f]{64}$"), "sha": SHA},
    "pos": {"build": SHA},
}


def git(repo, *args):
    proc = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=False)
    return proc.returncode, proc.stdout.strip()


def resolve(repo, ref):
    """The commit a tag or SHA names, or None."""
    code, out = git(repo, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}")
    return out if code == 0 and SHA.match(out) else None


def show(repo, commit, path):
    code, out = git(repo, "show", f"{commit}:{path}")
    return out if code == 0 else None


def check_shape(data, name):
    """G1: why the manifest is malformed, or None."""
    if not isinstance(data, dict) or set(data) != set(FIELDS):
        return f"top-level keys must be exactly {sorted(FIELDS)}"
    if data["schema"] != SCHEMA:
        return f"schema must be {SCHEMA!r}"
    if not isinstance(data["system"], str) or not FIELDS["system"].fullmatch(data["system"]):
        return "system must look like lab-YYYY.MM.N"
    if name != f"{data['system']}.json":
        return f"file {name} must be named {data['system']}.json"
    for key, fields in FIELDS.items():
        if not isinstance(fields, dict):
            continue
        value = data[key]
        if not isinstance(value, dict) or set(value) != set(fields):
            return f"{key} keys must be exactly {sorted(fields)}"
        for field, pattern in fields.items():
            if not isinstance(value[field], str) or not pattern.fullmatch(value[field]):
                return f"{key}.{field} {value[field]!r} does not match {pattern.pattern}"
    return None


def supported_builds(text):
    """build_id values under the top-level `supported:` list of pos-supported.yaml."""
    builds, inside = set(), False
    for line in text.splitlines():
        if line and not line[0].isspace() and not line.startswith("#"):
            inside = line.rstrip() == "supported:"
            continue
        match = re.match(r"^\s*(?:-\s+)?build_id:\s*([0-9a-f]{40})\s*$", line)
        if inside and match:
            builds.add(match.group(1))
    return builds


def pin_commit(text):
    commits = [m.group(1) for m in re.finditer(r"^commit:\s*(\S+)\s*$", text, re.M)]
    return commits[0] if len(commits) == 1 else None


def commits_of(repo, data):
    return {
        "backend": resolve(repo, f"refs/tags/{data['backendCore']['release']}"),
        "console": resolve(repo, f"refs/tags/{data['adminConsole']['release']}"),
        "erpnext": resolve(repo, data["erpnext"]["sha"]),
    }


def evaluate(repo, manifest_path, main_ref):
    """[(rule, ok, detail)] in rule order. A G1 failure stops before the git rules."""
    path = pathlib.Path(manifest_path)
    data = json.loads(path.read_text(encoding="utf-8"))
    problem = check_shape(data, path.name)
    if problem:
        return [("G1", False, problem)]
    results = [("G1", True, f"{data['system']} is well formed")]

    commits = commits_of(repo, data)
    main = resolve(repo, main_ref)
    missing = [k for k, v in commits.items() if v is None]
    off_main = [k for k, v in commits.items()
                if v is not None and (main is None or git(repo, "merge-base", "--is-ancestor", v, main)[0] != 0)]
    if main is None:
        results.append(("G2", False, f"cannot resolve {main_ref}"))
    elif missing or off_main:
        results.append(("G2", False, f"unresolved: {missing or 'none'}; not on {main_ref}: {off_main or 'none'}"))
    else:
        results.append(("G2", True, f"every release resolves and is on {main_ref}"))

    backend, console = commits["backend"], commits["console"]
    pin = show(repo, console, CONSOLE_PIN) if console else None
    pinned = pin_commit(pin) if pin is not None else None
    if backend is None or pinned is None:
        results.append(("G3", False, f"cannot read the Console PIN commit or the Backend-Core commit"))
    elif pinned != backend:
        results.append(("G3", False, f"Console PIN names {pinned}, Backend-Core release is {backend}"))
    else:
        results.append(("G3", True, f"Console PIN names the Backend-Core release {backend}"))

    baseline = show(repo, backend, POS_SUPPORTED) if backend else None
    build = data["pos"]["build"]
    if baseline is None:
        results.append(("G5", False, f"cannot read {POS_SUPPORTED} at the Backend-Core release"))
    elif build not in supported_builds(baseline):
        results.append(("G5", False, f"POS build {build} is not supported by the Backend-Core release"))
    else:
        results.append(("G5", True, f"POS build {build} is supported by the Backend-Core release"))
    return results


def contracts_args(repo, data):
    """tools/contracts-check arguments for G4: each consumer PIN at its release, against the
    Backend-Core contract at its release. POS is covered by G5 (contracts-compat, MR-3): its
    build predates the monorepo, so its PIN is not a commit of this repository."""
    commits = commits_of(repo, data)
    if None in commits.values():
        raise ValueError("a release does not resolve; run the gate first")
    return ["--backend-rev", commits["backend"],
            "--consumer-rev", f"Admin-Console={commits['console']}",
            "--consumer-rev", f"ERPNext-Connector={commits['erpnext']}"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", default=".")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--main", default="origin/main", help="ref every release must be on")
    parser.add_argument("--contracts-args", action="store_true",
                        help="print the contracts-check G4 arguments, one per line, instead of gating")
    args = parser.parse_args(argv)
    try:
        if args.contracts_args:
            data = json.loads(pathlib.Path(args.manifest).read_text(encoding="utf-8"))
            print("\n".join(contracts_args(args.repo, data)))
            return 0
        results = evaluate(args.repo, args.manifest, args.main)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"system-gate: {args.manifest}: {exc}", file=sys.stderr)
        return 2
    for rule, ok, detail in results:
        print(f"{rule} {'pass' if ok else 'FAIL'}: {detail}")
    return 0 if all(ok for _, ok, _ in results) else 1


if __name__ == "__main__":
    sys.exit(main())
