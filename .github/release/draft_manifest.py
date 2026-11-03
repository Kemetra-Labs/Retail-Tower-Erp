#!/usr/bin/env python3
"""Draft the next system release manifest (RT-1089, runbook system/releases/README.md).

Writes system/releases/<system>.json for deploy-system-lab.yml from:

  --backend / --console  `latest` (the highest vX.Y.Z that is a published, immutable, non-draft,
                         non-prerelease release of that product) or an explicit tag, checked the same way;
  --erp                  `latest` (the image built by build-erp-image.yml for the newest commit on
                         main, with a valid attestation from that workflow on refs/heads/main) or an
                         explicit sha256 digest, checked the same way; its commit is the image's
                         org.opencontainers.image.revision label;
  --pos                  `current` (the POS build of the current manifest) or a 40-hex build id.

The file is named after --system, by default the next free lab-YYYY.MM.N of this month, and an
existing file is never overwritten (a deployed version is never edited). It then runs
system_gate.py (G1-G5) on the new file. The deploy preflight still checks everything online.

Reads: `gh` for releases and attestations (the caller's token), the public GHCR registry
anonymously for the image tags, digests and labels, and git for main. Writes only the new file.
Exit 0 = written and the gate passed, 1 = written but the gate failed, 2 = nothing written.
"""
import argparse
import datetime
import json
import pathlib
import re
import subprocess
import sys
import urllib.request

import system_gate

ROOT = pathlib.Path(__file__).resolve().parents[2]
RELEASES_DIR = ROOT / "system" / "releases"
GITHUB_REPO = "Kemetra-Labs/Retail-Tower-Erp"
IMAGE = "ghcr.io/kemetra-labs/rt-erpnext"
REGISTRY = "https://ghcr.io"
REGISTRY_NAME = "kemetra-labs/rt-erpnext"
SIGNER = f"{GITHUB_REPO}/.github/workflows/build-erp-image.yml"
IMAGE_TAG = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+-([0-9a-f]{12})$")  # <ERPNext version>-<sha12>, build-erp-image.yml
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
SYSTEM = re.compile(r"^lab-([0-9]{4})\.([0-9]{1,2})\.([0-9]+)$")
MANIFEST_TYPES = "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"


class DraftError(Exception):
    """The draft cannot be made; nothing is written."""


def version_key(tag, product):
    match = re.fullmatch(rf"{re.escape(product)}/v([0-9]+)\.([0-9]+)\.([0-9]+)", tag)
    return tuple(int(part) for part in match.groups()) if match else None


def published(state):
    return bool(state) and state.get("isImmutable") is True and not state.get("isDraft") and not state.get("isPrerelease")


def pick_release(releases, product, wanted):
    """The release tag of `product`: the highest published immutable vX.Y.Z, or `wanted` checked."""
    if wanted != "latest":
        if version_key(wanted, product) is None or not published(releases.state(wanted)):
            raise DraftError(f"{wanted} is not a published, immutable {product} release")
        return wanted
    for tag in sorted((t for t in releases.tags() if version_key(t, product)), key=lambda t: version_key(t, product), reverse=True):
        if published(releases.state(tag)):
            return tag
    raise DraftError(f"no published, immutable {product} release found")


def usable_revision(images, git, digest, sha12=None):
    """The full commit of an image when it is on main and its label agrees with its tag, else None."""
    revision = images.revision_of(digest)
    if not (isinstance(revision, str) and system_gate.SHA.fullmatch(revision)):
        return None
    if sha12 is not None and not revision.startswith(sha12):
        return None
    return revision if git.is_on_main(revision) else None


def pick_erp(images, git, wanted):
    """(digest, commit) of the ERP image: the newest attested one on main, or `wanted` checked."""
    if wanted != "latest":
        if not DIGEST.fullmatch(wanted):
            raise DraftError("--erp must be `latest` or sha256:<64 hex>")
        revision = usable_revision(images, git, wanted)
        if revision is None or not images.is_attested(wanted):
            raise DraftError(f"{wanted} is not an attested build-erp-image.yml image of a commit on main")
        return wanted, revision
    candidates = []
    for tag in images.tags():
        match = IMAGE_TAG.fullmatch(tag)
        if not match:
            continue
        digest = images.digest_of(tag)
        revision = usable_revision(images, git, digest, match.group(1)) if DIGEST.fullmatch(digest or "") else None
        if revision:
            candidates.append((git.commit_time(revision), digest, revision))
    for _, digest, revision in sorted(candidates, reverse=True):
        if images.is_attested(digest):
            return digest, revision
    raise DraftError("no attested build-erp-image.yml image of a commit on main found")


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


def draft(releases, images, git, current_path, system, backend, console, erp, pos):
    """The new manifest as a dict, checked against G1."""
    current = json.loads(pathlib.Path(current_path).read_text(encoding="utf-8"))
    problem = system_gate.check_shape(current, pathlib.Path(current_path).name)
    if problem:
        raise DraftError(f"{current_path}: {problem}")
    build = current["pos"]["build"] if pos == "current" else pos
    if not system_gate.SHA.fullmatch(build):
        raise DraftError("--pos must be `current` or a 40-hex build id")
    digest, revision = pick_erp(images, git, erp)
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


def write_new(out_dir, data):
    path = pathlib.Path(out_dir) / f"{data['system']}.json"
    if path.exists():
        raise DraftError(f"{path} already exists; a system version is never edited, choose another --system")
    path.write_text(render(data), encoding="utf-8", newline="\n")
    return path


class GitHubReleases:
    def __init__(self, repo):
        self.repo = repo

    def tags(self):
        out = gh("release", "list", "--repo", self.repo, "--limit", "1000", "--json", "tagName", "--jq", ".[].tagName")
        return out.split()

    def state(self, tag):
        try:
            return json.loads(gh("release", "view", tag, "--repo", self.repo, "--json", "isDraft,isPrerelease,isImmutable"))
        except DraftError:
            return None


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
        return json.loads(self._get("tags/list")[1]).get("tags") or []

    def digest_of(self, tag):
        return self._get(f"manifests/{tag}", MANIFEST_TYPES, "HEAD")[0].get("Docker-Content-Digest")

    def revision_of(self, digest):
        manifest = json.loads(self._get(f"manifests/{digest}", MANIFEST_TYPES)[1])
        config = json.loads(self._get(f"blobs/{manifest['config']['digest']}")[1])
        return ((config.get("config") or {}).get("Labels") or {}).get("org.opencontainers.image.revision")

    def is_attested(self, digest):
        proc = subprocess.run(["gh", "attestation", "verify", f"oci://{IMAGE}@{digest}", "--repo", self.repo,
                               "--signer-workflow", SIGNER, "--source-ref", "refs/heads/main"],
                              capture_output=True, text=True, check=False)
        return proc.returncode == 0


class Git:
    def __init__(self, repo_dir, main):
        self.repo_dir, self.main = repo_dir, main

    def _run(self, *args):
        return subprocess.run(["git", "-C", str(self.repo_dir), *args], capture_output=True, text=True, check=False)

    def is_on_main(self, sha):
        return self._run("merge-base", "--is-ancestor", sha, self.main).returncode == 0

    def commit_time(self, sha):
        return int(self._run("log", "-1", "--format=%ct", sha).stdout.strip() or 0)


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
    try:
        names = [path.stem for path in out_dir.glob("lab-*.json")]
        current = pathlib.Path(args.current) if args.current else out_dir / f"{newest(names)}.json"
        system = args.system or next_system(names, datetime.date.today())
        if not SYSTEM.fullmatch(system):
            raise DraftError("--system must look like lab-YYYY.MM.N")
        data = draft(GitHubReleases(GITHUB_REPO), Registry(GITHUB_REPO), Git(ROOT, args.main), current, system,
                     args.backend, args.console, args.erp, args.pos)
        if args.print:
            sys.stdout.buffer.write(render(data).encode("utf-8"))  # LF on every platform, as in the files
            return 0
        path = write_new(out_dir, data)
    except (DraftError, OSError, ValueError, KeyError) as exc:
        print(f"draft-manifest: {exc}", file=sys.stderr)
        return 2
    print(f"draft-manifest: wrote {path} over {current.name}", file=sys.stderr)
    gate = subprocess.run([sys.executable, str(ROOT / ".github" / "release" / "system_gate.py"), "--repo", str(ROOT),
                           "--manifest", str(path), "--main", args.main], check=False)
    return 0 if gate.returncode == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
