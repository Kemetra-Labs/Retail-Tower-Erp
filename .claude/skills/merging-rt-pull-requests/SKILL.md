---
name: merging-rt-pull-requests
description: Use when pushing to, preflighting, waiting on, merging or confirming a merged pull request in Kemetra-Labs/Retail-Tower-Erp; when choosing which CircleCI remote_suite covers a change; when proving a Docker-gated spec really ran; when "gh run list" shows no push runs for a merge commit; or when asked "is it merged and fine?".
---

# Merging RT pull requests

## Overview

Repo `CLAUDE.md` section 11 holds the rules: batch one push per review round, preflight heavy
suites on CircleCI, merge only on a completed green `required` on the exact head with
`--match-head-commit`, check `main` after the merge. Follow it; this skill does not restate it.
It adds the RT facts those rules depend on, where agents go wrong.

**Related:** `handling-git-and-prs-safely` (signing, commit and merge mechanics on this machine),
`triaging-pr-comments` (review threads), the CircleCI server skill `debug-failing-run` (a red run),
`reconciling-rt-jira-with-github` (its `scripts/rt_reconcile.py ci` does the post-merge checks below).

## Which remote_suite covers the change

| Changed path | `remote_suite` | Not covered there, run locally before the preflight push |
|---|---|---|
| `services/backend-core/apps/api/**` | `api`, `backend-fast` | `(cd services/backend-core && pnpm lint:eslint)` |
| `services/backend-core/apps/worker/**` (worker DB specs included) or `services/backend-core/packages/db/**` | `db-package` (only suite with `WORKER_INCLUDE_DB_TESTS=1`), `backend-fast`; add `api` for any `packages/db` change (the api depends on it and its specs apply the migrations) or if `apps/api` changed | same eslint |
| Backend-Core shared code, lint, typecheck | `backend-fast` | the code-health ratchet (`node tools/code-health/check.mjs` from `services/backend-core`) and the api unit specs (see below) |
| `apps/admin-console/**` | `admin`, `admin-e2e` | — |
| `apps/pos/**` | `pos` | — |
| Connector, POS packaging, Electron e2e | none | GitHub Actions on the PR is the only cloud run |

`backend-fast` misses two things CI's `bc/fast` checks: the code-health ratchet, and api unit
specs whose hand-written `jest.mock("@data-pulse-2/shared", ...)` partials lack a new export.
Run them from `services/backend-core/apps/api`:
`npx jest --testPathPattern "unit\.spec|test/observability"`.

Trigger rules are in RT-981 comment 14612. The remote-dev workflows share one CircleCI
`serial-group`, so CircleCI runs them one at a time: with parallel sessions, queue your run
instead of waiting for "no run in progress" (you would keep losing that race; expect a 6 to 15
minute wait). The 30-per-Cairo-day cap still counts every trigger.

## Prove a Docker-gated spec really ran

Backend-Core DB specs fail hard without Docker unless `MIGRATION_TEST_ALLOW_SKIP=1` is set; with
it they return early and junit still says success. Per-test `run_time` is not proof:
`.circleci/scripts/jest-json-to-junit.cjs` spreads suite start-up and `beforeAll` time over every
test. Use the CircleCI `list_job_tests` tool with `all=true` and
`filter=["classname=<path>.spec.ts"]` (path relative to the package: `test/...` in `apps/api` and
`apps/worker`, `__tests__/...` in `packages/db`) to
list the tests, then cite that `MIGRATION_TEST_ALLOW_SKIP` was unset for the job and that its log
has no skip warning, not the green job.

## Waiting for CI

Do not build a polling loop. In the desktop app, use the `ccd_pr` status tools and Auto-fix; in a
terminal session, check once later or ask the owner to ping. A head pushed seconds ago has no
`required` yet; `gh pr checks` can still show the previous head's results.

## Red checks from GitHub release downloads

Many jobs download a pinned tool from `github.com/<org>/<repo>/releases/download/...` (gitleaks,
osv-scanner for `dependency-review`, the CodeQL bundle, the oasdiff and contracts binaries,
Electron for the POS jobs). When GitHub's release downloads fail, all of them go red with
`curl: (22) ... error: 504` or `HTTPError: Response code 504` before testing anything, and
`required` turns red with them (seen 2026-11-08 on #420, #421, #422 and `main`).
- Read each failing job to its first error (`gh run view --job <id> --log-failed`); do not assume
  every red job has the same cause.
- Confirm it is external: the same 504 on `main` or an unrelated branch, or reproduce it with
  `curl -s -o /dev/null -L -r 0-1023 -w '%{http_code}' <release-url>`. The GitHub status page can
  still say "operational".
- Change nothing in the PR. Re-run only the failed jobs (`gh run rerun <run-id> --failed`) once the
  `curl` check returns 200; a push or a re-run during the outage just fails again.
- Never merge past the red `required` because "it is only infra": the bypass is the owner's.

## After the merge

1. `gh pr view <n> --json headRefOid,mergeCommit`: the merged head must equal the last SHA you
   pushed. PRs land as squash commits, so never test `<sha>` against `origin/main` ancestry. If
   the heads differ, `git fetch origin` and `git fetch origin pull/<n>/head` (the branch may be deleted; the first refreshes `origin/main` for any follow-up branch) and compare `git diff <sha> <headRefOid>` for the PR's
   paths (a later commit can undo your work even when `<sha>` is an ancestor). Only changes
   really missing go in a small follow-up PR (cherry-pick onto a fresh branch from `origin/main`).
2. `gh run list --commit <merge-sha> --event push --limit 100`. Without `--event push` and the
   higher limit, the many gate `workflow_run` entries hide the push runs.
3. Reverts: a commit reverts the PR when its body has `This reverts commit <sha>` matching the
   merge SHA or any PR commit (prefix match). Do not grep the word "revert".
4. A red push run: report it on the PR and the Jira issue; fix-forward or revert only when authorized.

## Common mistakes

- Waiting for "no remote run in progress" while other sessions keep queueing.
- Reporting a DB spec as passed from a green job or per-test time alone.
- Reading `gh run list --commit <sha>` with the default limit and concluding "no push run".
