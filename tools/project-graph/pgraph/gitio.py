"""Git plumbing adapter. Reads names, modes, blob ids and blob text by rev.

It never checks out or runs anything from the head side: the trusted gate
fetches head objects and inspects them as data only (RT-709 A.3)."""

import posixpath
import subprocess

import yaml

from .evaluate import Change

WORKFLOW_DIR = ".github/workflows/"
MAX_TEXT_BYTES = 256 * 1024       # same cap as the graph loader; checked BEFORE reading


class DiffUnavailable(RuntimeError):
    pass


def _git(repo, *args):
    cmd = ["git", "-C", repo, "-c", "core.quotepath=off", *args]
    return subprocess.run(cmd, capture_output=True, check=False)


def _commit_exists(repo, rev):
    return _git(repo, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}").returncode == 0


def read_changes(repo, base, head):
    if not (_commit_exists(repo, base) and _commit_exists(repo, head)):
        raise DiffUnavailable(f"cannot resolve {base}..{head}")
    proc = _git(repo, "diff", "--raw", "-z", "--no-abbrev", "--find-renames",
                "--no-ext-diff", "--no-textconv", base, head)
    if proc.returncode != 0:
        raise DiffUnavailable(proc.stderr.decode("utf-8", "replace").strip())
    # Non-UTF-8 path bytes survive as surrogates; such paths classify as unknown or high.
    fields = proc.stdout.decode("utf-8", "surrogateescape").split("\0")
    changes, i = [], 0
    while i < len(fields) and fields[i]:
        meta = fields[i].lstrip(":").split()
        _, new_mode, _, new_blob, status = meta
        if status[0] in ("R", "C"):
            old, new = fields[i + 1], fields[i + 2]
            changes.append(Change(status[0], new, old_path=old, mode=new_mode, blob=new_blob))
            i += 3
        else:
            changes.append(Change(status[0], fields[i + 1], mode=new_mode, blob=new_blob))
            i += 2
    return changes


def read_text(repo, rev, path):
    """Blob text, or None if missing, larger than MAX_TEXT_BYTES or not UTF-8.
    Callers treat None for a graph as invalid (fail closed)."""
    size = _git(repo, "cat-file", "-s", f"{rev}:{path}")
    if size.returncode != 0 or int(size.stdout.strip() or 0) > MAX_TEXT_BYTES:
        return None
    proc = _git(repo, "cat-file", "blob", f"{rev}:{path}")
    if proc.returncode != 0:
        return None
    try:
        return proc.stdout.decode("utf-8")
    except UnicodeDecodeError:
        return None


def list_tree(repo, rev):
    proc = _git(repo, "ls-tree", "-r", "-z", "--name-only", "--full-tree", rev)
    if proc.returncode != 0:
        raise DiffUnavailable(proc.stderr.decode("utf-8", "replace").strip())
    return {p for p in proc.stdout.decode("utf-8", "surrogateescape").split("\0") if p}


def workflow_jobs(repo, rev):
    """Map job display name -> root workflow path, from the TRUSTED rev only."""
    out = {}
    for path in sorted(list_tree(repo, rev)):
        if posixpath.dirname(path) + "/" != WORKFLOW_DIR or not path.endswith((".yml", ".yaml")):
            continue
        try:
            data = yaml.safe_load(read_text(repo, rev, path) or "")
        except yaml.YAMLError:
            continue
        jobs = data.get("jobs") if isinstance(data, dict) else None
        for key, job in (jobs or {}).items():
            name = job.get("name", key) if isinstance(job, dict) else key
            if isinstance(name, str) and "${{" not in name:
                out[name] = path
    return out
