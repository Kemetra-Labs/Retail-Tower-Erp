#!/usr/bin/env python3
"""Release manifest for one product of the monorepo (RT-871, MR-1).

Every run of a root release workflow (.github/workflows/release-*.yml), dry-run or release,
writes three files to --out:

  release-manifest.json   source SHA, product tree hash (`git rev-parse <sha>:<product path>`),
                          artifact digests, contract snapshot, CI URL, mode/tag and, for
                          Backend-Core, the compat guard verdict (MR-3);
  provenance.intoto.json  an UNSIGNED in-toto Statement (SLSA provenance v1 predicate) over the
                          same artifacts. Signing and publication belong to the publish job (RT-717);
  SHA256SUMS              of the two files above.

Contract snapshot: the Backend-Core contract tree hash at the SHA (MR-2, the only contract
source), plus the consumer's pinned copy where one exists (POS and Admin-Console
`contracts/backend-core/PIN`: blob hash, pinned repo and commit) and, for the Connector, the
tree hashes of the two contract directories it mirrors (graph.yaml `edges`, kind: semantic).

Reads git objects only (never the working tree), stdlib only, fails closed: any value it
cannot read is an error, never an empty field. Exit 0 = written, 2 = refused.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

SCHEMA = "retail-tower/release-manifest/v1"
CONTRACTS = "services/backend-core/packages/contracts/openapi"
PRODUCTS = {
    "pos": {"path": "apps/pos", "pin": "apps/pos/contracts/backend-core/PIN"},
    "admin-console": {"path": "apps/admin-console", "pin": "apps/admin-console/contracts/backend-core/PIN"},
    "backend-core": {"path": "services/backend-core"},
    "erpnext-connector": {
        "path": "integrations/erpnext-connector",
        "semantic": [f"{CONTRACTS}/erpnext-connector", f"{CONTRACTS}/connector"],
    },
}
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")
COMPAT_VERDICTS = ("PASS", "REFUSED", "MISSING")


class Refusal(Exception):
    pass


def git(repo, *args):
    proc = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise Refusal(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def object_id(repo, sha, path, kind):
    oid = git(repo, "rev-parse", "--verify", "-q", f"{sha}:{path}").strip()
    if git(repo, "cat-file", "-t", oid).strip() != kind:
        raise Refusal(f"{path} at {sha[:12]} is not a {kind}")
    return oid


def parse_pin(text, path):
    fields = {}
    for line in text.splitlines():
        m = re.match(r"^(repo|commit|source):\s*(\S+)\s*$", line)
        if m:
            fields[m[1]] = m[2]
    if not SHA_RE.match(fields.get("commit", "")) or "repo" not in fields:
        raise Refusal(f"{path}: no `repo:` and 40-hex `commit:` line")
    return fields


def contract_snapshot(repo, sha, product):
    spec = PRODUCTS[product]
    snap = {"backend_core_contract_path": CONTRACTS, "backend_core_contract_tree": object_id(repo, sha, CONTRACTS, "tree")}
    if "pin" in spec:
        pin = parse_pin(git(repo, "show", f"{sha}:{spec['pin']}"), spec["pin"])
        snap["consumer_pin"] = {
            "path": spec["pin"],
            "blob": object_id(repo, sha, spec["pin"], "blob"),
            "repo": pin["repo"],
            "commit": pin["commit"],
            "source": pin.get("source"),
        }
    if "semantic" in spec:
        snap["semantic_contract_trees"] = {p: object_id(repo, sha, p, "tree") for p in spec["semantic"]}
    return snap


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return "sha256:" + h.hexdigest()


def split_pair(value, flag):
    name, sep, rest = value.partition("=")
    if not sep or not NAME_RE.match(name) or not rest:
        raise Refusal(f"{flag} {value!r}: expected NAME=VALUE")
    return name, rest


def collect_artifacts(files, digests):
    out = {}
    for value in files:
        name, path = split_pair(value, "--artifact")
        if not os.path.isfile(path) or os.path.islink(path):
            raise Refusal(f"artifact {name}: {path} is not a regular file")
        if name in out:
            raise Refusal(f"artifact {name} given twice")
        out[name] = {"name": name, "file": os.path.basename(path), "bytes": os.path.getsize(path), "digest": sha256_file(path)}
    for value in digests:
        name, digest = split_pair(value, "--artifact-digest")
        if not DIGEST_RE.match(digest):
            raise Refusal(f"artifact {name}: digest {digest!r} is not sha256:<64 hex>")
        if name in out:
            # a file artifact that is also an image (OCI layout): its manifest digest
            if "image_digest" in out[name]:
                raise Refusal(f"artifact {name}: digest given twice")
            out[name]["image_digest"] = digest
        else:
            out[name] = {"name": name, "digest": digest}
    if not out:
        raise Refusal("no artifact given")
    return [out[k] for k in sorted(out)]


def build(args):
    if args.product not in PRODUCTS:
        raise Refusal(f"unknown product {args.product!r}")
    if not SHA_RE.match(args.sha):
        raise Refusal("--sha must be 40 lowercase hex")
    if args.mode == "release":
        if not re.match(rf"^{re.escape(args.product)}/v\d+\.\d+\.\d+$", args.tag or ""):
            raise Refusal(f"release mode needs --tag {args.product}/vX.Y.Z")
    elif args.tag:
        raise Refusal("a dry-run has no tag")
    if not args.ci_url.startswith("https://"):
        raise Refusal("--ci-url must be an https URL")
    repo = args.repo
    commit = git(repo, "rev-parse", "--verify", "-q", f"{args.sha}^{{commit}}").strip()
    if commit != args.sha:
        raise Refusal(f"{args.sha} is not a commit")
    path = PRODUCTS[args.product]["path"]
    manifest = {
        "schema": SCHEMA,
        "product": args.product,
        "mode": args.mode,
        "tag": args.tag,
        "published": False,
        "source": {
            "repository": args.repository,
            "sha": args.sha,
            "product_path": path,
            "product_tree": object_id(repo, args.sha, path, "tree"),
        },
        "artifacts": collect_artifacts(args.artifact, args.artifact_digest),
        "contract_snapshot": contract_snapshot(repo, args.sha, args.product),
        "ci_url": args.ci_url,
    }
    if args.product == "backend-core":
        if args.compat_verdict not in COMPAT_VERDICTS:
            raise Refusal("backend-core needs --compat-verdict PASS|REFUSED|MISSING (MR-3)")
        if args.mode == "release" and args.compat_verdict != "PASS":
            raise Refusal(f"backend-core release refused: compat guard is {args.compat_verdict} (MR-3)")
        manifest["compat_gate"] = {"verdict": args.compat_verdict, "evidence": args.compat_evidence or ""}
    elif args.compat_verdict:
        raise Refusal("--compat-verdict applies to backend-core only")
    for value in args.note:
        key, text = split_pair(value, "--note")
        manifest.setdefault("notes", {})[key] = text
    return manifest


def provenance(manifest):
    return {
        "_type": "https://in-toto.io/Statement/v1",
        "subject": [{"name": a["name"], "digest": {"sha256": a["digest"].split(":", 1)[1]}} for a in manifest["artifacts"]],
        "predicateType": "https://slsa.dev/provenance/v1",
        "predicate": {
            "buildDefinition": {
                "buildType": "https://github.com/Kemetra/Retail-Tower-Shadow/.github/workflows/release",
                "externalParameters": {"product": manifest["product"], "mode": manifest["mode"], "tag": manifest["tag"]},
                "resolvedDependencies": [{
                    "uri": f"git+https://github.com/{manifest['source']['repository']}",
                    "digest": {"gitCommit": manifest["source"]["sha"]},
                }],
            },
            "runDetails": {"builder": {"id": manifest["ci_url"]}, "metadata": {"signed": False}},
        },
    }


def write(out_dir, manifest):
    os.makedirs(out_dir, exist_ok=True)
    files = {"release-manifest.json": manifest, "provenance.intoto.json": provenance(manifest)}
    sums = []
    for name, data in files.items():
        path = os.path.join(out_dir, name)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
            fh.write("\n")
        sums.append(f"{sha256_file(path).split(':', 1)[1]}  {name}\n")
    with open(os.path.join(out_dir, "SHA256SUMS"), "w", encoding="utf-8", newline="\n") as fh:
        fh.writelines(sums)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--product", required=True)
    p.add_argument("--sha", required=True)
    p.add_argument("--mode", required=True, choices=["dry-run", "release"])
    p.add_argument("--tag")
    p.add_argument("--repo", default=".")
    p.add_argument("--repository", required=True, help="OWNER/REPO")
    p.add_argument("--artifact", action="append", default=[], metavar="NAME=FILE")
    p.add_argument("--artifact-digest", action="append", default=[], metavar="NAME=sha256:HEX")
    p.add_argument("--ci-url", required=True)
    p.add_argument("--compat-verdict")
    p.add_argument("--compat-evidence")
    p.add_argument("--note", action="append", default=[], metavar="KEY=TEXT")
    p.add_argument("--out", required=True)
    a = p.parse_args(argv)
    try:
        manifest = build(a)
        write(a.out, manifest)
    except Refusal as err:
        print(f"REFUSED: {err}", file=sys.stderr)
        return 2
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
