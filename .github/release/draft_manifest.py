#!/usr/bin/env python3
"""Draft the next system release manifest (RT-1089, runbook system/releases/README.md).

Writes system/releases/<system>.json for deploy-system-lab.yml from:

  --backend / --console  `latest` (the highest vX.Y.Z that is a published, immutable, non-draft,
                         non-prerelease release of that product) or an explicit tag, checked the same way;
  --erp                  `latest` or an explicit sha256 digest. An image is deployable when its tag is
                         build-erp-image.yml's `<ERPNext version>-<sha12>`, its revision label is that
                         commit on main, and its Connector tree and base labels are what the deploy
                         preflight requires. `latest` is the deployable image of the newest such commit
                         (by ancestry), and it must carry a valid attestation from build-erp-image.yml on
                         refs/heads/main: an unattested newest image is an error, never a silent fallback
                         to an older one (choose that one with --erp);
  --pos                  `current` (the POS build of the current manifest) or a 40-hex build id.

The file is named after --system, by default the next free lab-YYYY.MM.N of this month. It is
checked with system_gate.py (G1-G5) before it is written, and an existing file is never
overwritten (a deployed version is never edited). The deploy preflight still checks every product.

Reads: `gh` for releases and attestations (the caller's token), the public GHCR registry
anonymously for image tags, manifests and labels (each checked against its digest), and git for
main. Any failure of those is an error. Exit 0 = written (with --print: printed, no gate, no
write), 1 = refused by the gate (nothing written), 2 = no draft: bad input, or a gh, registry or git
failure (nothing written).
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.request

import system_gate

ROOT = pathlib.Path(__file__).resolve().parents[2]
RELEASES_DIR = ROOT / "system" / "releases"
DEPLOY_WORKFLOW = ROOT / ".github" / "workflows" / "deploy-system-lab.yml"
GITHUB_REPO = "Kemetra-Labs/Retail-Tower-Erp"
IMAGE = "ghcr.io/kemetra-labs/rt-erpnext"
REGISTRY = "https://ghcr.io"
REGISTRY_NAME = "kemetra-labs/rt-erpnext"
SIGNER = f"{GITHUB_REPO}/.github/workflows/build-erp-image.yml"
CONNECTOR = "integrations/erpnext-connector"
IMAGE_TAG = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+-([0-9a-f]{12})$")  # <ERPNext version>-<sha12>, build-erp-image.yml
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
SYSTEM = re.compile(r"^lab-([0-9]{4})\.([0-9]{2})\.([0-9]+)$")
MANIFEST_TYPES = "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"


class DraftError(Exception):
    """The draft cannot be made; nothing is written."""


def note(text):
    print(f"draft-manifest: {text}", file=sys.stderr)


def version_key(tag, product):
    match = re.fullmatch(rf"{re.escape(product)}/v([0-9]+)\.([0-9]+)\.([0-9]+)", tag)
    return tuple(int(part) for part in match.groups()) if match else None


def published(state):
    return bool(state) and state.get("isImmutable") is True and not state.get("isDraft") and not state.get("isPrerelease")


def pick_release(releases, product, wanted):
    """The release tag of `product`: the highest published immutable vX.Y.Z, or `wanted` checked."""
    states = releases.states()
    if wanted != "latest":
        if version_key(wanted, product) is None or not published(states.get(wanted)):
            raise DraftError(f"{wanted} is not a published, immutable {product} release")
        return wanted
    for tag in sorted((t for t in states if version_key(t, product)), key=lambda t: version_key(t, product), reverse=True):
        if published(states[tag]):
            return tag
        note(f"skipped {tag}: not a published, immutable release")
    raise DraftError(f"no published, immutable {product} release found")


def deployable(images, git, digest, base_digest, sha12=None):
    """(commit, None) when the image is one the deploy preflight accepts, else (None, why)."""
    labels = images.labels_of(digest)
    revision = labels.get("org.opencontainers.image.revision")
    if not (isinstance(revision, str) and system_gate.SHA.fullmatch(revision)):
        return None, "no commit in its revision label"
    if sha12 is not None and not revision.startswith(sha12):
        return None, f"its revision label {revision[:12]} is not its tag's commit"
    if not git.is_on_main(revision):
        return None, f"its commit {revision[:12]} is not on main"
    if labels.get("rt.connector.tree") != git.tree_of(revision, CONNECTOR):
        return None, "its Connector tree label is not the tree of its commit"
    if labels.get("rt.base.digest") != base_digest:
        return None, "its base is not the pinned ERPNext base (BASE_DIGEST of deploy-system-lab.yml)"
    return revision, None


def pick_erp(images, git, wanted, base_digest):
    """(digest, commit) of the ERP image: the attested deployable image of the newest commit, or `wanted` checked."""
    if wanted != "latest":
        if not DIGEST.fullmatch(wanted):
            raise DraftError("--erp must be `latest` or sha256:<64 hex>")
        revision, why = deployable(images, git, wanted, base_digest)
        if revision is None:
            raise DraftError(f"{wanted} cannot be deployed: {why}")
        if not images.is_attested(wanted):
            raise DraftError(f"{wanted} has no valid build-erp-image.yml attestation from refs/heads/main")
        return wanted, revision
    candidates = []
    for tag in images.tags():
        match = IMAGE_TAG.fullmatch(tag)
        if not match:
            continue
        digest = images.digest_of(tag)
        if not DIGEST.fullmatch(digest or ""):
            raise DraftError(f"the registry gave no digest for {tag}")
        revision, why = deployable(images, git, digest, base_digest, match.group(1))
        if revision is None:
            note(f"skipped {tag}: {why}")
            continue
        candidates.append((digest, revision, tag))
    if not candidates:
        raise DraftError("no deployable build-erp-image.yml image of a commit on main found")
    digest, revision, tag = max(candidates, key=lambda item: git.commit_time(item[1]))
    for other_digest, other_revision, other_tag in candidates:
        if other_revision == revision and other_digest != digest:
            raise DraftError(f"{tag} and {other_tag} are two deployable images of one commit; choose one with --erp")
        if not git.is_ancestor(other_revision, revision):
            raise DraftError(f"{other_tag} and {tag} are not in one line on main; choose one with --erp")
    if not images.is_attested(digest):
        raise DraftError(f"the newest image {tag} ({digest}) has no valid build-erp-image.yml attestation from "
                         "refs/heads/main (or it could not be checked); an older image needs an explicit --erp")
    return digest, revision


def newest(names):
    """The highest lab-YYYY.MM.N of `names`, by number."""
    found = [(tuple(int(part) for part in SYSTEM.fullmatch(name).groups()), name) for name in names if SYSTEM.fullmatch(name)]
    if not found:
        raise DraftError("no system release manifest found")
    return max(found)[1]


def next_system(names, today):
    numbers = [int(m.group(3)) for m in (SYSTEM.fullmatch(name) for name in names)
               if m and int(m.group(1)) == today.year and int(m.group(2)) == today.month]
    return f"lab-{today.year:04d}.{today.month:02d}.{max(numbers) + 1 if numbers else 0}"


def draft(releases, images, git, current_path, system, backend, console, erp, pos, base_digest):
    """The new manifest as a dict, checked against G1."""
    current = json.loads(pathlib.Path(current_path).read_text(encoding="utf-8"))
    problem = system_gate.check_shape(current, pathlib.Path(current_path).name)
    if problem:
        raise DraftError(f"{current_path}: {problem}")
    build = current["pos"]["build"] if pos == "current" else pos
    if not system_gate.SHA.fullmatch(build):
        raise DraftError("--pos must be `current` or a 40-hex build id")
    digest, revision = pick_erp(images, git, erp, base_digest)
    data = {
        "schema": system_gate.SCHEMA, "system": system,
        "backendCore": {"release": pick_release(releases, "backend-core", backend)},
        "adminConsole": {"release": pick_release(releases, "admin-console", console)},
        "erpnext": {"image": f"{IMAGE}@{digest}", "sha": revision},
        "pos": {"build": build},
    }
    problem = system_gate.check_shape(data, f"{system}.json")
    if problem:
        raise DraftError(problem)
    return data


def render(data):
    """The hand-written layout of the files in system/releases (one product per line)."""
    one = lambda value: json.dumps(value, separators=(", ", ": "))  # noqa: E731
    erp = data["erpnext"]
    return "\n".join([
        "{",
        f'  "schema": {json.dumps(data["schema"])},',
        f'  "system": {json.dumps(data["system"])},',
        f'  "backendCore": {one(data["backendCore"])},',
        f'  "adminConsole": {one(data["adminConsole"])},',
        '  "erpnext": {',
        f'    "image": {json.dumps(erp["image"])},',
        f'    "sha": {json.dumps(erp["sha"])}',
        "  },",
        f'  "pos": {one(data["pos"])}',
        "}",
        "",
    ])


def gated_write(out_dir, data, gate):
    """Run `gate(path)` on the draft under its own name in a scratch directory, then create the real
    file only on a pass. Returns (path or None, gate exit code). An existing file is never touched."""
    path = pathlib.Path(out_dir) / f"{data['system']}.json"
    if path.exists():
        raise DraftError(f"{path} already exists; a system version is never edited, choose another --system")
    with tempfile.TemporaryDirectory() as tmp:
        trial = pathlib.Path(tmp) / path.name
        trial.write_text(render(data), encoding="utf-8", newline="\n")
        code = gate(trial)
    if code != 0:
        return None, code
    try:
        with open(path, "x", encoding="utf-8", newline="\n") as handle:
            handle.write(render(data))
    except FileExistsError as exc:
        raise DraftError(f"{path} appeared while drafting; nothing was written") from exc
    return path, 0


def pinned_base():
    match = re.search(r"^  BASE_DIGEST: (sha256:[0-9a-f]{64})$", DEPLOY_WORKFLOW.read_text(encoding="utf-8"), re.M)
    if not match:
        raise DraftError(f"no BASE_DIGEST in {DEPLOY_WORKFLOW}")
    return match.group(1)


class GitHubReleases:
    def __init__(self, repo):
        self.repo = repo
        self._states = None

    def states(self):
        """{tag: {isDraft, isPrerelease, isImmutable}} from one listing; a gh failure is an error."""
        if self._states is None:
            rows = json.loads(gh("release", "list", "--repo", self.repo, "--limit", "1000",
                                 "--json", "tagName,isDraft,isPrerelease,isImmutable"))
            if len(rows) >= 1000:
                raise DraftError("1000 or more releases: the listing may be cut off")
            self._states = {row["tagName"]: row for row in rows}
        return self._states


class Registry:
    """The public GHCR repository, read anonymously, plus `gh attestation verify`."""

    def __init__(self, repo):
        self.repo = repo
        self._token = None

    def _get(self, path, accept=None, method="GET"):
        if self._token is None:
            with urllib.request.urlopen(f"{REGISTRY}/token?scope=repository:{REGISTRY_NAME}:pull", timeout=30) as resp:
                self._token = json.load(resp)["token"]
        request = urllib.request.Request(f"{REGISTRY}/v2/{REGISTRY_NAME}/{path}", method=method,
                                         headers={"Authorization": f"Bearer {self._token}", **({"Accept": accept} if accept else {})})
        try:
            with urllib.request.urlopen(request, timeout=30) as resp:
                return resp.headers, (resp.read() if method == "GET" else b"")
        except OSError as exc:
            raise DraftError(f"the registry refused {path}: {exc}") from exc

    def tags(self):
        headers, body = self._get("tags/list?n=1000")
        if headers.get("Link"):
            raise DraftError("the registry tag list has more than one page; it is not read in part")
        return json.loads(body).get("tags") or []

    def digest_of(self, tag):
        return self._get(f"manifests/{tag}", MANIFEST_TYPES, "HEAD")[0].get("Docker-Content-Digest")

    def _verified(self, path, digest, accept=None):
        body = self._get(path, accept)[1]
        if "sha256:" + hashlib.sha256(body).hexdigest() != digest:
            raise DraftError(f"the registry content of {path} does not match {digest}")
        return json.loads(body)

    def labels_of(self, digest):
        manifest = self._verified(f"manifests/{digest}", digest, MANIFEST_TYPES)
        config_digest = (manifest.get("config") or {}).get("digest")
        if not DIGEST.fullmatch(config_digest or ""):
            raise DraftError(f"the manifest of {digest} has no config digest")
        config = self._verified(f"blobs/{config_digest}", config_digest)
        return (config.get("config") or {}).get("Labels") or {}

    def is_attested(self, digest):
        """True only on a passing verification; anything else (no attestation, a network or auth error)
        is False, which pick_erp turns into an error rather than a fallback."""
        proc = subprocess.run(["gh", "attestation", "verify", f"oci://{IMAGE}@{digest}", "--repo", self.repo,
                               "--signer-workflow", SIGNER, "--source-ref", "refs/heads/main"],
                              capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            note(f"attestation check of {digest} failed: {proc.stderr.strip()[:200]}")
        return proc.returncode == 0


class Git:
    def __init__(self, repo_dir, main):
        self.repo_dir, self.main = repo_dir, main

    def _run(self, *args):
        return subprocess.run(["git", "-C", str(self.repo_dir), *args], capture_output=True, text=True, check=False)

    def is_ancestor(self, older, newer):
        """git merge-base --is-ancestor: 0 yes, 1 no, anything else (an unknown commit) is an error."""
        code = self._run("merge-base", "--is-ancestor", older, newer).returncode
        if code not in (0, 1):
            raise DraftError(f"git cannot compare {older[:12]} with {newer} (fetch origin first)")
        return code == 0

    def is_on_main(self, sha):
        return self.is_ancestor(sha, self.main)

    def tree_of(self, sha, path):
        proc = self._run("rev-parse", "--verify", "--quiet", f"{sha}:{path}")
        if proc.returncode != 0:
            raise DraftError(f"git has no {path} at {sha[:12]}")
        return proc.stdout.strip()

    def commit_time(self, sha):
        proc = self._run("log", "-1", "--format=%ct", sha)
        if proc.returncode != 0 or not proc.stdout.strip().isdigit():
            raise DraftError(f"git cannot read the time of {sha[:12]}")
        return int(proc.stdout.strip())


def gh(*args):
    proc = subprocess.run(["gh", *args], capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise DraftError(f"gh {args[0]} {args[1]} failed: {proc.stderr.strip()[:200]}")
    return proc.stdout


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--backend", default="latest")
    parser.add_argument("--console", default="latest")
    parser.add_argument("--erp", default="latest")
    parser.add_argument("--pos", default="current")
    parser.add_argument("--current", help="the manifest live now (default: the newest in system/releases)")
    parser.add_argument("--system", help="the new version name (default: the next free lab-YYYY.MM.N of this month)")
    parser.add_argument("--out-dir", default=str(RELEASES_DIR))
    parser.add_argument("--main", default="origin/main")
    parser.add_argument("--print", action="store_true", help="print the draft instead of writing it")
    args = parser.parse_args(argv)
    out_dir = pathlib.Path(args.out_dir)

    def gate(path):
        return subprocess.run([sys.executable, str(ROOT / ".github" / "release" / "system_gate.py"), "--repo", str(ROOT),
                               "--manifest", str(path), "--main", args.main], check=False).returncode

    try:
        if not re.fullmatch(r"[A-Za-z0-9_./-]+", args.main) or args.main.startswith("-"):
            raise DraftError("--main must be a ref name")
        names = [path.stem for path in out_dir.glob("lab-*.json")]
        current = pathlib.Path(args.current) if args.current else out_dir / f"{newest(names)}.json"
        system = args.system or next_system(names, datetime.date.today())
        if not SYSTEM.fullmatch(system):
            raise DraftError("--system must look like lab-YYYY.MM.N")
        data = draft(GitHubReleases(GITHUB_REPO), Registry(GITHUB_REPO), Git(ROOT, args.main), current, system,
                     args.backend, args.console, args.erp, args.pos, pinned_base())
        if args.print:
            sys.stdout.buffer.write(render(data).encode("utf-8"))  # LF on every platform, as in the files
            return 0
        path, code = gated_write(out_dir, data, gate)
    except (DraftError, OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        note(str(exc))
        return 2
    if path is None:
        note("the gate refused the draft; nothing was written")
        return 1
    note(f"wrote {path} over {current.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
