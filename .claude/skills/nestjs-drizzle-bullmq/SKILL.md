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
- Keep decimals exact: scaled `bigint` arithmetic (see `apps/api/src/common/quantity/decimal-quantity.ts`), never `Number` / `parseFloat`.
- `GlobalExceptionFilter` maps Postgres 22003/23514/22P02 (walking `cause`) to a 400 envelope and records metrics. A new mapped class needs its metric call and a spec assertion.

## Tenancy (RLS)
- All tenant data access goes through `withTenant(db, tenantId)`. Raw clients set `set_config('app.current_tenant', $1, true)` (plus `app.is_platform_admin`) inside the transaction. Bootstrap and CLI lookups need RLS context too.

## Outbox / workers
- Size pools for nested queries. A consumer can hold one transaction client while a view opens a second, and lease renewals need a free connection. Claim limit = `floor((poolMax - 1) / connectionsPerClaim)`.
- Extract the OTel `traceContext` carrier **before** Zod `safeParse`, because Zod strips unknown keys. Prove it with a test that captures `traceId` inside the collaborator, not "process() resolves".

## Idempotency
- The current store design is in `services/backend-core/docs/idempotency/strategy.md` (it describes Redis-primary storage with a Postgres mirror); follow that document, not older branch designs. In-flight markers include the tenant; body fingerprints sort keys.

## HTTP status of a Console POST
- A Nest `@Post` answers **201** unless `@HttpCode(HttpStatus.OK)` is set, and an idempotent replay repeats the stored status. When the contract documents `"200"` only (a write-off, a repair, any "act on an existing item" POST), add `@HttpCode(HttpStatus.OK)` and assert `Reflect.getMetadata(HTTP_CODE_METADATA, handler)` is 200 in the controller unit spec. In the HTTP spec use `.expect(200)`, never `status < 300`, which cannot tell 201 from 200 (RT-1312 slice B review: the first draft answered 201; the sibling `consoleRepairSaleSync` route still does).
- `@Roles("owner", "tenant_admin")` without `{ denyAs: 403 }` answers a wrong role **404**, while a contract that lists `Forbidden` says 403. The sale-sync-ops family uses the 404 default; match the family and say so in the PR rather than mixing.
- A jscpd clone against a sibling controller (`requireTenant`, a try/catch error mapper) fails the code-health ratchet: use module-level helper functions with different shape and one private `inTenant(input, fn)` wrapper for `runWithTenantContext` instead of repeating the sibling's blocks.
- **A new controller or service in a module imports other modules only through their root `index.ts` (RT-1453, RT-1312 slice B).** `pnpm lint:eslint` also runs `lint:module-boundaries`, which `bc/fast` runs and the unit specs do not: deep imports such as `../../auth/roles.guard`, `../../context/tenant-context.guard` or `../../audit/auditable.decorator` are new violations, and `baseline.json` may only shrink. Before the first push run `node tools/module-boundaries/check.mjs` and `node tools/import-cycles/check.mjs` from `services/backend-core` (the `node --test` part of `lint:cycles` fails on Windows with EPERM on a symlink: environment only). Slice B built the ports: `audit/index.ts` (`Auditable`, `annotateAudit`), `auth/index.ts` (`DashboardAuthGuard`, `Roles`, `RolesGuard`), `console-rate-limit/index.ts`, `idempotency/index.ts` and `context/index.ts` (`TenantContextGuard`, `TenantContextRequest`, `MembershipRepository`, `callerStoreScope`, `scopeStoreIds`, `StoreScope`); extend them, import from `../../auth` and so on.
- Never write a `...array` spread of request data into `push`/`Math.max`: a 256 kB body holds about 130k elements and overflows the call stack (RangeError, a 500). Loop instead.

## Tests / CI
- After `reset --hard`/checkout that changes `packages/shared` or `packages/db`, rebuild dist (`pnpm --filter @data-pulse-2/shared run build`, then db). "Symbol not registered / suite failed to run" means stale dist.
- db-integration `57P01 terminating connection due to administrator command` on a random unrelated suite is the known Testcontainers/Ryuk flake. Confirm the victim is unrelated AND the signature matches, then `gh run rerun --failed`. `--runInBand` is a no-op on 2-vCPU runners. Never `--admin` past it.
- Coverage floors come from the **CI-measured** baseline, not a local reading.
- ts-jest passes a type error that `tsc` rejects. Before the first push of a Backend-Core change, run `(cd services/backend-core/apps/api && npx tsc -p tsconfig.build.json --noEmit --incremental false)` (build `@data-pulse-2/shared`, `db` and `auth` first). RT-1367: a `new Map(rows.map(... as const))` keyed by a template literal passed every spec and failed the Docker image build (`pnpm -r run build`), so `e2e/smoke` went red; annotate such maps `new Map<string, bigint>(...)`.
- **A `worker_threads` heap cap does not hold under a process-wide heap flag (RT-1598).**
  - **Symptom:** a Worker's `resourceLimits.maxOldGenerationSizeMb` is ignored when the parent process has `--max-old-space-size`. CircleCI api-jest sets `NODE_OPTIONS=--max-old-space-size=4096`. A 232 MB cap still reported `heap_size_limit` 4,120 MB on Node 24.
  - **What does not fix it:** passing `execArgv: []`, or clearing `NODE_OPTIONS` in the Worker's `env`.
  - **For a real memory bound in a spec:** spawn a child `node` with `--max-old-space-size=232 --max-semi-space-size=8` (limit exactly 256 MB) and `NODE_OPTIONS` cleared. See `test/inventory/redistribution/benchmark.unit.spec.ts`.
  - **For production:** if compute moves off-thread (RT-1600), do not rely on Worker `resourceLimits` as a cap while the API runs with a heap flag.

## AI Gateway feature routes (RT-1539, Manager Sales)
- **`@Auditable` fires on every 2xx and cannot skip.** A route that audits only some 200 outcomes (an `answer`, not a `refusal`) enqueues the event itself through `AUDIT_JOB_ENQUEUER` (`audit/index.ts`), fire-and-forget with the error class logged, and keeps the action out of `audit-action-kinds.ts` (GET-only, drift-guarded).
- **A feature route imports `AiModule.withOverrides({ imports, providers })`**, never the plain `AiModule`: the safe defaults stay and only `AI_FEATURES` and `AI_EVIDENCE_BUILDER` are replaced. The evidence builder's own dependencies come from `imports` (the sales services are exported through `console-sales/index.ts`).
- **A Tier-0 product refusal is `preflight`, not a fallback.** It runs after the kill switch and entitlement and before budget and reserve, so a refusal reads and charges nothing; the Gateway returns `{ kind: "declined" }`, which the route maps to the feature's own refusal body.
- **The route refuses the store scope before the Gateway** role-aware like the sales reads (owner/tenant_admin are not narrowed by the active store, so pass `{...ctx, storeId: null}` to the Gateway too) and the non-disclosing 404; a platform-admin refusal is a guard (it must beat request validation), not a check in the handler.
- **The tool that writes source files may turn a `\uXXXX` escape into the literal character.** Build bidi and Arabic-mark classes from code points (`msx.text.ts`), then `grep -P` the sources for `\x{202A}-\x{202E}`, `\x{2066}-\x{2069}` and `\x{064B}-\x{065F}` (eslint `no-irregular-whitespace` catches some).
- **A test idempotency key must not be a `const KEY = "..."` literal:** gitleaks `generic-api-key` flags it in any commit of the branch, and a later fix does not clear the full-history scan (re-land on a clean branch). Build it at run time (`["rt1539", "route", "0001"].join("-")`).
- A template written once against a `FigureSource` runs over the live reads (recording the pack) and over the pack alone (rendering), so "every cited ref is in the pack" holds by construction.
