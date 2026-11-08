> Program-wide operating instructions (Retail Tower OS §1–15 and the RT-948 push/merge rules) live in the root [CLAUDE.md](../../CLAUDE.md), which always loads. Only this product's additions are kept here.


# Data-Pulse-2 — Agent Context

Multi-tenant SaaS rebuild for Data Pulse. The legacy `Data-Pulse` repo is reference only — never copy without re-spec'ing here.

## Repo-specific read order

**The former "Agent OS / Maestro" operating mode is retired** (superseded by the RT operating instructions in the root CLAUDE.md). `docs/agent-os/maestro-playbook.md`, `execution-map.yaml`, and `wave-status.md` are historical per-spec records only — they are not an active dispatch system, and "Execute slice X" is not a valid task form. The unit of work is a Jira issue (`Execute RT-XX`).

Bootstrap read order for every agent session:

1. `git fetch origin`; branch a new task from current `origin/main`, but on an existing task branch or worktree stay on it and compare with `origin/main` (root CLAUDE.md §7).
2. [.specify/memory/constitution.md](.specify/memory/constitution.md) — 14 Core Principles; source of truth for all design constraints.
3. [docs/agent-os/standing-rules.md](docs/agent-os/standing-rules.md) — repo engineering gates only (branch hygiene, forbidden paths, git discipline, reporting format); subordinate to the RT operating instructions in the root CLAUDE.md for anything about work source, authority, or scope.
4. GitHub PRs / CI checks / CodeRabbit reviews — current authoritative state for in-flight work.

Do not duplicate standing-rules content here.

**Mapping standing-rules.md's forbidden-surface gate to Jira.** `standing-rules.md` §3 (forbidden surfaces) and §7 (stop conditions) still speak in terms of a retired "slice brief" providing `allowed_files`/`forbidden_files` and `[GATED]` approval. Since there is no slice brief under the RT operating model, map those clauses as follows: `allowed_files` = the scope stated in the Jira issue (RT operating instructions §8); `[GATED]` approval = explicit authorization written into the Jira issue or given by the owner (RT operating instructions §10); if the issue doesn't make the scope or gate status clear, that is the §14 stop condition "Jira scope is ambiguous" — stop and ask on the issue rather than proceeding or improvising a brief.

## Constitution

[.specify/memory/constitution.md](.specify/memory/constitution.md) (v3.0.0) — read it when principle text matters; do not paraphrase from memory. Key principles: §II multi-tenant RLS, §III backend authority, §IV contract-first, §VIII reproducible releases (`[GATED]` required), §XII object safety, §XIV PII discipline.

## Allowed observability egress (RT-629 OBS-1 §6, D9)

> **Allowed observability egress.** This service may send telemetry only to Sentry (`*.ingest.de.sentry.io`, org `kemetra`) and Datadog (`*.datadoghq.eu`, the EU1 org, per the owner decision of 2026-10-19 that supersedes D5; `*.us5.datadoghq.com` stays allowed only until the RT-736 cutover is verified and as rollback; or the internal Datadog Agent). It must follow the Observability contract (RT-629): allowlisted fields only, no PII, secrets or business payloads, default-inert without keys, and never blocking on vendor failure. Any new destination is a separate owner decision.

## What this repo does NOT own

Does not own POS (`Kemetra/POS`) or the admin/operator frontend (`Kemetra/Admin-Console`) — see the root CLAUDE.md §3 for repo ownership. This repo owns the SaaS backend, workers, infrastructure, and the OpenAPI contracts both POS and Admin-Console consume.

## Stack

See the package manifests for versions. Not in the manifests: Prometheus exporter on API `:9464` and worker `127.0.0.1:9091`; auth is argon2id with opaque revocable bearer tokens (API/POS) and httpOnly cookie sessions (dashboard humans); IDs are UUIDv7 with UUIDv4 fallback. Gotcha: `MIGRATION_TEST_ALLOW_SKIP=1` allows Docker-less local runs of the migration tests.

The Admin-Console (`apps/admin-console/` in this monorepo) depends only on the OpenAPI contracts produced here.

## Working agreement

See [docs/agent-os/standing-rules.md](docs/agent-os/standing-rules.md) for repo engineering gates (subordinate to the RT operating instructions in the root CLAUDE.md for work-management authority). Critical gates:

- Never commit / stage / push / merge / open PR without explicit instruction.
- Forbidden paths require `[GATED]` approval: `package.json`, `pnpm-lock.yaml`, SQL migrations, `packages/contracts/openapi/**`, `.github/**`.
- Untracked `bin/` and `externals/` are not part of any Jira issue's scope — leave them alone.
- Stop conditions named in the Jira issue mean stop and report. Do not silently expand scope.
- RT-805 (no shared lines across parallel PRs): never edit `CHANGELOG.md`. Add `changelog.d/RT-<n>-<slug>.md` instead (format in `changelog.d/README.md`; check with `node tools/changelog/assemble.cjs`). A contract-only operation is registered only by its `x-runtime-status: contract-only` + `x-runtime-note` markers; there is no hand-kept list in the conformance spec. A `cookieAuth` operation's console rate-limit class goes in its contract's own `apps/api/test/console-rate-limit/classes/<contract>.rate-limit.yaml` (no shared SNAPSHOT/INTENT list); a runtime lift drops only the marker. See CONTRIBUTING.md.
