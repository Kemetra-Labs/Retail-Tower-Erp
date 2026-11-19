#!/usr/bin/env python3
"""One Node and one Python per role, read from version files (RT-923).

  toolchain_versions.py check --repo PATH     exit 0 all pass, 1 a violation, 2 unreadable input

The repo-root `.nvmrc` is the Node major. Every rule below compares against it or against the
`.python-version` file next to a Python project:

  (a) no workflow sets `node-version:` or `python-version:` inline; every `node-version-file:` /
      `python-version-file:` names a file that exists
  (b) every Dockerfile `FROM [registry/]node[:tag]`, and every workflow or docker-compose
      `image: [registry/]node[:tag]`, has the `.nvmrc` major (no tag is a violation)
  (c) every package.json `engines.node` lower bound and `@types/node` major is the `.nvmrc` major;
      a package that depends on `electron` is checked against the Node major Electron bundles
      (ELECTRON_NODE_MAJOR), and an Electron major missing from that table is a violation
  (d) every pyproject.toml with a `.python-version` beside it has `requires-python = ">=X.Y"`
      where X.Y is that file's version
  (e) every `.python-version` in the repository has the same content as the root one (RT-1296:
      one Python for the whole repository), and the root file exists
  (f) the ERPNext bench pins (FRAPPE_REF, ERPNEXT_REF, BENCH_VERSION, the MariaDB image with its
      digest) have one value across erpnext-connector.yml, connector-bench-nightly.yml and
      finance-report-role-bench.yml; a missing workflow or a missing pin is a violation (RT-1467)

Stdlib plus PyYAML (hash-pinned in tools/project-graph/requirements.txt, which boundary-check
installs first); workflows are parsed, not pattern-matched. Every unclear case is a violation.
"""
import argparse
import json
import os
import re
import sys
import tomllib

import yaml

# Node major bundled by each Electron major (releases.electronjs.org `node` field). Add a row when
# POS moves to a new Electron major; the guard fails until it is there.
ELECTRON_NODE_MAJOR = {44: 24}

# RT-1467 CI-12: the three workflows that build an ERPNext/Frappe bench must run the same validated
# pair (RT-494): Frappe, ERPNext, bench CLI and the MariaDB image with its digest.
FRAPPE_PIN_WORKFLOWS = (
    ".github/workflows/erpnext-connector.yml",
    ".github/workflows/connector-bench-nightly.yml",
    ".github/workflows/finance-report-role-bench.yml",
)
FRAPPE_ENV_KEYS = ("FRAPPE_REF", "ERPNEXT_REF", "BENCH_VERSION")
MARIADB_PIN = "mariadb image"
FRAPPE_PINS = FRAPPE_ENV_KEYS + (MARIADB_PIN,)

SKIP_DIRS = {".git", ".claude", "node_modules", ".venv", "venv", "dist", "build", "out", ".pnpm-store"}
INLINE_KEYS = {"node-version", "python-version"}
FILE_KEYS = {"node-version-file", "python-version-file"}
# `node`, `node:24-slim`, `docker.io/library/node:24@sha256:...`; group 1 is the tag (None if absent).
NODE_IMAGE = r"(?:[\w.:-]+/)*node(?::([^\s@'\"]+))?(?=[\s@'\"]|$)"
FROM_NODE_RE = re.compile(r"^\s*FROM\s+(?:--platform=\S+\s+)?" + NODE_IMAGE, re.MULTILINE | re.IGNORECASE)
IMAGE_NODE_RE = re.compile(r"^\s*-?\s*image:\s*['\"]?" + NODE_IMAGE, re.MULTILINE)
LEADING_MAJOR_RE = re.compile(r"^\s*[v^~>=<\s]*(\d+)")
REQUIRES_RE = re.compile(r"^\s*>=\s*(\d+)\.(\d+)(?:\.\d+)?\s*(?:,|$)")


class InputError(Exception):
    pass


def walk(repo):
    for root, dirs, files in os.walk(repo):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(files):
            yield os.path.join(root, name)


def rel(repo, path):
    return os.path.relpath(path, repo).replace(os.sep, "/")


def read(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except (OSError, UnicodeDecodeError) as exc:
        raise InputError(f"{path}: {exc}") from exc


def node_major(repo):
    path = os.path.join(repo, ".nvmrc")
    match = re.fullmatch(r"v?(\d+)(?:\.\d+){0,2}", read(path).strip())
    if not match:
        raise InputError(".nvmrc: expected a Node version such as 24")
    return int(match.group(1))


def leading_major(spec):
    match = LEADING_MAJOR_RE.match(spec)
    return int(match.group(1)) if match else None


def mappings(node):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from mappings(value)
    elif isinstance(node, list):
        for value in node:
            yield from mappings(value)


def check_workflows(repo, files):
    problems = []
    for path in files:
        name = rel(repo, path)
        parts = name.split("/")
        if ".github" not in parts or "workflows" not in parts or not path.endswith((".yml", ".yaml")):
            continue
        try:
            data = yaml.safe_load(read(path))
        except yaml.YAMLError as exc:
            raise InputError(f"{name}: {exc}") from exc
        # Every spelling (block, flow, quoted key) parses to the same mapping key.
        for mapping in mappings(data):
            for key, value in mapping.items():
                if key in INLINE_KEYS:
                    problems.append(f"(a) {name}: inline {key}: {value!r}; use {key}-file")
                elif key in FILE_KEYS:
                    target = value if isinstance(value, str) and value else None
                    if target is None or not os.path.isfile(os.path.join(repo, target)):
                        problems.append(f"(a) {name}: version file {value} does not exist")
    return problems


def image_source(repo, path):
    name = os.path.basename(path)
    if name.startswith("Dockerfile"):
        return FROM_NODE_RE, "FROM"
    parts = rel(repo, path).split("/")
    is_yaml = name.endswith((".yml", ".yaml"))
    compose = is_yaml and name.startswith(("docker-compose", "compose"))
    workflow = is_yaml and ".github" in parts and "workflows" in parts
    return (IMAGE_NODE_RE, "image:") if compose or workflow else (None, None)


def check_images(repo, files, major):
    problems = []
    for path in files:
        pattern, label = image_source(repo, path)
        if pattern is None:
            continue
        for match in pattern.finditer(read(path)):
            tag = match.group(1)
            if tag is None or leading_major(tag) != major:
                shown = f"node:{tag}" if tag else "node (no tag)"
                problems.append(f"(b) {rel(repo, path)}: {label} {shown} is not Node {major} (.nvmrc)")
    return problems


def expected_node_major(name, pkg, major):
    deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
    if "electron" not in deps:
        return major, ".nvmrc"
    electron = leading_major(deps["electron"])
    if electron not in ELECTRON_NODE_MAJOR:
        raise ValueError(f"(c) {name}: electron {deps['electron']} has no ELECTRON_NODE_MAJOR entry")
    return ELECTRON_NODE_MAJOR[electron], f"Electron {electron}"


def check_packages(repo, files, major):
    problems = []
    for path in files:
        if os.path.basename(path) != "package.json":
            continue
        name = rel(repo, path)
        try:
            pkg = json.loads(read(path))
        except json.JSONDecodeError as exc:
            raise InputError(f"{name}: {exc}") from exc
        engines = (pkg.get("engines") or {}).get("node")
        if engines is not None:
            lows = [leading_major(alt) for alt in engines.split("||")]
            if None in lows or min(lows) != major:
                problems.append(f"(c) {name}: engines.node {engines!r} lower bound is not Node {major} (.nvmrc)")
        types = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}.get("@types/node")
        if types is None:
            continue
        try:
            want, source = expected_node_major(name, pkg, major)
        except ValueError as exc:
            problems.append(str(exc))
            continue
        if leading_major(types) != want:
            problems.append(f"(c) {name}: @types/node {types!r} is not Node {want} ({source})")
    return problems


def check_python_projects(repo, files):
    problems = []
    for path in files:
        if os.path.basename(path) != "pyproject.toml":
            continue
        pin_path = os.path.join(os.path.dirname(path), ".python-version")
        if not os.path.isfile(pin_path):
            continue
        name = rel(repo, path)
        pin = re.fullmatch(r"(\d+)\.(\d+)(?:\.\d+)?", read(pin_path).strip())
        if not pin:
            problems.append(f"(d) {rel(repo, pin_path)}: expected a version such as 3.14")
            continue
        try:
            requires = tomllib.loads(read(path)).get("project", {}).get("requires-python", "")
        except tomllib.TOMLDecodeError as exc:
            raise InputError(f"{name}: {exc}") from exc
        low = REQUIRES_RE.match(requires)
        if not low or low.groups() != pin.groups():
            problems.append(f"(d) {name}: requires-python {requires!r} lower bound is not {pin.group(0)} (.python-version)")
    return problems


def check_python_pins(repo, files):
    root = os.path.join(repo, ".python-version")
    if not os.path.isfile(root):
        return ["(e) root .python-version is missing"]
    want = read(root).strip()
    problems = []
    for path in files:
        if os.path.basename(path) != ".python-version" or path == root:
            continue
        got = read(path).strip()
        if got != want:
            problems.append(f"(e) {rel(repo, path)} is {got}, the root pin is {want}")
    return problems


def frappe_pins_in(data):
    """{pin name: [raw values]} for every bench pin a parsed workflow sets anywhere (env at workflow,
    job or step level, and the MariaDB service image). Values stay as YAML typed them."""
    found = {}
    for mapping in mappings(data):
        for key in FRAPPE_ENV_KEYS:
            if key in mapping:
                found.setdefault(key, []).append(mapping[key])
        image = mapping.get("image")
        if isinstance(image, str) and image.startswith("mariadb:"):
            found.setdefault(MARIADB_PIN, []).append(image)
    return found


def check_frappe_pins(repo):
    """(f) the ERPNext bench pins agree across the workflows that build a bench (RT-1467 CI-12)."""
    problems = []
    by_pin = {pin: {} for pin in FRAPPE_PINS}            # pin -> {value: [workflow, ...]}
    for name in FRAPPE_PIN_WORKFLOWS:
        path = os.path.join(repo, name)
        if not os.path.isfile(path):
            problems.append(f"(f) {name}: missing, so its ERPNext bench pins cannot be compared")
            continue
        try:
            found = frappe_pins_in(yaml.safe_load(read(path)))
        except yaml.YAMLError as exc:
            raise InputError(f"{name}: {exc}") from exc
        for pin in FRAPPE_PINS:
            raw = found.get(pin, [])
            if any(not isinstance(v, str) for v in raw):
                # `5.30` loads as the float 5.3 and `5.31` as 5.31: comparing str() of them would depend on quoting
                problems.append(f"(f) {name}: {pin} must be a quoted string")
                continue
            values = set(raw)
            if not values:
                problems.append(f"(f) {name}: no {pin}")
            elif len(values) > 1:
                problems.append(f"(f) {name}: {pin} has several values {sorted(values)}")
            else:
                by_pin[pin].setdefault(next(iter(values)), []).append(name)
    for pin, values in by_pin.items():
        if len(values) > 1:
            shown = "; ".join(f"{value!r} in {', '.join(names)}" for value, names in sorted(values.items()))
            problems.append(f"(f) {pin} differs across the bench workflows: {shown}")
    return problems


def check(repo):
    major = node_major(repo)
    files = list(walk(repo))
    return (check_workflows(repo, files) + check_images(repo, files, major)
            + check_packages(repo, files, major) + check_python_projects(repo, files)
            + check_python_pins(repo, files) + check_frappe_pins(repo))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check").add_argument("--repo", required=True)
    args = parser.parse_args(argv)
    try:
        problems = check(os.path.abspath(args.repo))
    except InputError as exc:
        print(f"::error::toolchain versions: unreadable input: {exc}")
        return 2
    for problem in problems:
        print(f"::error::toolchain versions {problem}")
    if not problems:
        print("toolchain versions: OK (one Node from .nvmrc, one Python from the root .python-version)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
