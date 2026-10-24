#!/usr/bin/env python3
"""Append-only publisher: monorepo integrations/erpnext-connector -> ERPNext-Connector mirror (RT-712, D3).

For every first-parent commit of the source ref that changes the connector subtree, append ONE commit to
the mirror's main whose tree IS the subtree at that source SHA (so the app sits at the repo root, which is
all `bench get-app` can install) and whose message ends in a `Monorepo-Commit: <source-repo>@<sha>` trailer.

Never force-pushes. State lives in the mirror itself (the last trailer), so re-runs are no-ops.
Stdlib only; needs git >= 2.40. Exit codes: 0 ok / nothing to do, 2 refused, 4 push rejected.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass

SUBDIR = "integrations/erpnext-connector"
TAG_PREFIX = "erpnext-connector/"
TRAILER = "Monorepo-Commit"
PUBLISHER = ("Kemetra mirror publisher", "mirror-publisher@kemetra.invalid")
SEMVER_TAG = re.compile(r"^v\d+\.\d+\.\d+$")
TRAILER_VALUE = re.compile(r"^(?P<repo>[\w.-]+/[\w.-]+)@(?P<sha>[0-9a-f]{40})$")
BARE_REF = re.compile(r"(?<![\w/&#])#(\d+)\b")


class Refusal(Exception):
    """A safety check failed; nothing was pushed."""


@dataclass(frozen=True)
class Plan:
    commits: tuple  # ((source_sha, mirror_sha), ...) oldest first
    tags: tuple  # ((mirror_tag, mirror_sha), ...)
    tip: str


def git(*args, git_dir=None, cwd=None, env=None, stdin=None, check=True):
    cmd = ["git"] + (["--git-dir", git_dir] if git_dir else []) + list(args)
    proc = subprocess.run(cmd, cwd=cwd, env={**os.environ, **(env or {})}, input=stdin,
                          capture_output=True, text=True, encoding="utf-8")
    if check and proc.returncode != 0:
        raise Refusal(f"git {' '.join(args[:3])} failed: {proc.stderr.strip()}")
    return proc.stdout.strip() if check else proc


def is_ancestor(repo, a, b, first_parent=False):
    if first_parent:
        return a in git("rev-list", "--first-parent", b, git_dir=repo).split()
    return git("merge-base", "--is-ancestor", a, b, git_dir=repo, check=False).returncode == 0


def subtree(repo, sha, subdir):
    out = git("rev-parse", "--verify", "-q", f"{sha}:{subdir}", git_dir=repo, check=False)
    if out.returncode != 0:
        raise Refusal(f"{sha[:12]} has no {subdir}/ (mirror would lose the app)")
    return out.stdout.strip()


def last_provenance(repo, ref, repo_slug):
    """(slug, source_sha) from the newest Monorepo-Commit trailer reachable from ref, or None."""
    log = git("log", "-1", f"--format=%(trailers:key={TRAILER},valueonly,unfold)", ref, "--grep", f"^{TRAILER}:",
              "--extended-regexp", git_dir=repo)
    lines = [ln for ln in log.splitlines() if ln.strip()]
    if not lines:
        return None
    m = TRAILER_VALUE.match(lines[-1].strip())
    if not m:
        raise Refusal(f"mirror head has a malformed {TRAILER} trailer: {lines[-1]!r}")
    if m["repo"] != repo_slug:
        raise Refusal(f"mirror was published from {m['repo']}, not {repo_slug}")
    return m["sha"]


def mirror_map(repo, ref):
    """source sha -> mirror sha for every published commit already on the mirror."""
    out = git("log", f"--format=%x1e%H%x1f%(trailers:key={TRAILER},valueonly,unfold)", ref, git_dir=repo)
    pairs = {}
    for rec in filter(None, out.split("\x1e")):
        mirror_sha, _, val = rec.partition("\x1f")
        m = TRAILER_VALUE.match(val.strip())
        if m:
            pairs[m["sha"]] = mirror_sha.strip()
    return pairs


def qualified_message(src, sha, repo_slug):
    body = git("log", "-1", "--format=%B", sha, git_dir=src)
    body = BARE_REF.sub(lambda m: f"{repo_slug}#{m.group(1)}", body).rstrip() + "\n"
    return git("interpret-trailers", "--trailer", f"{TRAILER}: {repo_slug}@{sha}", stdin=body) + "\n"


def make_commit(work, src, sha, tree, parent, repo_slug):
    an, ae, ad, cd = git("log", "-1", "--format=%an%x1f%ae%x1f%aI%x1f%cI", sha, git_dir=src).split("\x1f")
    env = {"GIT_AUTHOR_NAME": an, "GIT_AUTHOR_EMAIL": ae, "GIT_AUTHOR_DATE": ad,
           "GIT_COMMITTER_NAME": PUBLISHER[0], "GIT_COMMITTER_EMAIL": PUBLISHER[1], "GIT_COMMITTER_DATE": cd}
    return git("-c", "commit.gpgsign=false", "commit-tree", tree, "-p", parent,
               git_dir=work, env=env, stdin=qualified_message(src, sha, repo_slug))


def resolve_anchor(work, src, head, mirror_head, repo_slug, base, subdir):
    """Source sha the mirror head corresponds to. Refuses anything the mirror cannot prove."""
    prior = last_provenance(work, mirror_head, repo_slug)
    if prior:
        tip_sha = git("log", "-1", "--format=%H", mirror_head, "--grep", f"^{TRAILER}:", "--extended-regexp",
                      git_dir=work)
        if tip_sha != mirror_head:
            raise Refusal("mirror head is not a publisher commit (a human commit landed on the mirror); "
                          "refusing to build on it")
        if git("cat-file", "-t", prior, git_dir=src, check=False).returncode != 0:
            raise Refusal(f"mirror provenance {prior[:12]} is not in the source repo (regenerated history?)")
        return prior
    if not base:
        raise Refusal("mirror has no Monorepo-Commit provenance yet: pass --base <source sha> "
                      "(the commit whose subtree is the frozen mirror main)")
    if subtree(work, base, subdir) != git("rev-parse", f"{mirror_head}^{{tree}}", git_dir=work):
        raise Refusal(f"--base {base[:12]} subtree != mirror head tree: not the frozen baseline")
    return git("rev-parse", "--verify", f"{base}^{{commit}}", git_dir=src)


def plan_publish(work, src, head, mirror_head, anchor, repo_slug, subdir, tag_prefix, mirror_tags):
    sha_map = {**mirror_map(work, mirror_head), anchor: mirror_head}
    if anchor == head or is_ancestor(src, head, anchor):
        # source is at or behind the mirror: no commits, but a tag added since still has to be mirrored
        return Plan((), plan_tags(work, src, head, sha_map, subdir, tag_prefix, mirror_tags), mirror_head)
    if not is_ancestor(src, anchor, head, first_parent=True):
        raise Refusal(f"mirror provenance {anchor[:12]} is not on the first-parent history of the source head")
    prev_tree, tip, made = subtree(work, anchor, subdir), mirror_head, []
    for sha in git("rev-list", "--first-parent", "--reverse", f"{anchor}..{head}", git_dir=src).split():
        tree = subtree(work, sha, subdir)
        if tree == prev_tree:
            continue
        tip = make_commit(work, src, sha, tree, tip, repo_slug)
        if git("rev-parse", f"{tip}^{{tree}}", git_dir=work) != tree:
            raise Refusal(f"tree-equality check failed for {sha[:12]}")
        sha_map[sha] = tip
        made.append((sha, tip))
        prev_tree = tree
    if tip != mirror_head and not is_ancestor(work, mirror_head, tip):
        raise Refusal("mirror head is not an ancestor of the result")
    return Plan(tuple(made), plan_tags(work, src, head, sha_map, subdir, tag_prefix, mirror_tags), tip)


def plan_tags(work, src, head, sha_map, subdir, tag_prefix, mirror_tags):
    out = []
    refs = git("for-each-ref", f"refs/tags/{tag_prefix}*", "--format=%(refname:strip=2) %(objectname) %(*objectname)",
               git_dir=src)
    for line in filter(None, refs.splitlines()):
        name, obj, *peeled = line.split()
        mirror_tag, sha = name[len(tag_prefix):], (peeled or [obj])[0]
        if not SEMVER_TAG.match(mirror_tag) or not is_ancestor(src, sha, head):
            continue
        target = next((sha_map[c] for c in git("rev-list", "--first-parent", sha, git_dir=src).split()
                       if c in sha_map), None)
        if target is None:
            continue  # predates the mirror baseline; the live repo's own tags cover it
        if git("rev-parse", f"{target}^{{tree}}", git_dir=work) != subtree(work, sha, subdir):
            raise Refusal(f"tag {name}: mirror commit tree != subtree at {sha[:12]}")
        if mirror_tag in mirror_tags:
            if mirror_tags[mirror_tag] != target:
                raise Refusal(f"tag {mirror_tag} already exists on the mirror at a different commit (immutable)")
            continue
        out.append((mirror_tag, target))
    return tuple(out)


def verify_mirror(work, src, mirror_head, repo_slug, subdir):
    """Every published commit: valid source SHA, tree == subtree at that SHA, source order monotonic."""
    pairs = mirror_map(work, mirror_head)
    previous = None
    for sha in git("rev-list", "--reverse", "--first-parent", mirror_head, git_dir=work).split():
        out = git("log", "-1", f"--format=%(trailers:key={TRAILER},valueonly,unfold)", sha, git_dir=work)
        m = TRAILER_VALUE.match(out.strip())
        if not m:
            continue  # pre-cutover history
        if m["repo"] != repo_slug or git("cat-file", "-t", m["sha"], git_dir=src, check=False).returncode != 0:
            raise Refusal(f"{sha[:12]}: provenance {out.strip()!r} not resolvable in {repo_slug}")
        if git("rev-parse", f"{sha}^{{tree}}", git_dir=work) != subtree(src, m["sha"], subdir):
            raise Refusal(f"{sha[:12]}: tree != subtree at {m['sha'][:12]}")
        if previous and not is_ancestor(src, previous, m["sha"], first_parent=False):
            raise Refusal(f"{sha[:12]}: source order is not monotonic")
        previous = m["sha"]
    return len(pairs)


def publish(mirror, repo_slug, source_dir=".", source_ref="HEAD", base=None, branch="main", subdir=SUBDIR,
            tag_prefix=TAG_PREFIX, dry_run=False, verify_only=False, before_push=None):
    src_top = git("rev-parse", "--show-toplevel", cwd=source_dir)
    src = git("rev-parse", "--absolute-git-dir", cwd=src_top)
    head = git("rev-parse", "--verify", f"{source_ref}^{{commit}}", git_dir=src)
    tmp = tempfile.mkdtemp(prefix="connector-mirror-")
    try:
        work = os.path.join(tmp, "work.git")
        git("init", "-q", "--bare", work)
        common = git("rev-parse", "--path-format=absolute", "--git-common-dir", cwd=src_top)
        with open(os.path.join(work, "objects", "info", "alternates"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(os.path.join(common, "objects").replace("\\", "/") + "\n")
        env = {"GIT_TERMINAL_PROMPT": "0"}
        fetched = git("fetch", "-q", "--no-tags", mirror, f"+refs/heads/{branch}:refs/mirror/head",
                      "+refs/tags/*:refs/mirror-tags/*", git_dir=work, env=env, check=False)
        if fetched.returncode != 0:
            raise Refusal(f"cannot fetch mirror {branch}: {fetched.stderr.strip()} (mirror must be seeded with the frozen main)")
        mirror_head = git("rev-parse", "refs/mirror/head", git_dir=work)
        mirror_tags = {}
        for line in filter(None, git("for-each-ref", "refs/mirror-tags",
                                     "--format=%(refname:strip=2) %(objectname) %(*objectname)", git_dir=work).splitlines()):
            name, obj, *peeled = line.split()
            mirror_tags[name] = (peeled or [obj])[0]
        checked = verify_mirror(work, src, mirror_head, repo_slug, subdir)
        print(f"mirror head {mirror_head[:12]}: {checked} published commit(s) verified (tree == subtree)")
        if verify_only:
            return Plan((), (), mirror_head)
        anchor = resolve_anchor(work, src, head, mirror_head, repo_slug, base, subdir)
        plan = plan_publish(work, src, head, mirror_head, anchor, repo_slug, subdir, tag_prefix, mirror_tags)
        for s, m in plan.commits:
            print(f"publish {s[:12]} -> {m[:12]}")
        for t, m in plan.tags:
            print(f"tag {t} -> {m[:12]}")
        if not plan.commits and not plan.tags:
            print("nothing to publish")
            return plan
        if dry_run:
            print("dry run: not pushing")
            return plan
        if before_push:
            before_push()
        refspecs = [f"{plan.tip}:refs/heads/{branch}"] + [f"{m}:refs/tags/{t}" for t, m in plan.tags]
        pushed = git("push", "--atomic", mirror, *refspecs, git_dir=work, env=env, check=False)
        if pushed.returncode != 0:
            raise PushRejected(pushed.stderr.strip())
        print(f"pushed {plan.tip[:12]} ({len(plan.commits)} commit(s), {len(plan.tags)} tag(s))")
        return plan
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


class PushRejected(Exception):
    pass


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--mirror", required=True, help="mirror URL or path (no default: never guess a destination)")
    p.add_argument("--source-repo", required=True, help="OWNER/REPO named in the trailer, e.g. Kemetra/Retail-Tower")
    p.add_argument("--source-dir", default=".")
    p.add_argument("--source-ref", default="HEAD")
    p.add_argument("--base", help="source sha whose subtree is the frozen mirror main (first run only)")
    p.add_argument("--branch", default="main")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--verify", action="store_true", help="only check tree equality of the mirror's published commits")
    a = p.parse_args(argv)
    try:
        publish(a.mirror, a.source_repo, a.source_dir, a.source_ref, a.base, a.branch,
                dry_run=a.dry_run, verify_only=a.verify)
    except Refusal as err:
        print(f"REFUSED: {err}", file=sys.stderr)
        return 2
    except PushRejected as err:
        print(f"PUSH REJECTED (no force attempted; re-run to reconcile): {err}", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
