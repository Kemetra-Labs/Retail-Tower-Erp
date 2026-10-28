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

Stdlib only; every unclear case is a violation.
"""
import argparse
import json
import os
import re
import sys
import tomllib

# Node major bundled by each Electron major (releases.electronjs.org `node` field). Add a row when
# POS moves to a new Electron major; the guard fails until it is there.
ELECTRON_NODE_MAJOR = {44: 24}

SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "dist", "build", "out", ".pnpm-store"}
# Block (`node-version: 22`), flow (`with: { node-version: 22 }`) and quoted-key spellings;
# `node-version-file:` does not match.
INLINE_RE = re.compile(r"(?<![\w-])['\"]?(node|python)-version['\"]?\s*:")
FILE_REF_RE = re.compile(r"(?<![\w-])['\"]?(?:node|python)-version-file['\"]?\s*:\s*['\"]?([^'\"\s#,}]+)")
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


def check_workflows(repo, files):
    problems = []
    for path in files:
        parts = rel(repo, path).split("/")
        if ".github" not in parts or "workflows" not in parts or not path.endswith((".yml", ".yaml")):
            continue
        text = read(path)
        for match in INLINE_RE.finditer(text):
            line = text.count("\n", 0, match.start()) + 1
            problems.append(f"(a) {rel(repo, path)}:{line}: inline {match.group(1)}-version; use {match.group(1)}-version-file")
        for match in FILE_REF_RE.finditer(text):
            if not os.path.isfile(os.path.join(repo, match.group(1))):
                problems.append(f"(a) {rel(repo, path)}: version file {match.group(1)} does not exist")
    return problems


def image_source(repo, path):
    name = os.path.basename(path)
    if name.startswith("Dockerfile"):
        return FROM_NODE_RE, "FROM"
    parts = rel(repo, path).split("/")
    yaml = name.endswith((".yml", ".yaml"))
    compose = yaml and name.startswith(("docker-compose", "compose"))
    workflow = yaml and ".github" in parts and "workflows" in parts
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


def check(repo):
    major = node_major(repo)
    files = list(walk(repo))
    return (check_workflows(repo, files) + check_images(repo, files, major)
            + check_packages(repo, files, major) + check_python_projects(repo, files))


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
        print("toolchain versions: OK (one Node from .nvmrc, Python from .python-version files)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
