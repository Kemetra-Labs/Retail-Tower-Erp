#!/usr/bin/env python3
"""Lightweight reproducible triage scan of every blob in the shadow history. Prints counts and blob/path locations, never matched values.
This is NOT a substitute for the gitleaks/trufflehog full-history gate required before any public push."""
import re
import subprocess
import sys

shadow = sys.argv[1]
PATTERNS = {
    "private-key-header": re.compile(rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY"),
    "aws-access-key-id": re.compile(rb"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    "github-token": re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b"),
    "slack-token": re.compile(rb"\bxox[baprs]-[A-Za-z0-9-]{10,}"),
    "google-api-key": re.compile(rb"\bAIza[0-9A-Za-z_-]{35}\b"),
    "jwt-like": re.compile(rb"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    "lfs-pointer": re.compile(rb"^version https://git-lfs\.github\.com/spec/v1", re.M),
    "lfs-attribute": re.compile(rb"filter=lfs"),
}
NAME_PATTERNS = {
    "sensitive-filename": re.compile(r"(^|/)(\.env(\.(?!example|sample|template)[^/]*)?|id_rsa|id_ed25519|\.git-credentials|\.npmrc|\.pypirc|[^/]*\.(pem|p12|pfx|key|kdbx|jks|keystore))$"),
}
MAX_SCAN = 5 * 1024 * 1024

objs = subprocess.run(["git", "-C", shadow, "rev-list", "--all", "--objects"], check=True, capture_output=True, text=True).stdout.splitlines()
names = {}
for l in objs:
    p = l.split(" ", 1)
    if len(p) == 2:
        names.setdefault(p[0], p[1])
inp = "\n".join(sorted(names)) + "\n"
chk = subprocess.run(["git", "-C", shadow, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
                     input=inp, check=True, capture_output=True, text=True).stdout.splitlines()
blobs = [(c.split()[0], int(c.split()[2])) for c in chk if c.split()[1] == "blob"]
print("blobs-with-path: %d" % len(blobs))

hits = {k: [] for k in list(PATTERNS) + list(NAME_PATTERNS) + ["blob-over-5MB", "binary-image-blobs"]}
proc = subprocess.Popen(["git", "-C", shadow, "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
for oid, size in sorted(blobs):
    proc.stdin.write((oid + "\n").encode())
    proc.stdin.flush()
    header = proc.stdout.readline().split()
    data = proc.stdout.read(int(header[2]))
    proc.stdout.read(1)
    path = names[oid]
    if path.startswith("tools/history/"):
        continue  # the import tooling overlay is not product content
    for k, rx in NAME_PATTERNS.items():
        if rx.search(path):
            hits[k].append((oid, path))
    if re.search(r"\.(png|jpe?g|gif|webp)$", path, re.I):
        hits["binary-image-blobs"].append((oid, path))
    if size > MAX_SCAN:
        hits["blob-over-5MB"].append((oid, path))
        continue
    for k, rx in PATTERNS.items():
        if rx.search(data):
            hits[k].append((oid, path))
proc.stdin.close()
proc.wait()
for k in sorted(hits):
    print("%s: %d" % (k, len(hits[k])))
    for oid, path in sorted(hits[k], key=lambda t: t[1])[:15]:
        print("    %s %s" % (oid[:12], path))
