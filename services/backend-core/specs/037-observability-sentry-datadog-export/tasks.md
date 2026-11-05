# Tasks: Observability — Sentry Errors + Datadog OTLP/Logs Export

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Branch**: `037-observability-sentry-datadog-export`

## Format: `[ID] [P?] [Story] Description`
- **[P]** = parallelizable (different files, no dependency)
- **[Story]** = US1 (Sentry errors) / US2 (Datadog OTLP) / US3 (logs + synthetics)

> **Execution is owner-gated.** These tasks are NOT started by authoring this file. Each touches DP-2 application code/config and runs only when AD-TOOL-003 Phase 1/2 is separately owner-approved and the env keys exist in 1Password. Tests-first per Constitution VI.

> **Reconciled 2026-11-05 (RT-1245).** A task is checked only where GitHub `main` (`8d25c3f7e`) or linked lab evidence proves it; the line under it cites that evidence. Unchecked tasks name their reason. See spec.md, "Implementation Reconciliation (2026-11-05)".

## Path Conventions
- API: `apps/api/src/`, worker: `apps/worker/src/`, shared: `packages/shared/src/`.

---

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 [P] Add `@sentry/node` to `apps/api` + `apps/worker` deps (gated; the only `package.json` change). Add empty `SENTRY_DSN`, `DD_*`/OTLP keys to each `.env.example`.
  - Evidence: `@sentry/node` 11.8.0 in `apps/api` and `apps/worker` `package.json`; empty `SENTRY_DSN`/`SENTRY_RELEASE` and commented OTLP keys in `deploy/prod.env.example` (not per-app `.env.example`). RT-609.
- [x] T002 [P] Confirm 1Password entries + droplet env wiring for the new keys (no key committed). Verify `.env.example` defaults are empty (default-inert).
  - Evidence: DSNs held in 1Password and set in the lab env (RT-617 comments 12523-12535, RT-638); `deploy/prod.env.example` defaults are empty.

## Phase 2: Foundational (Blocking Prerequisites)

- [x] T003 Define the DP-2 Sentry forbidden-key set aligned to `.specify/memory/redaction-matrix.md` (single source of truth; do not fork the matrix).
  - Evidence: an allowlist rebuild instead of a forbidden-key set, in `packages/shared/src/observability/sentry.ts` (`scrubSentryEvent`), with test 'never allowlists a key from the redaction matrix' and the shared RT-879 vectors.
- [x] T004 Confirm the `startOtel()` signature/seam in `packages/shared` can accept an optional OTLP exporter without changing existing Prometheus-drain behavior (US2 prerequisite).
  - Evidence: `packages/shared/src/observability/otel.ts` passes an `OTLPTraceExporter` to the NodeSDK beside the Prometheus reader; `__tests__/observability/otel.spec.ts`.

## Phase 3: User Story 1 — Sentry backend exceptions (P1) 🎯 MVP

### Tests for US1 ⚠️ (write first)
- [x] T005 [P] [US1] Unit: `initSentry` is a no-op when DSN empty/whitespace (default-inert, AC-1).
  - Evidence: `packages/shared/__tests__/observability/sentry.spec.ts` 'does not call the SDK when the DSN is empty'.
- [x] T006 [P] [US1] Unit: `beforeSend` strips `request`/`user`/forbidden keys and returns `null` when nothing safe remains (AC-2).
  - Evidence: same file, 'drops request, user, extra, contexts, breadcrumbs and transaction' and 'returns null when no exception remains'.
- [x] T007 [P] [US1] Unit: a throwing `sentryInit` is caught, logged once **without** the DSN, service continues (AC-3).
  - Evidence: same file, 'catches a throwing SDK init, warns once without the DSN, and continues'.

### Implementation for US1
- [x] T008 [US1] `apps/api/src/observability/sentry/sentry.ts` — DSN-gated init + `beforeSend` scrub-or-drop, DI-seam'd `sentryInit` (mirror POS-Pulse).
  - Evidence: `apps/api/src/observability/sentry/sentry.ts` (`initApiSentry`, on the shared `initSentry`); HTTP 500 capture in `apps/api/src/common/exception.filter.ts`. RT-609, RT-631.
- [x] T009 [US1] `apps/worker/src/observability/sentry/sentry.ts` — same for the worker.
  - Evidence: `apps/worker/src/observability/sentry/sentry.ts`, plus final job failures in `failed-job.ts` (RT-698).
- [x] T010 [US1] Wire init at module-eval in `apps/{api,worker}/src/main.ts`/`instrumentation.ts` (after, never blocking, the existing OTel bootstrap).
  - Evidence: `apps/api/src/instrumentation.ts` and `apps/worker/src/instrumentation.ts` import and call the init at module evaluation.

**Checkpoint**: induce a controlled exception in preprod with DSN set → scrubbed event in the `backend-core` Sentry project (org `kemetra`, EU; planned as `data-pulse-2`); empty DSN → identical-to-today boot.

## Phase 4: User Story 2 — Datadog OTLP metrics/traces (P2)

### Tests for US2 ⚠️
- [ ] T011 [P] [US2] Unit: Datadog exporter is NOT registered when keys empty (existing Prometheus drain intact, AC-1).
  - Open: the OTLP exporter is always constructed (not key-gated); inertness relies on the unset endpoint/agent. No test pins the stated behavior.
- [ ] T012 [P] [US2] Unit: registering the OTLP exporter does not rename/duplicate existing `getMeter` signals (AC-2).
  - Open: no test found that pins 'no rename/duplicate after OTLP registration'.

### Implementation for US2
- [x] T013 [US2] Register the Datadog OTLP exporter as an additional drain in `apps/api/src/instrumentation.ts` `startOtel({…})` (per OD-1 ingest decision).
  - Evidence: registered through the shared `startOtel()`/`createOtelSdk` (`otel.ts`), sent to the Datadog Agent OTLP `:4318` (`deploy/README.md`). RT-609; lab traces RT-631/RT-638.
- [x] T014 [US2] Same registration in `apps/worker/src/instrumentation.ts`.
  - Evidence: the worker uses the same shared bootstrap in `apps/worker/src/instrumentation.ts`; worker traces proven on the lab (RT-631, RT-684).
- [ ] T015 [US2] Apply conservative trace sampling (env-driven; ~10% head + 100% on error/checkout spans, FR-010).
  - Partly done: 10% head sampling (`OTEL_TRACES_SAMPLER_ARG`) and forced sampling of chosen spans exist; '100% on error/checkout spans' is not implemented.

**Checkpoint**: `signals.md` signals appear in Datadog, no rename, no new endpoint.

## Phase 5: User Story 3 — Redacted logs + synthetics (P3)

### Tests for US3 ⚠️
- [ ] T016 [P] [US3] Assert shipped log fields are redaction-matrix-compliant (AC-1).
  - Not built: log shipping is out of scope for RT-617.

### Implementation for US3
- [ ] T017 [US3] Configure Datadog Logs shipping of the already-redacted structured logs (WARN+ default, INFO sampled).
  - Not built: log shipping is out of scope for RT-617.
- [x] T018 [US3] Configure Datadog Synthetics against existing routes only (OD-2 target list) — **no new endpoint** (FR-008).
  - Evidence: `deploy/datadog/synthetics-api-health.json` targets only the existing `/api/v1/health/ready` (RT-637).

**Checkpoint**: Datadog Logs redaction audit clean; synthetics hit only pre-existing routes.

## Phase N: Polish & Cross-Cutting

- [ ] T019 [P] Update the orchestrator `CLAUDE.md` allowed-egress confirmation reference (already merged PR #169) — verify, don't re-author.
  - Not applicable: the Orchestrator is retired (AD-ORCH-003); the egress rule now lives in `services/backend-core/CLAUDE.md`.
- [x] T020 Redaction audit (US1 events + US3 logs): zero forbidden keys / zero business payload (SC-002, SC-004).
  - Evidence (Sentry events only; no logs are shipped): RT-638 redaction audit, with F-A fixed by RT-682/RT-694 and re-verified on the lab.
- [ ] T021 Set Email + Telegram alerting (Phase 0 OQ-5) in-tool (not code).
  - Open: owner decision D8 (2026-10-17) amended routing to email only, Telegram parked. Datadog email alerts are live (RT-637); Sentry rules are RT-1244.
- [ ] T022 Record first-pilot-week ingestion volume → propose the budget cap (closes Phase 0 OQ-1 / OD-4 retention input).
  - Open: no ingestion-volume record found.

## Dependencies & Execution Order

- Phase 1 → Phase 2 → US1 (P1, MVP) → US2 (P2) → US3 (P3) → Polish.
- US1 is independently shippable (the MVP): it needs only Phase 1–2, not US2/US3.
- US2 depends on T004 (the `startOtel()` seam). US3 depends on the Datadog account from US2's setup.

### Parallel Opportunities
- T001/T002 parallel. T005/T006/T007 parallel (separate test files). T011/T012 parallel.

### Gate reminder
Every implementation task (T008+) is real DP-2 code/config and is **owner-gated**; do not begin without explicit per-slice approval. No task adds an endpoint, OpenAPI surface, or migration.
