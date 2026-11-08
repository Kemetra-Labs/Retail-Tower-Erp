---
name: nestjs-drizzle-bullmq
description: Use when changing Backend-Core (Data-Pulse-2) or its dp2-* worktrees — NestJS modules/providers, Drizzle + pg with RLS, BullMQ/outbox workers, idempotency, the global exception filter, numeric/money DTO validation, or Jest db-integration tests with Testcontainers.
---

# Backend-Core: NestJS + Drizzle + BullMQ

## Overview
Repo docs are authoritative. Read `services/backend-core/docs/idempotency/strategy.md`, `services/backend-core/docs/outbox/*.md` and `services/backend-core/docs/observability/signals.md` before touching those areas, plus the constitution and standing rules `services/backend-core/CLAUDE.md` lists. This skill covers only the traps that keep recurring.

## DI wiring (NestJS)
- A `useFactory` provider that calls `new X(a, b)` while X's constructor takes optional `c, d` compiles and boots, but `c`/`d` are silently `undefined` (#611: the audit enqueuer and logger were never wired). Pass every constructor dependency, list it in `inject`, and import the module that exports each token (for example `AUDIT_JOB_ENQUEUER` → `OutboxAuditEnqueuerModule`).
- Test the wired module, not only `new X(...)` with hand-passed mocks. Direct construction hides wiring gaps.

## Validation boundary: 400 at the DTO, the DB CHECK is the last resort
- Derive each field's rule from **its own** DB column and CHECK: `> 0` vs `>= 0`, and the `numeric(p,s)` integer digits (`p - s`). A shared validator feeding fields with different CHECKs must be split (`PositiveMoneyString` vs non-negative). Don't tighten the shared helper.
- DTO regexes must match the column. 15 integer digits against `numeric(19,6)` (13 allowed) produced 22003. Update the OpenAPI contracts (`packages/contracts/openapi/**`) in the same change.
- Keep decimals exact: scaled `bigint` arithmetic (see `apps/api/src/inventory/decimal-quantity.ts`), never `Number` / `parseFloat`.
- `GlobalExceptionFilter` maps Postgres 22003/23514/22P02 (walking `cause`) to a 400 envelope and records metrics. A new mapped class needs its metric call and a spec assertion.

## Tenancy (RLS)
- All tenant data access goes through `withTenant(db, tenantId)`. Raw clients set `set_config('app.current_tenant', $1, true)` (plus `app.is_platform_admin`) inside the transaction. Bootstrap and CLI lookups need RLS context too.

## Outbox / workers
- Size pools for nested queries. A consumer can hold one transaction client while a view opens a second, and lease renewals need a free connection. Claim limit = `floor((poolMax - 1) / connectionsPerClaim)`.
- Extract the OTel `traceContext` carrier **before** Zod `safeParse`, because Zod strips unknown keys. Prove it with a test that captures `traceId` inside the collaborator, not "process() resolves".

## Idempotency
- The current store design is in `services/backend-core/docs/idempotency/strategy.md` (it describes Redis-primary storage with a Postgres mirror); follow that document, not older branch designs. In-flight markers include the tenant; body fingerprints sort keys.

## Tests / CI
- After `reset --hard`/checkout that changes `packages/shared` or `packages/db`, rebuild dist (`pnpm --filter @data-pulse-2/shared run build`, then db). "Symbol not registered / suite failed to run" means stale dist.
- db-integration `57P01 terminating connection due to administrator command` on a random unrelated suite is the known Testcontainers/Ryuk flake. Confirm the victim is unrelated AND the signature matches, then `gh run rerun --failed`. `--runInBand` is a no-op on 2-vCPU runners. Never `--admin` past it.
- Coverage floors come from the **CI-measured** baseline, not a local reading.
