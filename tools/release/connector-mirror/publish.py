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
# Provenance is read from the raw message, never via git's trailer parser: `git interpret-trailers` (the write
# side) puts the trailer above a bare `---` line, where `%(trailers)` no longer sees it.
# git's patch-start rule (`---` then whitespace or EOL): interpret-trailers inserts the trailer above the FIRST such line
PATCH_START = re.compile(r"^---(?:[ \t\r]|$)", re.MULTILINE)
PROVENANCE_LINE = re.compile(rf"^{TRAILER}: (?P<repo>[\w.-]+/[\w.-]+)@(?P<sha>[0-9a-f]{{40}})[ \t]*\r?$", re.MULTILINE)
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


def provenance_in(message):
    """(slug, source_sha) from the LAST `Monorepo-Commit: <slug>@<sha>` line of a raw commit message, or None.

    Text after a patch-start line is ignored: the publisher's own trailer is always above it, so a look-alike line
    in the source message's tail cannot override the real one.
    """
    cut = PATCH_START.search(message)
    found = None
    for m in PROVENANCE_LINE.finditer(message[:cut.start()] if cut else message):
        found = (m["repo"], m["sha"])
    return found


def commit_messages(repo, ref, *extra):
    """[(commit sha, raw message)] newest first, for commits having a line that starts with the trailer key."""
    # NUL separates records: git cannot store it in a message, so message text can never forge a record boundary
    out = git("log", "--format=%x00%H%x1f%B", "--grep", f"^{TRAILER}:", "--extended-regexp", *extra, ref, git_dir=repo)
    return [(sha, msg) for sha, _, msg in (rec.partition("\x1f") for rec in out.split("\0") if rec.strip())]


def last_provenance(repo, ref, repo_slug):
    """Source sha from the newest Monorepo-Commit line reachable from ref, or None."""
    recs = commit_messages(repo, ref, "-1")
    if not recs:
        return None
    found = provenance_in(recs[0][1])
    if not found:
        lines = [ln for ln in recs[0][1].splitlines() if ln.startswith(f"{TRAILER}:")]
        raise Refusal(f"mirror head {recs[0][0][:12]} has a malformed {TRAILER} trailer: {lines[-1]!r}")
    if found[0] != repo_slug:
        raise Refusal(f"mirror was published from {found[0]}, not {repo_slug}")
    return found[1]


def published(repo, ref):
    """mirror sha -> (slug, source sha) for every commit on the mirror carrying a valid provenance line."""
    return {sha: found for sha, msg in commit_messages(repo, ref) if (found := provenance_in(msg))}


def mirror_map(repo, ref):
    """source sha -> mirror sha for every published commit already on the mirror."""
    return {found[1]: sha for sha, found in published(repo, ref).items()}


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


def plan_publish(work, src, head, mirror_head, anchor, repo_slug, subdir, tag_prefix, mirror_tags, tags=True):
    sha_map = {**mirror_map(work, mirror_head), anchor: mirror_head}
    tag_plan = (lambda: plan_tags(work, src, head, sha_map, subdir, tag_prefix, mirror_tags)) if tags else (lambda: ())
    if anchor == head or is_ancestor(src, head, anchor):
        # source is at or behind the mirror: no commits, but a tag added since still has to be mirrored
        return Plan((), tag_plan(), mirror_head)
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
    return Plan(tuple(made), tag_plan(), tip)


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
    pairs = published(work, mirror_head)
    previous = None
    for sha in git("rev-list", "--reverse", "--first-parent", mirror_head, git_dir=work).split():
        if sha not in pairs:
            continue  # pre-cutover history
        slug, source_sha = pairs[sha]
        if slug != repo_slug or git("cat-file", "-t", source_sha, git_dir=src, check=False).returncode != 0:
            raise Refusal(f"{sha[:12]}: provenance {slug}@{source_sha} not resolvable in {repo_slug}")
        if git("rev-parse", f"{sha}^{{tree}}", git_dir=work) != subtree(src, source_sha, subdir):
            raise Refusal(f"{sha[:12]}: tree != subtree at {source_sha[:12]}")
        if previous and not is_ancestor(src, previous, source_sha, first_parent=False):
            raise Refusal(f"{sha[:12]}: source order is not monotonic")
        previous = source_sha
    return len({found[1] for found in pairs.values()})


def publish(mirror, repo_slug, source_dir=".", source_ref="HEAD", base=None, branch="main", subdir=SUBDIR,
            tag_prefix=TAG_PREFIX, dry_run=False, verify_only=False, before_push=None, tags=True):
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
        plan = plan_publish(work, src, head, mirror_head, anchor, repo_slug, subdir, tag_prefix, mirror_tags, tags)
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
    p.add_argument("--source-repo", required=True,
                   help="OWNER/REPO named in the trailer, e.g. Kemetra-Labs/Retail-Tower-Erp (permanent: a later run "
                        "with another slug is refused)")
    p.add_argument("--source-dir", default=".")
    p.add_argument("--source-ref", default="HEAD")
    p.add_argument("--base", help="source sha whose subtree is the frozen mirror main (first run only)")
    p.add_argument("--branch", default="main")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--verify", action="store_true", help="only check tree equality of the mirror's published commits")
    p.add_argument("--no-tags", action="store_true",
                   help="publish commits only; erpnext-connector/v* tags are left to the gated release workflow")
    a = p.parse_args(argv)
    try:
        publish(a.mirror, a.source_repo, a.source_dir, a.source_ref, a.base, a.branch,
                dry_run=a.dry_run, verify_only=a.verify, tags=not a.no_tags)
    except Refusal as err:
        print(f"REFUSED: {err}", file=sys.stderr)
        return 2
    except PushRejected as err:
        print(f"PUSH REJECTED (no force attempted; re-run to reconcile): {err}", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
