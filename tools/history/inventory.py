#!/usr/bin/env python3
"""Classify every live ref of a source repo (R4 allowlist). Fails closed on unknown namespaces."""
import re
import sys

listing, prod, main_sha, out = sys.argv[1:5]
rows = []
for line in open(listing, encoding="utf-8"):
    oid, ref = line.rstrip("\n").split("\t")
    if ref.endswith("^{}"):
        sys.exit("FAIL: peeled tag entry %s (annotated tag) needs review" % ref)
    if ref == "HEAD":
        if oid != main_sha:
            sys.exit("FAIL: HEAD %s != frozen main %s" % (oid, main_sha))
        rows.append((ref, oid, "EXCLUDED", "symbolic alias of refs/heads/main"))
    elif ref == "refs/heads/main":
        if oid != main_sha:
            sys.exit("FAIL: listing main %s != frozen %s" % (oid, main_sha))
        rows.append((ref, oid, "IMPORTED", "allowlisted: main"))
    elif ref.startswith("refs/tags/"):
        rows.append((ref, oid, "IMPORTED", "allowlisted: release tag"))
    elif ref.startswith("refs/heads/"):
        rows.append((ref, oid, "EXCLUDED", "non-main branch, not on the allowlist"))
    elif re.match(r"refs/pull/\d+/(head|merge)$", ref):
        rows.append((ref, oid, "EXCLUDED", "pull request ref"))
    else:
        sys.exit("FAIL: unknown ref namespace %s (STOP, classify before publication)" % ref)
rows.sort()
with open(out, "w", encoding="utf-8", newline="\n") as f:
    f.write("ref\toid\tdisposition\treason\n")
    for r in rows:
        f.write("\t".join(r) + "\n")
