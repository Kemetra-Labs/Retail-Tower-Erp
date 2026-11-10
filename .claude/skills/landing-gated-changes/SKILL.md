---
name: landing-gated-changes
description: 'Use when a Retail Tower change touches a gated or policy path — .github, .circleci, tools/project-graph, CODEOWNERS, an OpenAPI contract, a Backend-Core migration, package.json or a lockfile — or adds a new top-level folder, removes or renames a contract field, backfills a FORCE RLS table, or a PR needs a "[GATED: …]" title.'
---

# Landing gated changes

## Overview

Repo `CLAUDE.md` says what is gated and that the Jira issue must authorize it (sections 9, 10 and
"Policy class"). This skill adds how each gated kind lands safely in this monorepo. A gated change
still goes through `merging-rt-pull-requests` for push, CI and merge.

When a rule below conflicts with what the owner explicitly asked for (a path they named, "one
file", "prove it before the PR"), stop and tell them which rule applies and the options, and wait
for their choice. Do not quietly do something different.

**Related:** CircleCI `write-config` (validate a config change), `nestjs-drizzle-bullmq`
(Backend-Core patterns), `api-design`, `reviewing-pull-requests` (fresh subagent; offer the owner a deep review
for migrations, contracts, auth or money).

## Before anything: how CI sees the paths

From `tools/project-graph/`: `python -m pgraph classify-tree --repo ../.. --rev HEAD` and
`python -m pgraph evaluate --repo ../.. --base origin/main --head HEAD --event pull_request --out <scratch>/plan.json`.
- A new **top-level folder** is unclassified (the `root` class `"*"` matches root files only), so
  the selftest fails. Put the file under an existing class (`docs/**`, `.claude/skills/**`) or make a
  `graph.yaml` change, which is itself a policy change.
- `plan.json` shows the selected jobs and whether policy approval applies. In `observe` mode the
  approval is printed in the `required` summary but does not block.

## PR title tag

Name every gated kind in the title: `[GATED: .github]`, `[GATED: .circleci]`,
`[GATED: tools/project-graph]`, `[GATED: contract]`, `[GATED: migration]`, `[GATED: deps/lockfile]`,
combined as `[GATED: .github, .circleci]`.

## `.circleci/**`

The remote guard refuses any branch whose `.circleci/` differs from `origin/main`, so a CircleCI
change cannot be preflighted with `remote_suite`. Prove it offline (`validate_config`,
`node --test .circleci/scripts/*.test.cjs`); it selects only `contracts/check`. The first real run is
after the merge, from a branch whose `.circleci/` equals the new `main`.
State this in the PR body.

## Contracts (OpenAPI under `services/backend-core/packages/contracts/openapi`)

- `contracts/check` compares every consumer PIN (POS, Admin Console, Connector) with the in-tree
  contract in the same PR and fails closed. A field removal or rename breaks it.
- `bc/oasdiff` fails on breaking changes; an acknowledged break needs a line in
  `services/backend-core/tools/oasdiff/breaking-ignore.txt` tagged `consumer:<NAME>` (`POS`,
  `admin`, `connector`) for each affected consumer, or `consumer:none` (README there).
- Remove or rename in slices, as RT-1181 to RT-1184 did: (1) Backend-Core accepts the field as
  optional and nullable; (2) each consumer stops sending or storing it; (3) remove it. Each contract
  change (slices 1 and 3) turns the consumer PINs red in `contracts/check`, which has no ignore
  file, so once it is on `main`, repin every affected consumer to that `main` commit in a follow-up
  PR (`npm run contracts:repin -- --ref <sha>` in `apps/pos`; `pnpm generate:client --repin <sha>`
  in `apps/admin-console`, committing the regenerated client; the Connector PIN by hand), as #317
  and #321 did. Never pin a branch-only commit: CI reads the pinned commit from git, and a squash
  merge drops it. Each slice is its own issue when the consumers are out of scope.
- **A default value or description edit is not a break (RT-1316, #485).** oasdiff rates
  `request-property-default-value-changed` as INFO, and
  `services/backend-core/tools/oasdiff/severity-levels.txt` does not raise it. `contracts/check`
  fails only on WARN or ERR; for these edits it prints a `DRIFT` line and stays green, even though
  the consumer PINs still list the old blob (#485 changed two pinned contracts with no repin). Do not
  repin, and do not edit a vendored copy under `apps/pos/contracts/` in the same PR: that breaks its
  pin hash. The copy and the generated `api-types.ts` catch up at the next repin to a `main` commit.
- **Bumping `info.version` breaks version-pinning specs.** Backend-Core specs assert contract
  versions (for example `devices*.contract.spec.ts` and `pos-terminal-pairing/*.contract.spec.ts`).
  Before the first push, grep `services/backend-core/apps/api/test` for the old version string and
  its escaped form (`1\.7\.0`), and add a version note paragraph in the contract's own style. When a
  sibling branch drafts against the same file, say the new version in the PR body or on the Jira
  issue so it takes the next one.
- **Grep the consumers for the old value of a default you change.** #485 moved the pairing TTL
  default from 60 to 1440, and `rg "Default 60|60 minutes" apps` still found the Console help text
  (`apps/admin-console/src/i18n/messages/*/devices.ts`), code comments in
  `apps/admin-console/src/lib/device-queries.ts` and the POS runbook
  (`apps/pos/docs/runbook/pilot-terminal-provisioning.md`). Update each stale copy or name the issue
  that owns it in the PR body; never leave one unowned.

## Migrations (`services/backend-core/packages/db/drizzle/`)

- **DDL and backfill in separate files.** Each file runs in its own transaction; a column add plus
  backfill in one file holds ACCESS EXCLUSIVE until the backfill commits.
- **Backfill is idempotent and re-run after deploy.** The old API and worker keep writing while
  `migrate` runs, so a one-pass backfill misses their rows.
- **FORCE RLS:** the migration owner is NOSUPERUSER, so a plain read sees 0 rows. Set
  `app.is_platform_admin`, pin `app.current_tenant` to the nil UUID before `FOR t IN SELECT id FROM tenants`,
  then set the tenant GUC per iteration with an explicit `tenant_id = t` predicate. Never lift FORCE RLS.
- **Spec as the real owner:** Testcontainers runs as superuser and bypasses RLS. Test with
  `asMigrationOwner` (`packages/db/__tests__/_helpers/migration-spec.ts`) and pre-set the session
  GUC to `''` so the empty-GUC cast case is covered.
- **New table:** register its runtime grant in the grant registry
  (`services/backend-core/apps/api/src/auth/grant-registry.ts`, checked at boot as
  `DOMAIN_REQUIRED_GRANTS`) and add a `services/backend-core/docs/operations/sql/*-domain-grants.sql`
  deploy step, or production boots healthy and fails later.
- An index on a hot table: a single-statement `CREATE INDEX CONCURRENTLY` migration file (precedents
  `0036`, `0048`), proven with `expectSingleConcurrentStatement` from
  `packages/db/__tests__/_helpers/concurrent-index-migration.ts`.

## Dependencies and lockfiles

- A library used by two or more products is listed in `tools/versions/shared-deps.yaml` and must
  carry one version everywhere (guard: `.github/scripts/shared_deps.py`). Bump all products in one
  PR; Renovate does this. The guard (`project-graph.yml`) runs in report mode today: a
  single-product bump only warns, but still align it (enforcement follows RT-924).
- Each product has its own package manager and lockfile (`toolchain` in `graph.yaml`: POS npm,
  Admin Console and Backend-Core pnpm, Connector uv). Read the product's `package.json` first: a
  library can be pinned only through `pnpm.overrides`, not as a direct dependency.
- Check the lockfile diff touches only the intended packages.

## Common mistakes

- Assuming "it's just markdown" means CI won't care about a new top-level folder.
- Removing a contract field in one PR because "consumers will cope".
- Proving a migration with a superuser spec.
