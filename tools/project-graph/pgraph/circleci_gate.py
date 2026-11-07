"""RT-1256: `bc/db-integration` verifies the CircleCI API Jest result instead of running API Jest.

The Backend-Core API Jest suite runs once, on CircleCI (job `api-jest-gate`, full suite with
`--coverage`, so the global thresholds in apps/api/jest.config.cjs still fail it). The GitHub
job `bc/db-integration` keeps its name, its graph selection and its place in `required`; on a
pull request it only decides here whether that CircleCI result is trustworthy for the PR's exact
head SHA. Every doubt is a failure or a wait, never a pass:

  - only a pull_request targeting main, from this repository (a fork PR never triggers a GitHub
    App pipeline on CircleCI, so nothing could ever be verified: FORK_PR);
  - `.circleci/` at the head must equal the trusted base: CircleCI compiles the PR's own config,
    so a PR could otherwise turn the gate job into `exit 0` (CIRCLECI_CONFIG_CHANGED);
  - the CircleCI job skips itself (a success status) only when every changed path is in
    OUT_OF_SCOPE_RE; the graph never selects bc/db-integration for such a change (pinned by the
    tests), so a selected job whose paths are all out of scope is drift (SCOPE_DRIFT);
  - only the commit status with context CONTEXT, created by the CircleCI GitHub App's bot account
    (immutable numeric id, type Bot; a login can be renamed), with a CircleCI target URL counts;
    any other status is ignored and listed as rejected. The newest such status decides: success
    passes, failure/error fails, pending waits; none yet waits, until the deadline.

CUTOVER_ENABLED is read from the TRUSTED base commit (the workflow extracts tools/project-graph
with `git archive` of the PR base). A base without this module, or with the flag False, makes the
GitHub job run the full API Jest itself (bootstrap and rollback). Push to main always runs the
GitHub full suite (coverage for Sonar; CircleCI runs no gate job on push).

RT-1265 adds a second target with the same rules: `admin` (Admin Console Vitest, status context
ADMIN_CONTEXT, scope ADMIN_OUT_OF_SCOPE_RE, switch ADMIN_CUTOVER_ENABLED), judged by
`judge(..., target="admin")` for `admin/build-test`. The default target `api` is unchanged."""

import re

# Rollback switch, read from the trusted base only: False puts API Jest back on GitHub.
CUTOVER_ENABLED = True

# The CircleCI GitHub App's bot account (`circleci-app[bot]`), read from the commit statuses of
# a49bbf2ecc19a787d6ebeccfee292b11e9e7cd1e (RT-1239 canary #2), 2026-11-06.
CIRCLECI_BOT_ID = 127350680
CIRCLECI_BOT_TYPE = "Bot"
CONTEXT = "ci/circleci: api-jest-gate"
TARGET_PREFIX = "https://app.circleci.com/"

# Paths whose change never selects bc/db-integration: the other products (except their own
# .github/, a policy path that selects every job), the e2e suite, docs, system manifests and the
# two root prose files. .circleci/scripts/api-gate-scope.cjs holds the same pattern (test-pinned).
OUT_OF_SCOPE_RE = re.compile(
    r"^(?:(?:apps/(?:pos|admin-console)|integrations/erpnext-connector)/(?!(?:.*/)?\.github/)"
    r"|tests/e2e/|docs/|system/|README\.md$|ARCHITECTURE\.md$)"
)

# RT-1265: the second target, Admin Console Vitest. `admin/build-test` keeps codegen and drift,
# build, parity, lint and code-health on GitHub and, on a pull request, verifies CircleCI's
# `admin-vitest-gate` status instead of running Vitest (the full suite with --coverage, as
# `pnpm test`). Its own rollback switch, read from the trusted base like CUTOVER_ENABLED: False
# puts Vitest back on GitHub without touching the API gate. Push to main always runs Vitest on
# GitHub (its lcov feeds Sonar). Admin has no coverage floor (vitest.config.ts), so none is added.
ADMIN_CUTOVER_ENABLED = True
ADMIN_CONTEXT = "ci/circleci: admin-vitest-gate"

# Paths whose change never selects admin/build-test (pinned against the real graph by the tests,
# and .circleci/scripts/admin-gate-scope.cjs holds the same pattern): POS and the connector (not
# their .github/), Backend-Core except its `contracts` tier and the admin edge (packages/contracts/,
# the API openapi sources and tests, tools/oasdiff, tools/schemathesis, the shared observability
# vectors), the e2e suite, docs, system manifests, the two root prose files, and the Admin Console's
# own `low` tier. Anything else is in scope: the CircleCI job runs the suite.
ADMIN_OUT_OF_SCOPE_RE = re.compile(
    r"^(?:(?:apps/pos|integrations/erpnext-connector)/(?!(?:.*/)?\.github/)"
    r"|services/backend-core/(?!(?:.*/)?\.github/|packages/contracts/|packages/shared/__tests__/observability/"
    r"|apps/api/src/openapi/|apps/api/test/openapi/|apps/api/test/contract-conformance\.spec\.ts$"
    r"|tools/oasdiff/|tools/schemathesis/)"
    r"|apps/admin-console/(?:(?:docs|specs|design|design_handoff_retail_tower_console|\.design-sync|\.claude"
    r"|\.specify|\.impeccable)/|[^/]+\.md$)"
    r"|tests/e2e/|docs/|system/|README\.md$|ARCHITECTURE\.md$)"
)

TARGETS = {
    "api": {"context": CONTEXT, "out_of_scope": OUT_OF_SCOPE_RE},
    "admin": {"context": ADMIN_CONTEXT, "out_of_scope": ADMIN_OUT_OF_SCOPE_RE},
}

OK, FAIL, PENDING = "ok", "fail", "pending"


def out_of_scope(paths, target="api"):
    """True when there is at least one path and every one is out of scope (the CircleCI job skips)."""
    pattern = TARGETS[target]["out_of_scope"]
    paths = [p for p in paths if p]
    return bool(paths) and all(pattern.match(p) for p in paths)


def _status_problem(s):
    creator = s.get("creator") or {}
    if creator.get("id") != CIRCLECI_BOT_ID or creator.get("type") != CIRCLECI_BOT_TYPE:
        return "WRONG_CREATOR"
    if not str(s.get("target_url") or "").startswith(TARGET_PREFIX):
        return "WRONG_TARGET"
    return None


def judge(event, head_sha, fork, circleci_changed, paths, statuses, deadline_passed=False, target="api"):
    """Return {verdict, reasons, rejected, status}. `statuses` is GitHub's list for head_sha."""
    out = {"verdict": FAIL, "reasons": [], "rejected": [], "status": None}
    if target not in TARGETS:
        out["reasons"].append("UNKNOWN_TARGET")
        return out
    context = TARGETS[target]["context"]
    if event != "pull_request":
        out["reasons"].append("WRONG_EVENT")
    if not isinstance(head_sha, str) or not re.fullmatch(r"[0-9a-f]{40}", head_sha):
        out["reasons"].append("BAD_HEAD_SHA")
    if fork:
        out["reasons"].append("FORK_PR")
    if circleci_changed:
        out["reasons"].append("CIRCLECI_CONFIG_CHANGED")
    if not isinstance(paths, list):
        out["reasons"].append("NO_PATHS")
    elif out_of_scope(paths, target):
        out["reasons"].append("SCOPE_DRIFT")
    if not isinstance(statuses, list):
        out["reasons"].append("NO_STATUS_LIST")
    if out["reasons"]:
        return out

    valid = []
    for s in statuses:
        if not isinstance(s, dict) or s.get("context") != context:
            continue
        problem = _status_problem(s)
        if problem:
            out["rejected"].append({"id": s.get("id"), "problem": problem})
        else:
            valid.append(s)
    if not valid:
        out["verdict"] = FAIL if deadline_passed else PENDING
        out["reasons"].append("ABSENT_STATUS" if deadline_passed else "WAITING_FOR_STATUS")
        return out
    latest = max(valid, key=lambda s: (str(s.get("created_at") or ""), s.get("id") or 0))
    state = latest.get("state")
    out["status"] = {"id": latest.get("id"), "state": state, "created_at": latest.get("created_at"),
                     "target_url": latest.get("target_url")}
    if state == "success":
        out["verdict"] = OK
    elif state == "pending":
        out["verdict"] = FAIL if deadline_passed else PENDING
        out["reasons"].append("STATUS_INCOMPLETE" if deadline_passed else "STATUS_PENDING")
    else:
        out["reasons"].append("CIRCLECI_" + str(state or "unknown").upper())
    return out
