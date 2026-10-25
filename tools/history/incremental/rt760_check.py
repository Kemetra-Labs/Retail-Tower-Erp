#!/usr/bin/env python3
"""RT-760 dry-run checks. Every subcommand prints key<TAB>value lines (or JSON) and exits non-zero on failure (fail closed).

  xwalk       HIST EVIDENCE_DIR PROD                crosswalk + tag stability of re-filtered history
  tagsgate    HIST EVIDENCE_DIR PROD APPROVED_TSV   every new tag must be owner-approved; nothing is auto-approved
  lfs         SRC_GIT HIST PROD FROZEN              LFS pointers / filter=lfs in objects not imported before (all refs)
  overlay     REPO REV PRODUCT_DIR...               mode, blob and path of every non-product path at REV
  incremental BASE_GIT CAND ANCHOR_DIR EVIDENCE_DIR HIST PIN_IDENT PIN_DATE
                                                    roots, first-parent merge chain, crosswalk, refs, counts, overlay
  cijobs      REPO REV                              static graph rules on REV; CI_JOB_MISSING vs the known gaps

HIST is the committed tools/history at the anchored Shadow main.
"""
import json
import os
import re
import subprocess
import sys

KNOWN_CI_GAPS = {"admin/build-test", "bc/oasdiff", "bc/schemathesis", "e2e/smoke", "dependency-review"}
LFS_HEADER = b"version https://git-lfs.github.com/spec/v1"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def git(repo, *args, data=None):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, input=data).stdout


def fail(msg):
    sys.exit("FAIL: " + msg)


def read_rows(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def cmd_xwalk(hist, ev, prod):
    old_text = read_rows("%s/crosswalk/%s.tsv" % (hist, prod))
    new_text = read_rows("%s/%s.crosswalk.tsv" % (ev, prod))
    old_lines, new_lines = old_text.splitlines(), new_text.splitlines()
    if old_lines[0] != new_lines[0]:
        fail("%s crosswalk header changed" % prod)
    old = {l.split("\t")[0]: l.split("\t") for l in old_lines[1:]}
    new = {l.split("\t")[0]: l.split("\t") for l in new_lines[1:]}
    rewritten = sorted(o for o in old if o not in new or new[o][1] != old[o][1])
    if rewritten:
        fail("%s: %d existing commits missing or re-hashed, first %s" % (prod, len(rewritten), rewritten[0]))
    tag_changed = []
    for o, row in sorted(old.items()):
        if new[o][2] != row[2]:
            before = set(filter(None, row[2].split(",")))
            after = set(filter(None, new[o][2].split(",")))
            if not before <= after:
                fail("%s: tag removed from existing commit %s (%s -> %s)" % (prod, o, row[2], new[o][2]))
            tag_changed.append((o, row[2], new[o][2]))
    added = sorted(set(new) - set(old))

    old_tags = [l for l in read_rows("%s/crosswalk/tags.tsv" % hist).splitlines() if l.split("\t")[0] == prod]
    new_tags = read_rows("%s/%s.tags.tsv" % (ev, prod)).splitlines()
    by_ref = {l.split("\t")[1]: l for l in new_tags}
    for l in old_tags:
        ref = l.split("\t")[1]
        if ref not in by_ref:
            fail("%s: existing tag %s missing at the new tip (tag deleted upstream)" % (prod, ref))
        if by_ref[ref] != l:
            fail("%s: tag collision, %s now %s" % (prod, ref, by_ref[ref].split("\t")[3:]))
    new_tag_rows = sorted(set(new_tags) - set(old_tags))

    with open("%s/%s.xwalk-diff.tsv" % (ev, prod), "w", encoding="utf-8", newline="\n") as f:
        f.write("kind\told_sha\tdetail\n")
        for o in added:
            f.write("ADDED\t%s\t%s\n" % (o, new[o][1]))
        for o, a, b in tag_changed:
            f.write("OLD_TAGS_CHANGED\t%s\t%s -> %s\n" % (o, a, b))
        for l in new_tag_rows:
            f.write("NEW_TAG\t%s\t%s\n" % (l.split("\t")[3], l.split("\t")[2]))
    print("crosswalk.rows.committed\t%d" % len(old))
    print("crosswalk.rows.new\t%d" % len(new))
    print("crosswalk.rows.added\t%d" % len(added))
    print("crosswalk.rows.existing-identical\t%d" % (len(old) - len(tag_changed)))
    print("crosswalk.rows.old-tags-changed\t%d" % len(tag_changed))
    print("crosswalk.ticket-literal-byte-prefix\t%s" % str(new_text.startswith(old_text)).lower())
    print("tags.committed\t%d" % len(old_tags))
    print("tags.added\t%d" % len(new_tag_rows))


def committed_tags(hist, prod):
    """Rows of the committed crosswalk/tags.tsv for PROD: prod, old_ref, new_ref, old_commit, new_target."""
    return [l.split("\t") for l in read_rows("%s/crosswalk/tags.tsv" % hist).splitlines() if l.split("\t")[0] == prod]


def read_approved(path):
    """Owner-written approvals: prod<TAB>refs/tags/<name><TAB><source commit sha>. Missing file = nothing approved."""
    if not os.path.exists(path):
        return set()
    out = set()
    for n, line in enumerate(read_rows(path).splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 3 or not parts[1].startswith("refs/tags/") or not SHA_RE.match(parts[2]):
            fail("approved-tags line %d is malformed (want prod<TAB>refs/tags/<name><TAB><40-hex sha>)" % n)
        out.add(tuple(parts))
    return out


def cmd_tagsgate(hist, ev, prod, approved_path):
    old = {tuple(r) for r in committed_tags(hist, prod)}
    new = {tuple(l.split("\t")) for l in read_rows("%s/%s.tags.tsv" % (ev, prod)).splitlines()}
    added = sorted(new - old)
    approved = {a for a in read_approved(approved_path) if a[0] == prod}
    found = {(r[0], r[1], r[3]) for r in added}
    unapproved = sorted(found - approved)
    stale = sorted(approved - found)
    print("tags.new\t%d" % len(added))
    print("tags.approved-and-found\t%d" % len(found & approved))
    if unapproved:
        fail("%s: %d new tag(s) not owner-approved, first %s -> %s" % (prod, len(unapproved), unapproved[0][1], unapproved[0][2]))
    if stale:
        fail("%s: approved tag not found at the new tip (stale or wrong target): %s %s" % (prod, stale[0][1], stale[0][2]))


def cmd_lfs(src, hist, prod, frozen):
    # Everything reachable from any fetched ref (main and every tag) that was not already imported:
    # the frozen main plus the commits of the previously imported tags.
    excl = [frozen] + sorted({r[3] for r in committed_tags(hist, prod)})
    objs = git(src, "rev-list", "--objects", "--all", "--not", *excl).decode().splitlines()
    named = {}
    for l in objs:
        p = l.split(" ", 1)
        if len(p) == 2:
            named.setdefault(p[0], p[1])
    if not named:
        print("lfs.scanned-blobs\t0")
        return
    chk = git(src, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)",
              data=("\n".join(sorted(named)) + "\n").encode()).decode().splitlines()
    small = [c.split()[0] for c in chk if c.split()[1] == "blob" and (int(c.split()[2]) < 1024
             or named[c.split()[0]].rsplit("/", 1)[-1] == ".gitattributes")]
    hits = []
    for oid in small:
        data = git(src, "cat-file", "blob", oid)
        path = named[oid]
        if data.startswith(LFS_HEADER):
            hits.append("pointer " + path)
        if path.rsplit("/", 1)[-1] == ".gitattributes" and re.search(rb"filter=lfs", data):
            hits.append("attribute " + path)
    print("lfs.scanned-blobs\t%d" % len(small))
    if hits:
        fail("LFS content in objects new since frozen %s (main or tags): %s" % (frozen[:12], sorted(hits)[:5]))


def overlay_lines(repo, rev, dirs):
    out = git(repo, "ls-tree", "-r", "-z", "--full-tree", rev).decode().split("\0")
    lines = []
    for entry in sorted(e for e in out if e):
        meta, path = entry.split("\t", 1)
        if any(path == d or path.startswith(d + "/") for d in dirs):
            continue
        mode, _, oid = meta.split()
        lines.append("%s\t%s\t%s" % (mode, oid, path))
    return lines


def cmd_overlay(repo, rev, *dirs):
    for l in overlay_lines(repo, rev, dirs):
        print(l)


def ref_targets(repo):
    """refs/heads/main and refs/tags/* -> (object id, peeled commit)."""
    out = {}
    for l in git(repo, "for-each-ref", "--format=%(refname) %(objectname) %(*objectname)",
                 "refs/heads/main", "refs/tags").decode().splitlines():
        p = l.split()
        out[p[0]] = (p[1], p[2] if len(p) > 2 else p[1])
    return out


def reachable(repo):
    return set(git(repo, "rev-list", "refs/heads/main", "--tags").decode().split())


def cmd_incremental(base, cand, anc, ev, hist, pin_ident, pin_date):
    """Incremental-history invariants that tools/history/manifest.py (fresh-build only) cannot check."""
    products = [l.split("\t") for l in read_rows(anc + "/anchors.tsv").splitlines() if l]
    tips = {l.split("\t")[0]: l.split("\t")[2] for l in read_rows(ev + "/filtered-tips.tsv").splitlines() if l}
    want_date = pin_date[:-1] + "+00:00" if pin_date.endswith("Z") else pin_date
    base_main = git(base, "rev-parse", "refs/heads/main").decode().strip()
    cand_main = git(cand, "rev-parse", "refs/heads/main").decode().strip()

    # 1. no new parentless commits (the import keeps one lineage: empty root + 4 product roots)
    roots_b = set(git(base, "rev-list", "--max-parents=0", "refs/heads/main", "--tags").decode().split())
    roots_c = set(git(cand, "rev-list", "--max-parents=0", "refs/heads/main", "--tags").decode().split())
    if roots_b != roots_c:
        fail("parentless commits changed: added %s removed %s" % (sorted(roots_c - roots_b)[:3], sorted(roots_b - roots_c)[:3]))
    print("roots\t%d" % len(roots_c))

    # 2. first-parent chain after the base is exactly the pinned re-import merges, in anchor order
    chain = git(cand, "rev-list", "--first-parent", "--reverse", "%s..%s" % (base_main, cand_main)).decode().split()
    expected = [p for p in products if p[4] != p[3]]
    if len(chain) != len(expected):
        fail("first-parent chain has %d commits after base, expected %d re-import merges" % (len(chain), len(expected)))
    prev = base_main
    for c, (prod, d, repo, frozen, new) in zip(chain, expected):
        parents = git(cand, "rev-list", "--parents", "-n1", c).decode().split()[1:]
        if parents != [prev, tips[prod]]:
            fail("merge %s parents %s, expected [%s, %s]" % (c[:12], parents, prev[:12], tips[prod][:12]))
        a, cm, subj = git(cand, "log", "-1", "--format=%an <%ae> %aI%x00%cn <%ce> %cI%x00%s", c).decode().rstrip("\n").split("\0")
        ident = "%s %s" % (pin_ident, want_date)
        if a != ident or cm != ident:
            fail("merge %s identity not pinned: %s / %s" % (c[:12], a, cm))
        if subj != "Re-import %s history (%s) %s..%s" % (repo, d, frozen[:12], new[:12]):
            fail("merge %s unexpected subject: %s" % (c[:12], subj))
        prev = c
    print("chain.merges\t%d" % len(chain))

    # 3. crosswalk: every committed and every new mapping lands in candidate history, unchanged
    reach = reachable(cand)
    added_total = 0
    for prod, *_ in products:
        committed = {tuple(l.split("\t")[:2]) for l in read_rows("%s/crosswalk/%s.tsv" % (hist, prod)).splitlines()[1:]}
        fresh = {tuple(l.split("\t")[:2]) for l in read_rows("%s/%s.crosswalk.tsv" % (ev, prod)).splitlines()[1:]}
        if not committed <= fresh:
            fail("%s: committed crosswalk mapping missing or changed in the new crosswalk" % prod)
        missing = [n for _, n in fresh if n not in reach]
        if missing:
            fail("%s: %d crosswalk commits not in candidate history, first %s" % (prod, len(missing), missing[0]))
        added_total += len(fresh) - len(committed)
        print("crosswalk.%s.rows\t%d" % (prod, len(fresh)))

    # 4. refs: base refs unchanged except main, plus exactly the approved new tags at their crosswalked targets
    rb, rc = ref_targets(base), ref_targets(cand)
    approved = read_approved(anc + "/approved-tags.tsv")
    xw = {}
    for prod, *_ in products:
        for l in read_rows("%s/%s.crosswalk.tsv" % (ev, prod)).splitlines()[1:]:
            xw[l.split("\t")[0]] = l.split("\t")[1]
    want_new = {"refs/tags/%s/%s" % (p, r[len("refs/tags/"):]): xw.get(s) for p, r, s in approved}
    extra = set(rc) - set(rb) - set(want_new)
    gone = set(rb) - set(rc)
    if extra or gone:
        fail("ref set mismatch: unexpected %s missing %s" % (sorted(extra)[:3], sorted(gone)[:3]))
    for r in rb:
        if r != "refs/heads/main" and rc[r] != rb[r]:
            fail("existing ref %s moved %s -> %s" % (r, rb[r][0][:12], rc[r][0][:12]))
    for r, target in want_new.items():
        if r not in rc or rc[r][1] != target:
            fail("approved tag %s missing or not at crosswalk target %s" % (r, (target or "?")[:12]))
    print("refs.total\t%d" % len(rc))
    print("refs.new-tags\t%d" % len(want_new))

    # 5. commit count: base + new source commits (crosswalk rows added) + re-import merges
    n_base, n_cand = len(reachable(base)), len(reach)
    if n_cand != n_base + added_total + len(chain):
        fail("commit count %d != base %d + new source commits %d + merges %d" % (n_cand, n_base, added_total, len(chain)))
    print("commits.base\t%d" % n_base)
    print("commits.candidate\t%d" % n_cand)

    # 6. CI/security overlay (.github/**, CODEOWNERS, tools/**) byte-identical to the anchored manifest
    dirs = [p[1] for p in products]
    if overlay_lines(cand, "refs/heads/main", dirs) != read_rows(anc + "/overlay.tsv").splitlines():
        fail("candidate overlay differs from the anchored overlay manifest")
    print("overlay.paths\t%d" % len(read_rows(anc + "/overlay.tsv").splitlines()))


def cmd_cijobs(repo, rev):
    sys.path.insert(0, repo + "/tools/project-graph")
    from pgraph import gitio
    from pgraph.graph import load_graph, validate_graph
    text = git(repo, "show", "%s:tools/project-graph/graph.yaml" % rev).decode("utf-8")
    errors = validate_graph(load_graph(text), tree_paths=gitio.list_tree(repo, rev),
                            workflow_jobs=gitio.workflow_jobs(repo, rev))
    missing = {e.split(": ", 1)[1] for e in errors if e.startswith("CI_JOB_MISSING: ")}
    other = sorted(e for e in errors if not e.startswith("CI_JOB_MISSING: "))
    result = {"rev": rev, "ci_job_missing": sorted(missing),
              "known_gaps_still_missing": sorted(missing & KNOWN_CI_GAPS),
              "known_gaps_now_present": sorted(KNOWN_CI_GAPS - missing),
              "unexpected_missing": sorted(missing - KNOWN_CI_GAPS), "other_errors": other}
    print(json.dumps(result, indent=2, sort_keys=True))
    if result["unexpected_missing"] or other:
        sys.exit(1)


if __name__ == "__main__":
    cmds = {"xwalk": cmd_xwalk, "tagsgate": cmd_tagsgate, "lfs": cmd_lfs, "overlay": cmd_overlay,
            "incremental": cmd_incremental, "cijobs": cmd_cijobs}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        sys.exit(__doc__)
    cmds[sys.argv[1]](*sys.argv[2:])
