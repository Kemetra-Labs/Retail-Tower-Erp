#!/usr/bin/env python3
"""One version per shared npm library across the products (RT-924).

  shared_deps.py check --repo PATH [--policy tools/versions/shared-deps.yaml] [--mode report|enforce]
                                  exit 0 clean, or findings in report mode; 1 findings in enforce
                                  mode; 2 unreadable input (a broken policy fails in both modes)

tools/versions/shared-deps.yaml lists each library two or more products declare and the one
version every package.json must declare (the plain version: `^1.2.3`, `~1.2.3` and `1.2.3` are all
1.2.3). Findings:

  (drift)    a package.json declares a listed library at another version, or at something that is
             not a plain version (a range, a tag, an alias)
  (unlisted) a library that is not listed is declared at different versions by two or more products
  (policy)   a listed library is declared nowhere, or an exception matches no declaration

`dependencies`, `devDependencies` and `optionalDependencies` count; `peerDependencies` (a range by
design) and local packages (`workspace:`, `file:`, `link:`, `portal:`) do not. A product is the first
two path segments under apps/, services/ and integrations/ (apps/admin-console/cloud-e2e belongs to
apps/admin-console).

Report mode prints each finding as a warning and passes: it is the rollout mode while the products
are aligned. Enforce mode prints errors and fails. Stdlib plus PyYAML (hash-pinned in
tools/project-graph/requirements.txt, which boundary-check installs first).
"""
import argparse
import json
import os
import re
import sys

import yaml

from toolchain_versions import InputError, read, rel, walk

SECTIONS = ("dependencies", "devDependencies", "optionalDependencies")
LOCAL_PREFIXES = ("workspace:", "file:", "link:", "portal:")
PRODUCT_ROOTS = {"apps", "services", "integrations"}
PLAIN_VERSION_RE = re.compile(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?")
SPEC_RE = re.compile(r"^[\^~=v\s]*(" + PLAIN_VERSION_RE.pattern + r")\s*$")
DEFAULT_POLICY = "tools/versions/shared-deps.yaml"
EXCEPTION_KEYS = ("library", "path", "reason", "ticket")


def product_of(path):
    parts = path.split("/")
    return "/".join(parts[:2]) if parts[0] in PRODUCT_ROOTS and len(parts) > 2 else parts[0]


def plain_version(spec):
    match = SPEC_RE.match(spec)
    return match.group(1) if match else None


def load_policy(repo, policy_path):
    full = os.path.join(repo, policy_path)
    try:
        data = yaml.safe_load(read(full))
    except yaml.YAMLError as exc:
        raise InputError(f"{policy_path}: {exc}") from exc
    if not isinstance(data, dict) or data.get("version") != 1:
        raise InputError(f"{policy_path}: expected a mapping with `version: 1`")
    libraries = data.get("libraries")
    if not isinstance(libraries, dict) or not libraries:
        raise InputError(f"{policy_path}: `libraries` must be a non-empty mapping")
    for name, version in libraries.items():
        if not isinstance(version, str) or not PLAIN_VERSION_RE.fullmatch(version):
            raise InputError(f"{policy_path}: {name}: {version!r} is not a plain version such as 1.2.3 (quote it)")
    exceptions = data.get("exceptions") or []
    if not isinstance(exceptions, list):
        raise InputError(f"{policy_path}: `exceptions` must be a list")
    for entry in exceptions:
        if not isinstance(entry, dict) or any(not isinstance(entry.get(k), str) or not entry[k] for k in EXCEPTION_KEYS):
            raise InputError(f"{policy_path}: every exception needs non-empty {', '.join(EXCEPTION_KEYS)}")
        if entry["library"] not in libraries:
            raise InputError(f"{policy_path}: exception for {entry['library']} which is not a listed library")
    return libraries, exceptions


def declarations(repo, files):
    found = []
    for path in files:
        if os.path.basename(path) != "package.json":
            continue
        name = rel(repo, path)
        try:
            pkg = json.loads(read(path))
        except json.JSONDecodeError as exc:
            raise InputError(f"{name}: {exc}") from exc
        for section in SECTIONS:
            for lib, spec in (pkg.get(section) or {}).items():
                if isinstance(spec, str) and not spec.startswith(LOCAL_PREFIXES):
                    found.append({"path": name, "product": product_of(name), "lib": lib, "spec": spec,
                                  "version": plain_version(spec)})
    return found


def check(repo, policy_path=DEFAULT_POLICY):
    libraries, exceptions = load_policy(repo, policy_path)
    decls = declarations(repo, list(walk(repo)))
    findings, used = [], set()
    for decl in decls:
        want = libraries.get(decl["lib"])
        if want is None or decl["version"] == want:
            continue
        index = next((i for i, e in enumerate(exceptions)
                      if e["library"] == decl["lib"] and decl["path"].startswith(e["path"])), None)
        if index is not None:
            used.add(index)
            continue
        have = decl["version"] or f"{decl['spec']!r} (not a plain version)"
        findings.append(f"(drift) {decl['path']}: {decl['lib']} is {have}, policy {want}")
    declared = {d["lib"] for d in decls}
    for lib in sorted(set(libraries) - declared):
        findings.append(f"(policy) {lib} is listed but no package.json declares it")
    for index, entry in enumerate(exceptions):
        if index not in used:
            findings.append(f"(policy) exception for {entry['library']} at {entry['path']} matches no declaration")
    seen = {}
    for decl in decls:
        if decl["lib"] not in libraries:
            seen.setdefault(decl["lib"], {}).setdefault(decl["product"], set()).add(decl["version"] or decl["spec"])
    for lib in sorted(seen):
        by_product = seen[lib]
        if len(by_product) >= 2 and len({v for vs in by_product.values() for v in vs}) >= 2:
            where = "; ".join(f"{p}: {', '.join(sorted(vs))}" for p, vs in sorted(by_product.items()))
            findings.append(f"(unlisted) {lib} differs across products ({where}); add it to {policy_path}")
    return sorted(findings)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    cmd = sub.add_parser("check")
    cmd.add_argument("--repo", required=True)
    cmd.add_argument("--policy", default=DEFAULT_POLICY)
    cmd.add_argument("--mode", choices=("report", "enforce"), default="report")
    args = parser.parse_args(argv)
    try:
        findings = check(os.path.abspath(args.repo), args.policy)
    except InputError as exc:
        print(f"::error::shared deps: unreadable input: {exc}")
        return 2
    level = "error" if args.mode == "enforce" else "warning"
    for finding in findings:
        print(f"::{level}::shared deps {finding}")
    if not findings:
        print("shared deps: OK (every shared library is on its policy version)")
        return 0
    if args.mode == "enforce":
        return 1
    print(f"shared deps: {len(findings)} finding(s), report mode (not failing); alignment is RT-924")
    return 0


if __name__ == "__main__":
    sys.exit(main())
