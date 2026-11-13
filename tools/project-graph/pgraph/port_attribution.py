"""Read-only Port PR attribution from the trusted Retail Tower project graph.

This is *not* the CI selector or a Port writer.  The caller runs base-branch
code with a read-only checkout of the base/head Git objects.  In particular,
never execute this module from an untrusted PR head with Port credentials.
"""

import argparse
import hashlib
import json
import pathlib
import re
import sys

from . import gitio
from .graph import Graph, GraphError, load_graph, validate_graph
from .globs import normalize_path

SCHEMA = "retail-tower/port-attribution@1"
GRAPH_PATH = "tools/project-graph/graph.yaml"
REPOSITORY = "Kemetra-Labs/Retail-Tower-Erp"
MAX_CHANGES = 3000
_SHA = re.compile(r"[0-9a-f]{40}\Z")
_ALLOWED = frozenset("AMDRC")
_REGULAR_MODES = frozenset(("100644", "100755", "000000"))


def _safe_path(path):
    if not isinstance(path, str) or not path or len(path) > 4096:
        return None
    if path.startswith(("/", "./")) or "\\" in path or any(ord(ch) < 32 or ord(ch) == 127 for ch in path):
        return None
    normal = normalize_path(path)
    if any(seg in ("", ".", "..") for seg in normal.split("/")):
        return None
    return normal


def _result(policy_sha, head_sha, diff_base, pr_number, *, status="insufficient_evidence",
            scope="unknown", services=(), shared=(), reasons=(), paths=0, fingerprint=None):
    return {
        "schema": SCHEMA,
        "attribution_status": status,
        "attribution_scope": scope,
        "affected_services": sorted(services),
        "shared_classes": sorted(shared),
        "reason_codes": sorted(set(reasons)),
        "classification_policy_ref": policy_sha,
        "classification_evidence_url": (
            f"https://github.com/{REPOSITORY}/pull/{pr_number}/files"
            if isinstance(pr_number, int) and not isinstance(pr_number, bool) and pr_number > 0 else None
        ),
        "diff_base_sha": diff_base,
        "head_sha": head_sha,
        "changed_paths": paths,
        "input_fingerprint": fingerprint,
    }


def classify_changes(graph, changes, policy_sha, head_sha, diff_base, pr_number):
    """Pure, fail-closed classifier over *complete* gitio.read_changes() output.

    - Rename: both the removed and added paths are affected.
    - Copy: only its new path changed (the source is still present).
    - Shared/policy files do NOT imply directly affected services, even when
      the CI graph intentionally selects every product's tests.
    - Any unknown path, unsupported mode/status or incomplete evidence means
      an empty affected_services list, not a misleading partial result.
    """
    invalid = []
    if not all(isinstance(s, str) and _SHA.fullmatch(s) for s in (policy_sha, head_sha, diff_base)):
        invalid.append("INVALID_COMMIT_SHA")
    if not isinstance(pr_number, int) or isinstance(pr_number, bool) or pr_number <= 0:
        invalid.append("INVALID_PR_NUMBER")
    if not isinstance(changes, (tuple, list)) or not 0 < len(changes) <= MAX_CHANGES:
        invalid.append("INCOMPLETE_OR_OVERSIZE_DIFF")
    if invalid:
        return _result(policy_sha, head_sha, diff_base, pr_number, reasons=invalid)

    services, shared, paths, records, reasons = set(), set(), set(), [], set()
    for change in changes:
        status = getattr(change, "status", None)
        path = getattr(change, "path", None)
        old_path = getattr(change, "old_path", None)
        mode = getattr(change, "mode", None)
        blob = getattr(change, "blob", None)
        if not isinstance(status, str) or status not in _ALLOWED:
            reasons.add("UNSUPPORTED_DIFF_STATUS")
            continue
        if mode not in _REGULAR_MODES:
            reasons.add("NON_REGULAR_FILE_MODE")
        new = _safe_path(path)
        old = _safe_path(old_path) if status == "R" else None
        if new is None or (status == "R" and old is None):
            reasons.add("INVALID_OR_MISSING_PATH")
            continue
        affected_paths = (old, new) if status == "R" else (new,)
        # Always hash every distinct changed file with status/mode/blob, not only
        # the paths that happen to map to a product.
        records.append((status, new, old, mode, blob))
        for current in affected_paths:
            paths.add(current)
            try:
                classification = graph.classify(current)
            except (KeyError, TypeError, ValueError):
                reasons.add("GRAPH_CLASSIFICATION_ERROR")
                continue
            if classification.kind == "product":
                if classification.owner not in graph.data["products"]:
                    reasons.add("UNKNOWN_PRODUCT")
                else:
                    services.add(classification.owner)
            elif classification.kind == "class":
                shared.add(classification.owner)
            elif classification.kind == "ambiguous":
                reasons.add("AMBIGUOUS_PATH")
            else:
                reasons.add("UNKNOWN_PATH")

    if not records:
        reasons.add("NO_USABLE_CHANGES")
    if reasons:
        # Do not emit a partial assignment, even if some paths were valid.
        return _result(policy_sha, head_sha, diff_base, pr_number,
                       reasons=reasons, paths=len(paths))

    fingerprint = hashlib.sha256(json.dumps(
        {"policy_sha": policy_sha, "head_sha": head_sha, "diff_base": diff_base,
         "records": sorted(records, key=lambda x: (x[1], x[0]))},
        sort_keys=True, ensure_ascii=True, separators=(",", ":"),
    ).encode("utf-8")).hexdigest()
    scope = "multi" if len(services) > 1 else "single" if services else "shared"
    return _result(policy_sha, head_sha, diff_base, pr_number, status="classified",
                   scope=scope, services=services, shared=shared,
                   paths=len(paths), fingerprint=fingerprint)


def classify_git(repo, base_sha, head_sha, pr_number):
    """Read only immutable Git objects; never import or execute PR-head code."""
    fail = lambda reason: _result(base_sha, head_sha, None, pr_number, reasons=[reason])
    if not all(isinstance(value, str) and _SHA.fullmatch(value) for value in (base_sha, head_sha)):
        return fail("INVALID_COMMIT_SHA")
    try:
        trusted_text = gitio.read_text(repo, base_sha, GRAPH_PATH)
        if trusted_text is None:
            return fail("TRUSTED_GRAPH_UNAVAILABLE")
        data = load_graph(trusted_text)
        if validate_graph(data):
            return fail("TRUSTED_GRAPH_INVALID")
        graph = Graph(data)
        diff_base = gitio.merge_base(repo, base_sha, head_sha)
        changes = tuple(gitio.read_changes(repo, diff_base, head_sha))
        return classify_changes(graph, changes, base_sha, head_sha, diff_base, pr_number)
    except (gitio.DiffUnavailable, GraphError, OSError, ValueError, TypeError, KeyError):
        return fail("GIT_OR_GRAPH_EVIDENCE_UNAVAILABLE")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Advisory Port attribution; no Port writes")
    parser.add_argument("--repo", default=".", help="local Git object database, not a PR checkout")
    parser.add_argument("--base", required=True, help="full, trusted base commit SHA")
    parser.add_argument("--head", required=True, help="full PR head commit SHA")
    parser.add_argument("--pr-number", type=int, required=True)
    parser.add_argument("--out", help="optional JSON output path")
    args = parser.parse_args(argv)
    result = classify_git(args.repo, args.base, args.head, args.pr_number)
    output = json.dumps(result, indent=2, sort_keys=True, ensure_ascii=True) + "\n"
    if args.out:
        pathlib.Path(args.out).write_text(output, encoding="utf-8")
    else:
        sys.stdout.write(output)
    return 0 if result["attribution_status"] == "classified" else 2


if __name__ == "__main__":
    raise SystemExit(main())
