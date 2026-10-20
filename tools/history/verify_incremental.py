#!/usr/bin/env python3
"""RT-776 incremental history verifier for Retail-Tower-Shadow (fail closed).

  verify_incremental.py REPO BASE [REV] --pin-date YYYY-MM-DDTHH:MM:SSZ [--src-base DIR] [--approved-tags FILE]

REPO      git repository (bare or work tree) that contains BASE and REV.
BASE      the anchored Shadow main the re-import was built on.
REV       commit to verify (default HEAD): BASE, then re-import merges, then at most one metadata commit,
          optionally behind one GitHub PR merge of a head that itself passes.
--src-base  directory with <Repo>.git source mirrors. Required as soon as re-import merges are present.

Imported commits are rebuilt byte for byte from their source commits: tree, mapped parents, raw author and
committer lines, callback-rewritten message, and no other header (so no gpgsig, encoding or custom header).
Merge and metadata commits must equal their expected bytes, apart from the tree id.
"""
import argparse
import datetime
import os
import re
import subprocess
import sys

PIN_IDENT = b"Retail Tower history import <history-import@kemetra.invalid>"
META_MESSAGE = b"Update history metadata for incremental re-import (RT-776)\n"
FROZEN = "tools/history/frozen.tsv"
XW_DIR = "tools/history/crosswalk/"
TAGS = XW_DIR + "tags.tsv"
SELF = "tools/history/verify_incremental.py"
SHA = re.compile(r"^[0-9a-f]{40}$")
MERGE_SUBJECT = re.compile(rb"^Re-import (\S+) history \((\S+)\) ([0-9a-f]{12})\.\.([0-9a-f]{12})\n\Z")
XW_HEADER = b"old_sha\tnew_sha\told_tags"


class Fail(Exception):
    pass


def need(cond, msg):
    if not cond:
        raise Fail(msg)


GIT_ENV = dict(os.environ, GIT_NO_REPLACE_OBJECTS="1", GIT_GRAFT_FILE="/dev/null", GIT_CONFIG_GLOBAL="/dev/null",
               GIT_CONFIG_NOSYSTEM="1")
VALID_MODES = {b"100644", b"100755", b"120000", b"40000", b"160000"}
AUTHOR_LINE = re.compile(rb"^author [^\n<]+ <[^\n>]*> [0-9]+ [+-][0-9]{4}$")
GITHUB_COMMITTER_LINE = re.compile(rb"^committer GitHub <noreply@github\.com> [0-9]+ [+-][0-9]{4}$")


def git(repo, *args, check=True):
    p = subprocess.run(["git", "-C", repo, *args], capture_output=True, env=GIT_ENV)
    if check and p.returncode != 0:
        raise Fail("git %s failed: %s" % (" ".join(args[:3]), p.stderr.decode(errors="replace").strip()[:200]))
    return p.stdout if check else (p.returncode, p.stdout)


def rev(repo, spec):
    return git(repo, "rev-parse", "--verify", "-q", spec).decode().strip()


def shas(repo, *args):
    return git(repo, "rev-list", *args).decode().split()


def is_ancestor(repo, a, b):
    return git(repo, "merge-base", "--is-ancestor", a, b, check=False)[0] == 0


def diff_names(repo, a, b):
    """Changed paths between two commits, NUL-separated so non-ASCII and quoted names stay raw."""
    out = git(repo, "diff-tree", "-r", "--no-renames", "--name-only", "-z", a, b)
    return [p.decode("utf-8", "surrogateescape") for p in out.split(b"\0") if p]


def diff_raw(repo, a, b):
    """(old mode, new mode, status, path) for every change between two commits."""
    parts = git(repo, "diff-tree", "-r", "--no-renames", "--raw", "-z", a, b).split(b"\0")
    rows = []
    for i in range(0, len(parts) - 1, 2):
        old_mode, new_mode, _, _, status = parts[i].lstrip(b":").decode().split()
        rows.append((old_mode, new_mode, status, parts[i + 1].decode("utf-8", "surrogateescape")))
    return rows


def batch(repo, args, items):
    """Raw output of `git cat-file --batch...` for the given object names."""
    p = subprocess.run(["git", "-C", repo, "cat-file", *args], input=b"".join(i + b"\n" for i in items),
                       capture_output=True, env=GIT_ENV)
    need(p.returncode == 0, "git cat-file %s failed" % args[0])
    return p.stdout


def parse_tree(raw):
    ents, i = [], 0
    while i < len(raw):
        sp = raw.find(b" ", i)
        nul = raw.find(b"\0", sp + 1) if sp >= 0 else -1
        need(sp >= 0 and nul >= 0 and nul + 21 <= len(raw), "malformed tree object")
        ents.append((raw[i:sp], raw[sp + 1:nul]))
        i = nul + 21
    return ents


def check_trees(repo, base, head):
    """Every tree object introduced in BASE..REV must be canonical: valid modes, unique names, git sort order.

    A duplicate entry makes `git show REV:path` and a real checkout disagree, so it must never reach a verdict.
    """
    objs = [l.split(b" ")[0] for l in git(repo, "rev-list", "--objects", "%s..%s" % (base, head)).split(b"\n") if l]
    types = batch(repo, ["--batch-check=%(objectname) %(objecttype)"], objs).split(b"\n")
    trees = [l.split(b" ")[0] for l in types if l.endswith(b" tree")]
    data = batch(repo, ["--batch"], trees)
    pos = 0
    for _ in trees:
        nl = data.index(b"\n", pos)
        sha, _, size = data[pos:nl].split(b" ")
        raw = data[nl + 1:nl + 1 + int(size)]
        pos = nl + 1 + int(size) + 1
        names, last = set(), None
        for mode, name in parse_tree(raw):
            need(mode in VALID_MODES, "tree %s has an invalid mode" % sha[:12].decode())
            need(name not in (b"", b".", b"..") and name.lower() != b".git" and b"/" not in name,
                 "tree %s has a forbidden entry name" % sha[:12].decode())
            need(name not in names, "tree %s has a duplicate entry (%s)" % (sha[:12].decode(), name.decode("utf-8", "replace")))
            names.add(name)
            key = name + (b"/" if mode == b"40000" else b"")
            need(last is None or key > last, "tree %s is not in canonical order" % sha[:12].decode())
            last = key


def blob(repo, commit, path):
    rc, out = git(repo, "cat-file", "blob", "%s:%s" % (commit, path), check=False)
    return out if rc == 0 else None


def raw_commit(repo, c):
    return git(repo, "cat-file", "commit", c)


def split_commit(raw):
    head, sep, msg = raw.partition(b"\n\n")
    need(sep, "malformed commit object")
    lines = head.split(b"\n")
    keys = [l.split(b" ", 1)[0] for l in lines if not l.startswith(b" ")]
    return lines, keys, msg


def line_of(lines, key):
    return [l for l in lines if l.startswith(key + b" ")]


def tsv(data, cols, what):
    """Canonical TSV: LF only, final newline, no blank line, fixed column count."""
    if data == b"":
        return []
    need(data.endswith(b"\n") and b"\r" not in data and not data.startswith(b"\n") and b"\n\n" not in data,
         "%s is not canonical (missing final newline, blank line or CR)" % what)
    rows = []
    for ln in data.decode("utf-8").split("\n")[:-1]:
        f = ln.split("\t")
        need(len(f) == cols, "%s: malformed row %r" % (what, ln[:80]))
        rows.append(f)
    return rows


def pin_identity(pin_date):
    need(re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$", pin_date or ""), "--pin-date must be YYYY-MM-DDTHH:MM:SSZ")
    ts = datetime.datetime.strptime(pin_date, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    return PIN_IDENT + b" %d +0000" % int(ts.timestamp())


def only_path_tree(repo, tree, d):
    """Tree id under D when every level on the way holds exactly the one path component."""
    for comp in d.split("/"):
        ents = git(repo, "ls-tree", tree).decode().split("\n")
        ents = [e for e in ents if e]
        need(len(ents) == 1, "root of an imported commit holds more than %s" % d)
        mode_type, name = ents[0].split("\t")
        parts = mode_type.split()
        need(name == comp and parts[1] == "tree", "root of an imported commit holds more than %s" % d)
        tree = parts[2]
    return tree


class Base:
    """State committed at BASE."""

    def __init__(self, repo, base):
        fz = blob(repo, base, FROZEN)
        need(fz is not None, "BASE has no " + FROZEN)
        self.frozen_raw = fz
        self.frozen = tsv(fz, 4, "frozen.tsv at BASE")
        self.prods = [r[0] for r in self.frozen]
        self.xw = {p: self._xw(repo, base, p) for p in self.prods}
        tg = blob(repo, base, TAGS)
        need(tg is not None, "BASE has no " + TAGS)
        self.tags_raw = tg
        self.callbacks = {}
        for p in self.prods:
            cb = blob(repo, base, "tools/history/callbacks/%s.commit-callback.py" % p)
            need(cb is not None, "BASE has no commit callback for " + p)
            self.callbacks[p] = cb

    @staticmethod
    def _xw(repo, commit, prod):
        data = blob(repo, commit, "%s%s.tsv" % (XW_DIR, prod))
        need(data is not None, "no crosswalk for " + prod)
        return data


def parse_xw(data, prod):
    lines = data.split(b"\n")
    need(lines[0] == XW_HEADER, "%s crosswalk: bad header" % prod)
    need(lines[-1] == b"", "%s crosswalk: missing final newline" % prod)
    rows, olds, news = [], set(), set()
    for ln in lines[1:-1]:
        f = ln.decode("utf-8").split("\t")
        need(len(f) == 3 and SHA.match(f[0]) and SHA.match(f[1]), "%s crosswalk: malformed row" % prod)
        need(f[0] not in olds and f[1] not in news, "%s crosswalk: duplicate sha" % prod)
        olds.add(f[0])
        news.add(f[1])
        rows.append(f)
    need([r[0] for r in rows] == sorted(r[0] for r in rows), "%s crosswalk: rows not sorted by old_sha" % prod)
    return rows


def base_tip(repo, base, row):
    """Second parent of the newest import or re-import merge of the product reachable from BASE.

    Searches all reachable merges, not only the first-parent chain, so a BASE that is itself a PR merge of an
    earlier re-import (re-import merges on its second-parent side) works. Only merges by the pinned identity count.
    """
    d, name = row[1], row[2]
    pat = re.compile(r"^(?:Re-)?[Ii]mport %s history \(%s\)" % (re.escape(name), re.escape(d)))
    cands = []
    for ln in git(repo, "log", "--merges", "--format=%H\t%s", base).decode().split("\n"):
        if ln and pat.match(ln.split("\t", 1)[1]):
            c = ln.split("\t")[0]
            if line_of(split_commit(raw_commit(repo, c))[0], b"author")[0].startswith(b"author " + PIN_IDENT + b" "):
                cands.append(c)
    newest = [c for c in cands if not any(o != c and is_ancestor(repo, c, o) for o in cands)]
    need(len(newest) == 1, "no unique newest import merge for %s at BASE" % name)
    return rev(repo, newest[0] + "^2")


def run_callback(code, message, original_id):
    class C:
        pass
    c = C()
    c.message, c.original_id = message, original_id.encode("ascii")
    exec(compile(code, "commit-callback", "exec"), {"commit": c})
    return c.message


def verify(repo, base, head, o, allow_pr=True):
    ident = pin_identity(o.pin_date)
    out = {}

    # --- optional trailing GitHub PR merge --------------------------------------------------------------
    parents = git(repo, "rev-list", "--parents", "-n", "1", head).decode().split()[1:]
    if allow_pr and head != base and len(parents) == 2 and parents[0] == base and is_ancestor(repo, base, parents[1]) \
            and parents[1] != base:
        lines, keys, msg = split_commit(raw_commit(repo, head))
        need(keys in ([b"tree", b"parent", b"parent", b"author", b"committer"],
                      [b"tree", b"parent", b"parent", b"author", b"committer", b"gpgsig"]),
             "PR merge has unexpected headers")
        need(GITHUB_COMMITTER_LINE.match(lines[4]) is not None, "PR merge is not committed by GitHub")
        need(AUTHOR_LINE.match(lines[3]) is not None, "PR merge has a malformed author line")
        need(msg.strip() != b"", "PR merge has an empty message")
        need(rev(repo, head + "^{tree}") == rev(repo, parents[1] + "^{tree}"), "PR merge tree differs from its second parent")
        out = verify(repo, base, parents[1], o, allow_pr=False)
        out["pr_merge"] = head
        return out

    if head == base:
        chain = []
    else:
        need(is_ancestor(repo, base, head), "BASE is not an ancestor of REV")
        chain = shas(repo, "--first-parent", "--reverse", "%s..%s" % (base, head))
        need(chain, "no commits between BASE and REV")
        need(rev(repo, chain[0] + "^") == base, "BASE is not on the first-parent chain of REV")
    meta = None
    if chain and len(git(repo, "rev-list", "--parents", "-n", "1", chain[-1]).split()) == 2:
        meta = chain.pop()
    merges = chain
    for c in merges:
        need(len(git(repo, "rev-list", "--parents", "-n", "1", c).split()) == 3,
             "first-parent chain holds a commit that is not a re-import merge (%s)" % c[:12])

    st = Base(repo, base)
    need(sorted(shas(repo, "--max-parents=0", head)) == sorted(shas(repo, "--max-parents=0", base)),
         "parentless commits changed")
    need(not merges or o.src_base, "re-import merges present: --src-base is required")

    # --- re-import merges ---------------------------------------------------------------------------------
    cur = {r[0]: r[3] for r in st.frozen}
    tips = {r[0]: base_tip(repo, base, r) for r in st.frozen}
    pairs = {p: [] for p in st.prods}      # (source sha, imported sha) expected per product
    imported_all = set()
    prev = base
    for m in merges:
        raw = raw_commit(repo, m)
        lines, keys, msg = split_commit(raw)
        mm = MERGE_SUBJECT.match(msg)
        need(mm, "re-import merge %s has an unexpected message" % m[:12])
        name, d, old12, new12 = (g.decode() for g in mm.groups())
        row = [r for r in st.frozen if r[2] == name and r[1] == d]
        need(len(row) == 1, "re-import merge %s names an unknown product (%s)" % (m[:12], name))
        prod = row[0][0]
        need(cur[prod].startswith(old12), "re-import merge for %s does not continue from its frozen sha" % prod)
        src = "%s/%s.git" % (o.src_base, name)
        new = rev(repo=src, spec=new12 + "^{commit}")
        need(new != cur[prod] and is_ancestor(src, cur[prod], new), "%s: %s is not a fast-forward of %s" % (name, new12, old12))
        p1, p2 = git(repo, "rev-list", "--parents", "-n", "1", m).decode().split()[1:]
        need(p1 == prev, "re-import merge %s does not follow the previous commit" % m[:12])
        expect = (b"tree " + rev(repo, m + "^{tree}").encode() + b"\nparent " + p1.encode() + b"\nparent " + p2.encode() +
                  b"\nauthor " + ident + b"\ncommitter " + ident + b"\n\n" + msg)
        need(raw == expect, "re-import merge %s differs from its expected bytes (headers, identity or date)" % m[:12])
        changed = diff_names(repo, p1, m)
        need(all(c.startswith(d + "/") for c in changed), "%s merge changes paths outside %s/" % (prod, d))
        need(rev(repo, "%s:%s" % (m, d)) == rev(src, new + "^{tree}"), "%s merge subtree != source %s tree" % (prod, new12))
        need(rev(repo, "%s:%s" % (p2, d)) == rev(repo, "%s:%s" % (m, d)), "%s merge subtree != second parent subtree" % prod)
        only_path_tree(repo, rev(repo, p2 + "^{tree}"), d)
        imported = set(shas(repo, p2, "--not", p1))
        srcs = shas(src, "--topo-order", new, "--not", cur[prod])
        need(len(srcs) == len(imported), "%s: %d imported commits for %d source commits" % (prod, len(imported), len(srcs)))
        pairs[prod].append((srcs, imported, p2, new))
        imported_all |= imported
        cur[prod], tips[prod], prev = new, p2, m
    out["merges"] = len(merges)

    accounted = set(chain) | imported_all | ({meta} if meta else set())
    need(set(shas(repo, "%s..%s" % (base, head))) == accounted, "REV holds commits that are not re-import commits")
    if head != base:
        check_trees(repo, base, head)

    # --- metadata commit ------------------------------------------------------------------------------------
    meta_files = [FROZEN, TAGS] + ["%s%s.tsv" % (XW_DIR, p) for p in st.prods]
    if meta:
        raw = raw_commit(repo, meta)
        (mp,) = git(repo, "rev-list", "--parents", "-n", "1", meta).decode().split()[1:]
        need(mp == prev, "metadata commit does not follow the last merge")
        _, _, msg = split_commit(raw)
        expect = (b"tree " + rev(repo, meta + "^{tree}").encode() + b"\nparent " + mp.encode() + b"\nauthor " + ident +
                  b"\ncommitter " + ident + b"\n\n" + META_MESSAGE)
        need(raw == expect, "metadata commit differs from its expected bytes (headers, identity, date or message)")
        for old_mode, new_mode, status, path in diff_raw(repo, mp, meta):
            need(path in meta_files + [SELF], "metadata commit touches %s outside the allowlist" % path)
            need(status in ("A", "M"), "metadata commit deletes or retypes %s" % path)
            if path == SELF:
                need(blob(repo, mp, SELF) is None, "metadata commit modifies a verifier that BASE already contains")
                need(new_mode == "100755", "verifier must be mode 755")
    outside = diff_names(repo, base, head)
    dirs = [r[1] + "/" for r in st.frozen]
    for p in outside:
        need(p in meta_files + [SELF] or any(p.startswith(d) for d in dirs), "REV changes %s outside the allowlist" % p)

    # --- frozen.tsv -----------------------------------------------------------------------------------------
    fz = blob(repo, head, FROZEN)
    need(fz is not None, "REV has no " + FROZEN)
    head_frozen = tsv(fz, 4, "frozen.tsv")
    need(all(SHA.match(r[3]) for r in head_frozen), "frozen.tsv: malformed sha")
    for path in meta_files:
        ent = git(repo, "ls-tree", head, "--", path).decode().split()
        need(ent and ent[0] == "100644" and ent[1] == "blob", "%s must be a regular file with mode 100644" % path)
    ent = git(repo, "ls-tree", head, "--", SELF).decode().split()
    need(not ent or (ent[0] == "100755" and ent[1] == "blob"), "verifier must be a regular file with mode 100755")
    need(len(head_frozen) == len(st.frozen), "frozen.tsv: row count changed")
    for a, b in zip(st.frozen, head_frozen):
        need(a[:3] == b[:3], "frozen.tsv: columns or order changed (%s)" % a[0])
        need(b[3] == cur[a[0]], "frozen.tsv %s does not match the re-import merges" % a[0])

    # --- crosswalk ------------------------------------------------------------------------------------------
    full_old = {}          # old sha -> new sha, all products
    tag_rows = tsv(blob(repo, head, TAGS) or b"", 5, "tags.tsv")
    base_tag_rows = tsv(st.tags_raw, 5, "tags.tsv at BASE")
    for p in st.prods:
        name = [r[2] for r in st.frozen if r[0] == p][0]
        d = [r[1] for r in st.frozen if r[0] == p][0]
        data = blob(repo, head, "%s%s.tsv" % (XW_DIR, p))
        need(data is not None, "REV has no crosswalk for " + p)
        rows, brows = parse_xw(data, p), parse_xw(st.xw[p], p)
        hmap = {r[0]: r for r in rows}
        for r in brows:
            need(r[0] in hmap and hmap[r[0]][1] == r[1], "%s crosswalk: committed mapping %s changed or removed" % (p, r[0][:12]))
        added = [r for r in rows if r[0] not in {b[0] for b in brows}]
        full_old.update({r[0]: r[1] for r in rows})
        exp_pairs = [(s, i, p2, new) for (s, i, p2, new) in pairs[p]]
        exp_src = {s for (srcs, _, _, _) in exp_pairs for s in srcs}
        exp_new = set().union(*[i for (_, i, _, _) in exp_pairs]) if exp_pairs else set()
        need({r[0] for r in added} == exp_src, "%s crosswalk: added rows are not the commits the merges import" % p)
        need({r[1] for r in added} == exp_new, "%s crosswalk: added new shas are not the imported commits" % p)
        need({r[1] for r in rows} == set(shas(repo, tips[p])), "%s crosswalk does not cover every commit reachable from its imported tip" % p)
        if o.src_base:
            src = "%s/%s.git" % (o.src_base, name)
            need({r[0] for r in rows} == set(shas(src, cur[p])), "%s crosswalk does not cover every source commit" % p)
        for (srcs, imported, p2, new) in exp_pairs:
            need(hmap[new][1] == p2, "%s: merge second parent is not the crosswalked tip of %s" % (p, new[:12]))
        # old_tags must agree with tags.tsv (no phantom or cleared tags)
        for r in rows:
            names = sorted(t[1][len("refs/tags/"):] for t in tag_rows if t[0] == p and t[3] == r[0])
            need(r[2] == ",".join(names), "%s crosswalk: old_tags of %s disagree with tags.tsv" % (p, r[0][:12]))
        out["crosswalk." + p] = "%d rows (+%d)" % (len(rows), len(added))

    # imported commits rebuilt byte for byte from their sources (W1)
    for p in st.prods:
        name = [r[2] for r in st.frozen if r[0] == p][0]
        d = [r[1] for r in st.frozen if r[0] == p][0]
        for (srcs, imported, p2, new) in pairs[p]:
            src = "%s/%s.git" % (o.src_base, name)
            for s in srcs:
                n = full_old[s]
                need(n in imported, "%s: crosswalk target of %s is not imported by the merge" % (p, s[:12]))
                lines, _, smsg = split_commit(raw_commit(src, s))
                par = [l.split(b" ")[1].decode() for l in line_of(lines, b"parent")]
                need(all(x in full_old for x in par), "%s: a parent of %s is not crosswalked" % (p, s[:12]))
                body = [b"tree " + rev(repo, n + "^{tree}").encode()]
                body += [b"parent " + full_old[x].encode() for x in par]
                body += line_of(lines, b"author") + line_of(lines, b"committer")
                msg = run_callback(st.callbacks[p], smsg, s)
                expect = b"\n".join(body) + b"\n\n" + msg
                need(raw_commit(repo, n) == expect, "%s: imported commit %s differs from its source %s (headers, parents, identity or message)" % (p, n[:12], s[:12]))
                need(only_path_tree(repo, rev(repo, n + "^{tree}"), d) == rev(src, s + "^{tree}"), "%s: tree of %s != source tree" % (p, n[:12]))

    # --- tags -----------------------------------------------------------------------------------------------
    lines = ["\t".join(r) for r in tag_rows]
    need(lines == sorted(lines) and len(set(lines)) == len(lines), "tags.tsv rows are not sorted and unique")
    base_set = {tuple(r) for r in base_tag_rows}
    need(base_set <= {tuple(r) for r in tag_rows}, "tags.tsv: a committed tag row changed or was removed")
    approved = set()
    if o.approved_tags:
        for ln in open(o.approved_tags, encoding="utf-8").read().split("\n"):
            if ln:
                f = ln.split("\t")
                need(len(f) == 3, "approved-tags line is malformed")
                approved.add(tuple(f))
    for r in tag_rows:
        if tuple(r) in base_set:
            continue
        prod, src_ref, new_ref, old_c, new_c = r
        need((prod, src_ref, old_c) in approved, "new tag %s is not owner-approved" % src_ref)
        need(new_ref == "refs/tags/%s/%s" % (prod, src_ref[len("refs/tags/"):]), "new tag %s has a wrong new ref" % src_ref)
        need(full_old.get(old_c) == new_c, "new tag %s does not map through the crosswalk" % src_ref)
        if o.src_base:
            name = [x[2] for x in st.frozen if x[0] == prod][0]
            src = "%s/%s.git" % (o.src_base, name)
            need(git(src, "for-each-ref", "--format=%(objecttype) %(objectname)", src_ref).decode().strip() == "commit " + old_c,
                 "new tag %s is not a lightweight tag on %s in the source" % (src_ref, old_c[:12]))
    refs = {}
    for ln in git(repo, "for-each-ref", "--format=%(refname) %(objectname) %(objecttype)", "refs/tags").decode().split("\n"):
        if ln:
            refname, oid, otype = ln.split(" ")
            need(otype == "commit", "tag %s is annotated" % refname)
            refs[refname] = oid
    need(refs == {r[2]: r[4] for r in tag_rows}, "tag refs differ from tags.tsv (unknown, missing or retargeted tags)")
    out["tags"] = "%d (+%d)" % (len(tag_rows), len(tag_rows) - len(base_set))
    out["head"] = head
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("repo")
    ap.add_argument("base")
    ap.add_argument("rev", nargs="?", default="HEAD")
    ap.add_argument("--pin-date", required=True)
    ap.add_argument("--src-base")
    ap.add_argument("--approved-tags")
    o = ap.parse_args()
    try:
        base, head = rev(o.repo, o.base + "^{commit}"), rev(o.repo, o.rev + "^{commit}")
        out = verify(o.repo, base, head, o)
    except Fail as e:
        print("FAIL: %s" % e, file=sys.stderr)
        return 1
    out["base"] = base
    for k in sorted(out):
        print("%s\t%s" % (k, out[k]))
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
