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

## Depot CI pre-push preflight (RT-1366, INACTIVE until the owner activates it)

Provider selection lives in repo `CLAUDE.md` section 11 step 5 ("Provider selection"); read it there.
This is only the how. Do nothing here while that block is marked INACTIVE. It covers one family:
Backend-Core db + worker, on **uncommitted** work, before a push. Everything else stays on CircleCI.

- **Authorize first.** Each run is billable and needs the owner's per-run approval. Re-read the Depot
  CI minutes cap (Billing page, or an org token from the owner) before it; never estimate it.
- **New files only:** `git add -N <path>` each new file you want tested. `depot ci run` uploads tracked
  changes only, so an unregistered new file is silently missing and the run still passes. Never
  `git add -A` or `git add .`, never stage unrelated files, and undo the intent-to-add afterwards
  (`git reset -q -- <path>`).
- **`.github/workflows/**` changes are not carried in the patch.** A change to CI wiring is proven only
  by the PR's first GitHub run. Do not list such a path in the expected-files list: the run fails on it.
- **Invoke** from the worktree, with the Depot org set (`depot org show`):

  ```bash
  depot ci run --workflow .depot/workflows/preflight.yml --repo Kemetra-Labs/Retail-Tower-Erp
  ```

  `depot ci run` has no `--input` flag, so inputs keep their defaults (both suites). List the files that
  must arrive in an uncommitted `.depot/expected-files.txt` (one path per line; `git add -N` it; never
  commit it). Pre-flight check, no Depot run: `git status --short` shows every new file as ` A` (intent).
  `depot ci dispatch --input suite=db` takes inputs but runs a pushed ref with no local patch, so it
  does not apply here.
- **Read the patch-evidence step first.** It prints each changed file with its sha256 on the runner. Compare
  with `sha256sum` locally. A `FAIL` line means the run proved less than your local work: fix the
  registration and re-run only with the owner's approval.
- **On failure or an unusable run** (patch evidence fails, Depot outage, cap exhausted, a result you cannot
  explain): do not retry in a loop. Report it, then use the CircleCI `remote_suite` table above, which
  needs a pushed `<pr-branch>-preflight` branch under the RT-981 rules. Never run both providers on the
  same test by default.
- **Evidence before any push**, as a comment on the Jira issue: the Depot run ID, db and worker suite and
  test counts with pass/fail, the patch-evidence output (files and sha256), the command exactly as run, and
  the Depot minutes read from Billing afterwards. A green Depot run is a pre-push signal only; GitHub
  `required` on the exact head still decides the merge.
- `.depot/**` is a policy path: change it only in a `[GATED: .depot, tools/project-graph]` PR and see
  `landing-gated-changes`. The workflow must stay `workflow_dispatch` only (Depot may register triggers of
  a `.depot/workflows` file on the default branch).

## POS source-scope guard and the `pos` preflight

The POS test `src/renderer/__tests__/source-scope-guard.test.ts` fails any branch that changes
`src/main/pairing/`, `src/main/secrets/`, `src/shared/api-types.ts`, `scripts/codegen-api.ts`,
`scripts/openapi-snapshot.json` or `.github/workflows/` (the prefixes are in
`source-scope-guard.const.ts`). Only the full suite catches it: targeted vitest runs never load it.

- **When the issue's scope needs one of those files**, add a narrow exemption in the same PR:
  - the exact file list on the exact PR branch name, with a `source-scope-guard-rt<n>.test.ts`
    narrowness test (pattern: RT-869, RT-1316);
  - cite the authority: the owner-authored Jira scope, or an owner decision;
  - never shrink the prefix list.
- **The `<branch>-preflight` branch is not exempt.** This is by design: the narrowness tests assert
  it (RT-1231, RT-1316). A `pos` preflight of such a change therefore fails exactly that one test.
  - Read the job's test list. If the guard is the only failure, the preflight counts as green for
    the code. Say so on the Jira issue.
  - GitHub `required` on the PR branch is the run that must be fully green.
- `boot-single-instance.test.ts` can fail under a full parallel local run on this laptop and pass
  when run alone (seen 2026-11-10). Re-run it alone before treating it as real.

Two suites on one branch: trigger each on its **own** preflight branch (for example
`<pr-branch>-preflight` and `<pr-branch>-preflight-e2e`, same SHA). A second pipeline on the same
branch auto-cancels the first as redundant, whatever its `remote_suite` (RT-1316: `admin` was
cancelled 2 s after `admin-e2e` was triggered on the same branch). The cancelled trigger still
counts toward the daily cap.

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

## Red checks that are ratchets or history, not your logic (RT-1347, 2026-11-12)

- **gitleaks scans the whole PR history, not the tip.** A secret-shaped test fixture (a token, a JWT, a PEM
  header, a key id) written as a literal in any commit of the branch keeps `gitleaks` red, and a fix commit on
  top does not clear it. Build such values at run time (`'gh' + 'p_' + 'x'.repeat(36)`) from the first commit,
  and use `example` or `.invalid` hosts. If a literal already landed in a commit: re-land the work on a clean
  branch from `origin/main` (new branch, new PR, one clean commit; close the old PR). Never force-push to
  rewrite the old branch; the owner's rule is no force-push.
- **The POS ratchets fail `pos/static`.** `knip` (an unused file or export, or an unlisted dependency) and
  `jscpd` (duplicate clones in `src/`) are counted against `scripts/code-health.baseline.json`, and the size
  of `src/main/index.ts` against `scripts/index-size.baseline` (RT-893: it may only shrink). A new helper goes
  in its own module, not in `index.ts`; new `scripts/pilot/**` and `scripts/*.ts` files are knip entries, so
  their exports are never flagged. Do not import a package that is only a transitive dependency (for example
  `@electron/asar`): knip reports it unlisted, and adding it is a gated lockfile change. Local checks:
  `node scripts/check-index-size.mjs` and `node scripts/check-code-health.mjs` (the latter needs knip from
  `npm ci`; `npx knip` fetches a different version and is only a hint). Never lower a jscpd baseline from a
  Windows run (see `troubleshooting-windows-dev`).
- **The CircleCI trigger tool returned "Route Not Found" for the POS project slugs tried on 2026-11-12.** Do
  not loop over more slugs, and do not read it as a failed suite: nothing ran, so no preflight evidence
  exists and nothing counts against the 30-per-day cap that you can see. Say so on the issue (which slugs,
  the exact message) and either get the right project slug from the owner or get an owner-approved exception
  for this change. GitHub `required` and the local light checks never replace the CircleCI preflight (repo
  `CLAUDE.md` section 11, step 5): without a preflight, do not push the change to the PR branch as if it had
  one, and do not merge on the strength of GitHub CI alone.

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
  `curl` check succeeds (200, or 206 because it asks for a byte range); a push or a re-run during the outage just fails again.
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

- Putting a secret-shaped literal in a test fixture, then trying to fix it with a later commit (gitleaks reads
  the history).
- Waiting for "no remote run in progress" while other sessions keep queueing.
- Reporting a DB spec as passed from a green job or per-test time alone.
- Reading `gh run list --commit <sha>` with the default limit and concluding "no push run".
