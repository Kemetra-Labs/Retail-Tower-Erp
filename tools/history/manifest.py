#!/usr/bin/env python3
"""Verify the shadow build and print the checksummed output manifest (key<TAB>value, sorted sections). Fails closed."""
import hashlib
import os
import subprocess
import sys

out, here, fr, pin_name, pin_email, pin_date = sys.argv[1:7]
shadow = out + "/shadow"
lines = []


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout.strip()


def sha256(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def fail(msg):
    sys.exit("FAIL: " + msg)


def put(k, v):
    lines.append("%s\t%s" % (k, v))


products = [l.rstrip("\n").split("\t") for l in open(here + "/frozen.tsv", encoding="utf-8") if l.strip()]
ids = {l.rstrip("\n").split("\t")[1]: l.split("\t")[0] for l in open(here + "/inputs/repo-ids.tsv", encoding="utf-8") if l.strip()}

# --- pins -----------------------------------------------------------------------------------------------
put("pin.git", git(".", "--version"))
put("pin.python", sys.version.split()[0])
put("pin.filter-repo.version", subprocess.run(["python3", fr, "--version"], capture_output=True, text=True).stdout.strip())
put("pin.filter-repo.sha256", sha256(fr))
put("pin.identity", "%s <%s> %s" % (pin_name, pin_email, pin_date))
put("pin.filter-options", "--to-subdirectory-filter --tag-rename :<product>/ --commit-callback --preserve-commit-hashes --prune-empty never --prune-degenerate never")
put("pin.source-order", ",".join(p[0] for p in products))
for f in ("build.sh", "frozen.tsv", "inventory.py", "mkcrosswalk.py", "manifest.py", "scan.py", "README.md"):
    put("script.sha256." + f, sha256(os.path.join(here, f)))

# --- inputs + per-product checks ----------------------------------------------------------------------------
allowed = {"refs/heads/main"}
total_src = 0
for prod, d, repo, sha in products:
    src = "%s/src/%s.git" % (out, prod)
    ftree = git(src, "rev-parse", sha + "^{tree}")
    stree = git(shadow, "rev-parse", "main:" + d)
    if ftree != stree:
        fail("tree mismatch %s: source %s shadow %s" % (prod, ftree, stree))
    n_src = int(git(src, "rev-list", "--count", "--all"))
    n_cross = sum(1 for _ in open("%s/tools-crosswalk-%s" % (out, prod), encoding="utf-8")) - 1 if False else \
        sum(1 for _ in open("%s/evidence/%s.crosswalk.tsv" % (out, prod), encoding="utf-8")) - 1
    if n_src != n_cross:
        fail("crosswalk count %s: %d vs %d" % (prod, n_cross, n_src))
    total_src += n_src
    refs_tsv = "%s/evidence/%s.refs.tsv" % (out, prod)
    rows = [l.rstrip("\n").split("\t") for l in open(refs_tsv, encoding="utf-8")][1:]
    n_tags = sum(1 for r in rows if r[0].startswith("refs/tags/"))
    for r in rows:
        if r[0].startswith("refs/tags/"):
            allowed.add("refs/tags/%s/%s" % (prod, r[0][len("refs/tags/"):]))
    put("input.%s.repo" % prod, "Kemetra/%s id=%s" % (repo, ids.get("Kemetra/" + repo, "?")))
    put("input.%s.frozen-main" % prod, sha)
    put("input.%s.frozen-tree" % prod, ftree)
    put("input.%s.shadow-subtree(%s)" % (prod, d), stree)
    put("input.%s.reachable-commits" % prod, n_src)
    put("input.%s.crosswalk-rows" % prod, n_cross)
    put("input.%s.tags" % prod, n_tags)
    put("input.%s.refs-listing.sha256" % prod, sha256("%s/inputs/refs-%s.txt" % (here, repo)))
    put("input.%s.refs-inventory.sha256" % prod, sha256(refs_tsv))
    put("input.%s.crosswalk.sha256" % prod, sha256("%s/evidence/%s.crosswalk.tsv" % (out, prod)))
    put("input.%s.commit-callback.sha256" % prod, sha256("%s/work/%s.commit-callback.py" % (out, prod)))
    cnt = {}
    for r in rows:
        k = (r[2], r[3])
        cnt[k] = cnt.get(k, 0) + 1
    for (disp, why), c in sorted(cnt.items()):
        put("input.%s.refs.%s(%s)" % (prod, disp, why), c)

# --- output refs: exactly the allowlist ----------------------------------------------------------------------
fer = git(shadow, "for-each-ref", "--format=%(refname) %(objecttype) %(objectname) %(*objectname)").splitlines()
got = {l.split()[0] for l in fer}
if got != allowed:
    fail("ref set != allowlist; extra=%s missing=%s" % (sorted(got - allowed)[:5], sorted(allowed - got)[:5]))
put("output.ref-count", len(got))
for l in sorted(fer):
    parts = l.split()
    put("output.ref." + parts[0], "%s %s" % (parts[1], parts[2]))

# --- output commits ------------------------------------------------------------------------------------------------------
all_roots = git(shadow, "rev-list", "--max-parents=0", "--all").split()
roots = [git(shadow, "rev-list", "--first-parent", "main").split()[-1]]
if len(set(all_roots)) != 1 + len(products):
    fail("expected %d parentless commits (empty root + product roots), got %d" % (1 + len(products), len(set(all_roots))))
if git(shadow, "rev-parse", roots[0] + "^{tree}") != "4b825dc642cb6eb9a060e54bf8d69288fbee4904":
    fail("first-parent root is not the empty tree")
merges = git(shadow, "rev-list", "--first-parent", "--merges", "--reverse", "main").split()
if len(merges) != len(products):
    fail("expected %d merges, got %d" % (len(products), len(merges)))
head = git(shadow, "rev-parse", "main")
if git(shadow, "rev-parse", "main^") != merges[-1]:
    fail("overlay is not directly on the last merge")
for c in [roots[0]] + merges + [head]:
    ident = git(shadow, "log", "-1", "--format=%an <%ae> %aI|%cn <%ce> %cI", c).split("|")
    want = "%s <%s> %s" % (pin_name, pin_email, "2026-10-19T00:00:00+00:00")
    if ident[0] != want or ident[1] != want:
        fail("identity not pinned on %s: %s" % (c, ident))
put("output.root-commit", roots[0])
put("output.root-tree", git(shadow, "rev-parse", roots[0] + "^{tree}"))
for (prod, *_), m in zip(products, merges):
    put("output.merge-commit.%s" % prod, m)
    put("output.merge-tree.%s" % prod, git(shadow, "rev-parse", m + "^{tree}"))
put("output.overlay-commit", head)
put("output.main-tree", git(shadow, "rev-parse", "main^{tree}"))
changed = git(shadow, "diff", "--name-status", merges[-1], "main").splitlines()
bad = [c for c in changed if not (c.startswith("A\ttools/history/"))]
if bad:
    fail("overlay touches outside tools/history: %s" % bad[:3])
put("output.overlay-files", len(changed))
total = int(git(shadow, "rev-list", "--count", "--all"))
if total != total_src + 1 + len(products) + 1:
    fail("commit count %d != %d" % (total, total_src + 1 + len(products) + 1))
put("output.commit-count", total)
allc = set(git(shadow, "rev-list", "--all").split())
for prod, *_ in products:
    for l in list(open("%s/evidence/%s.crosswalk.tsv" % (out, prod), encoding="utf-8"))[1:]:
        if l.split("\t")[1] not in allc:
            fail("crosswalk new_sha not in shadow: %s" % l.split("\t")[1])
put("output.object-count", git(shadow, "count-objects", "-v").split("in-pack: ")[1].split()[0] if False else
    len(subprocess.run(["git", "-C", shadow, "rev-list", "--all", "--objects"], capture_output=True, text=True).stdout.splitlines()))
put("output.scan-report.sha256", sha256(out + "/evidence/scan-report.txt"))

print("\n".join(lines))
