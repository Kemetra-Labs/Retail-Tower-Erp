#!/usr/bin/env python3
"""Crosswalk old->new for every imported commit and tag of one product."""
import subprocess
import sys

src, work, prod, outdir = sys.argv[1:5]


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout


old_commits = set(git(src, "rev-list", "--all").split())
cmap = {}
for line in open(work + "/filter-repo/commit-map", encoding="ascii"):
    a, b = line.split()
    if a == "old":
        continue
    cmap[a] = b
missing = old_commits - set(cmap)
zero = [a for a, b in cmap.items() if set(b) == {"0"}]
if missing or zero:
    sys.exit("FAIL: %s crosswalk incomplete: %d missing, %d pruned" % (prod, len(missing), len(zero)))
new_all = set(git(work, "rev-list", "--all").split())
if set(cmap.values()) != new_all:
    sys.exit("FAIL: %s commit-map does not match rewritten history" % prod)

tags_by_commit, tag_rows = {}, []
for line in open(outdir + "/%s.tags-old.txt" % prod, encoding="utf-8"):
    parts = line.split()
    ref, otype, oid = parts[0], parts[1], parts[2]
    commit = parts[3] if otype == "tag" else oid
    name = ref[len("refs/tags/"):]
    new_ref = "refs/tags/%s/%s" % (prod, name)
    new_target = git(work, "rev-parse", new_ref + "^{commit}").strip()
    if cmap[commit] != new_target:
        sys.exit("FAIL: tag %s target mismatch" % ref)
    tags_by_commit.setdefault(commit, []).append(name)
    tag_rows.append("\t".join([prod, ref, new_ref, commit, new_target]))

with open(outdir + "/%s.crosswalk.tsv" % prod, "w", encoding="utf-8", newline="\n") as f:
    f.write("old_sha\tnew_sha\told_tags\n")
    for old in sorted(cmap):
        f.write("%s\t%s\t%s\n" % (old, cmap[old], ",".join(sorted(tags_by_commit.get(old, [])))))
with open(outdir + "/%s.tags.tsv" % prod, "w", encoding="utf-8", newline="\n") as f:
    for r in sorted(tag_rows):
        f.write(r + "\n")
print("%s: %d commits, %d tags crosswalked" % (prod, len(cmap), len(tag_rows)), file=sys.stderr)
