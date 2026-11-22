"""RT-1554 P1: report a behavioral-tier diff that has no test signal.

Reuses Graph.classify and the runners' existing discovery globs. Report mode
prints and exits 0. A discovered test path in the diff is a signal that a
suite changed, not proof that the new behavior is covered. `coverage-evidence:
RT-N` records an owner for lab or hardware evidence and does not mean that
evidence ran.
"""

import os
import re
import sys

from .globs import compile_glob, normalize_path

# Product -> tier names whose source changes should normally arrive with a test.
BEHAVIORAL = {
    "pos": frozenset({"money", "sales", "stock", "auth", "electron-security"}),
    "admin-console": frozenset({"money", "sales", "stock", "auth"}),
    "backend-core": frozenset({
        "money", "sales", "stock", "tenant-auth", "posting-sync", "migrations", "offer-engine",
    }),
    "erpnext-connector": frozenset({"money", "posting-sync", "migrations", "auth"}),
}

# Repo-relative globs. A path matches when the product's runner would collect it.
DISCOVERED_TESTS = (
    "apps/pos/src/**/*.test.ts",
    "apps/pos/src/**/*.test.tsx",
    "apps/pos/scripts/**/*.test.ts",
    "apps/pos/tests/**/*.test.ts",
    "apps/pos/tests/**/*.test.tsx",
    "apps/pos/tests/e2e/**/*.spec.ts",
    "apps/admin-console/tests/unit/**/*.test.ts",
    "apps/admin-console/tests/unit/**/*.test.tsx",
    "apps/admin-console/tests/e2e/**/*.spec.ts",
    "services/backend-core/apps/api/**/test/**/*.spec.ts",
    "services/backend-core/apps/worker/**/test/**/*.spec.ts",
    "services/backend-core/packages/**/__tests__/**/*.spec.ts",
    "integrations/erpnext-connector/**/test_*.py",
    "tests/e2e/*.test.mjs",
)

# Thin wires and generated clients. A diff of only these stays quiet even when
# a tier would otherwise match (POS preload is electron-security).
QUIET_PATHS = frozenset({
    "apps/pos/src/preload/index.ts",
    "apps/pos/src/preload/payments.ts",
    "apps/pos/src/preload/sales.ts",
    "apps/pos/src/preload/receipts.ts",
    "apps/pos/src/preload/catalogue.ts",
    "apps/pos/src/preload/sales-sync.ts",
    "apps/pos/src/shared/api-types.ts",
})
QUIET_GLOBS = ("apps/admin-console/src/generated/**",)

# An added or modified test counts. Deleting one does not hide a source change.
TEST_STATUSES = frozenset({"A", "M", "T", "R", "C"})
EVIDENCE_LINE = re.compile(r"(?m)^[ \t]*coverage-evidence:[ \t]*(.*?)[ \t]*$")
ISSUE_KEY = re.compile(r"^RT-\d+$")
WARNING_NOTE = (
    "A test file in this diff would only show that a discovered suite changed. "
    "It is not proof the behavior is covered."
)

_TEST_GLOBS = tuple(compile_glob(g) for g in DISCOVERED_TESTS)
_QUIET_GLOBS = tuple(compile_glob(g) for g in QUIET_GLOBS)


class Report:
    __slots__ = ("warnings", "needs_review", "not_executed", "warning_note")

    def __init__(self, warnings=(), needs_review=(), not_executed=(), warning_note=""):
        self.warnings = tuple(warnings)
        self.needs_review = tuple(needs_review)
        self.not_executed = tuple(not_executed)
        self.warning_note = warning_note


def _quiet(path):
    return path in QUIET_PATHS or any(g.match(path) for g in _QUIET_GLOBS)


def _discovered(path):
    return any(g.match(path) for g in _TEST_GLOBS)


def _parse_evidence(body):
    keys, bad = [], []
    for raw in EVIDENCE_LINE.findall(body or ""):
        key = raw.strip()
        if ISSUE_KEY.fullmatch(key):
            keys.append(key)
        else:
            shown = (key or "<blank>")[:120]
            bad.append(f"NEEDS REVIEW coverage-evidence line is not an RT issue key: {shown}")
    return tuple(sorted(set(keys))), tuple(bad)


def _paths(change):
    path = normalize_path(change.path)
    old = normalize_path(change.old_path) if change.old_path else None
    return path, old


def judge(graph, changes, body):
    """Classify `changes` (objects with status, path, old_path). Never raises."""
    keys, bad = _parse_evidence(body)
    warnings, review = [], list(bad)
    for change in changes:
        path, old = _paths(change)
        for candidate in (p for p in (path, old) if p and not _quiet(p)):
            kind = graph.classify(candidate)
            if kind.kind == "ambiguous":
                review.append(f"NEEDS REVIEW ambiguous classification: {candidate}")
                continue
            if kind.kind != "product":
                continue
            hit = [tier for tier in kind.tiers if tier in BEHAVIORAL.get(kind.owner, ())]
            if hit and candidate not in warnings:
                warnings.append(candidate)
    test_seen = any(
        change.status in TEST_STATUSES and _discovered(normalize_path(change.path))
        for change in changes
    )
    if not warnings:
        return Report(needs_review=tuple(review), not_executed=keys if keys else ())
    if test_seen or keys:
        return Report(needs_review=tuple(review), not_executed=keys)
    return Report(warnings=tuple(warnings), needs_review=tuple(review), warning_note=WARNING_NOTE)


def format_report(report):
    lines = [
        "coverage-evidence: report",
        f"warnings: {len(report.warnings)}",
        f"needs_review: {len(report.needs_review)}",
        f"not_executed: {len(report.not_executed)}",
    ]
    if report.warnings:
        lines.append("WARNING behavioral tier without a discovered test or coverage-evidence line")
        lines.extend(f"  {path}" for path in report.warnings)
        lines.append(report.warning_note)
    lines.extend(f"NOT EXECUTED coverage-evidence {key}" for key in report.not_executed)
    lines.extend(report.needs_review)
    return "\n".join(lines) + "\n"


def write_summary(text, report):
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path or (not report.warnings and not report.needs_review and not report.not_executed):
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write("## Test evidence (report mode)\n\n```\n")
        handle.write(text)
        handle.write("```\n")


def emit(report):
    text = format_report(report)
    sys.stdout.write(text)
    write_summary(text, report)
    return text
