#!/usr/bin/env python3
"""Keep research artifacts out of the shipped ERPNext-Connector tree (RT-1455).

  connector_research_guard.py check --repo PATH   exit 0 clean, 1 a violation, 2 unreadable input

`tools/release/connector-mirror/publish.py` publishes the tree of `integrations/erpnext-connector/` as
the distribution mirror (`Kemetra-Labs/ERPNext-Connector`), and `bench get-app` / `bench update` pull
that tree onto every Connector bench. So anything under that directory ships. A one-off proof or
research script (RT-1340, RT-1449) belongs outside it, under `docs/research/erpnext-connector/` at the
repository root, where the publisher cannot see it. The publisher stays "tree == subtree" (no exclude
list to forget); this guard is the check that keeps the tree clean.

A path under `integrations/erpnext-connector/` is a violation when:

  (a) a directory segment is named `research` (any depth, any case), so `docs/research/**` and
      `**/research/**` cannot come back; a file named `research.md` (a spec-kit artifact under
      `specs/`) is not a research directory and is allowed
  (b) it is a script or notebook (SCRIPT_SUFFIXES: `.py .sh .js .ts .ps1 .bat .sql .ipynb` and a few
      more) under `docs/`: docs hold prose and assets, and a one-off script there ships with the app

Git-tracked paths plus untracked, non-ignored ones (`git ls-files --cached --others --exclude-standard`),
so the same result locally and in CI. Stdlib only.
"""
import argparse
import os
import subprocess
import sys

CONNECTOR = "integrations/erpnext-connector/"
DOCS = CONNECTOR + "docs/"
SCRIPT_SUFFIXES = (".py", ".sh", ".bash", ".zsh", ".js", ".mjs", ".cjs", ".ts", ".ps1", ".bat", ".cmd",
                   ".rb", ".pl", ".sql", ".ipynb")
HOME = "docs/research/erpnext-connector/"


class InputError(Exception):
    pass


def violations(paths):
    """Problems for the given repo-relative, forward-slash paths; sorted, one string per problem."""
    problems = []
    for path in sorted(set(paths)):
        if not path.startswith(CONNECTOR):
            continue
        segments = path[len(CONNECTOR):].split("/")
        if any(segment.lower() == "research" for segment in segments[:-1]):
            problems.append(f"{path}: research artifact under the shipped Connector tree; move it to {HOME}")
        elif path.startswith(DOCS) and path.lower().endswith(SCRIPT_SUFFIXES):
            problems.append(f"{path}: script under the Connector docs/ tree, which ships with the app; "
                            f"move it to {HOME} or into the package")
    return problems


def list_paths(repo):
    try:
        out = subprocess.run(
            ["git", "-C", repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard",
             "--", CONNECTOR.rstrip("/")],
            capture_output=True, check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        raise InputError(f"git ls-files failed in {repo}: {exc}") from exc
    return [p for p in out.decode("utf-8", "surrogateescape").split("\0") if p]


def check(repo):
    paths = list_paths(repo)
    if not paths:  # fail closed: a renamed subtree or a partial checkout must not pass as "clean"
        raise InputError(f"no files found under {CONNECTOR} in {repo}")
    return violations(paths)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check").add_argument("--repo", required=True)
    args = parser.parse_args(argv)
    try:
        problems = check(os.path.abspath(args.repo))
    except InputError as exc:
        print(f"::error::connector research guard: unreadable input: {exc}")
        return 2
    for problem in problems:
        print(f"::error::connector research guard {problem}")
    if not problems:
        print("connector research guard: OK (no research artifacts under integrations/erpnext-connector/)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
