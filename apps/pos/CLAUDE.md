> Program-wide operating instructions (Retail Tower OS §1–15 and the RT-948 push/merge rules) live in the root [CLAUDE.md](../../CLAUDE.md), which always loads. Only this product's additions are kept here.

## Pre-flight addition (POS)

In addition to the root pre-flight list:

- for lab, bench, hardware or packaged-POS work: the Confluence page "Lab and Bench Runbook (rt9 lab, packaged POS, hardware)" (RETAIL space, page id 18874418). Read it before starting. It holds procedures only, never secrets or pairing-code values.

At the end of every lab, bench, hardware or verification session, record in Confluence (the runbook page, or the relevant durable page such as Current State) what was done, the procedure that worked, the lessons learned and gotchas, and any failure with its first failing boundary. Jira keeps the work state and the evidence for the issue; Confluence keeps the procedures and lessons that the next session needs. Do not skip this because the Jira evidence comment is already posted.


# POS-Pulse — Agent Context

POS-Pulse is the desktop Point-of-Sale terminal for the SmartDataPulse pharmacy platform. It is
the POS surface of the platform, packaged as an Electron application targeting Windows 10/11 x64.

## Authoritative documents (read these first)

| Document | Purpose |
|:--|:--|
| `.specify/memory/constitution.md` | Project constitution (v1.8.0). Highest-priority document; principles, hardware matrix, platform integration, governance. |
| [`docs/architecture/current.md`](docs/architecture/current.md) | **Canonical current internal architecture.** How POS-Pulse works today. Read before changing main-process wiring. |
| [`docs/architecture/synchronization.md`](docs/architecture/synchronization.md) | The cross-repo boundary: POS ↔ Data-Pulse-2 ↔ Connector ↔ ERPNext. |
| [`specs/README.md`](specs/README.md) | Spec status index — which specs are Active / Implemented / Deferred / Superseded. `specs/**` are historical design records, **not** the authority for current behaviour. |
| [UX/UI Constitution](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/24510466) (Confluence RETAIL, UX-01…UX-13 + Final Audit) and the [VNext Constitution Rebaseline](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/23134234) | **Target UX authority** (owner-approved 2026-10-07): colour, type and icons, layout and shape, interaction, motion, states, accessibility, copy and localization. Ranks below RT-24 / domain contracts and above the VNext freeze package and `docs/DESIGN.md`. Read the modules a UI change touches before starting. |
| [`docs/DESIGN.md`](docs/DESIGN.md) | **Shipped-token record and repo design summary** (with its sidecar `.impeccable/design.json`): the owner-approved RT-104 VNext language reconciled with the Constitution (RT-261) — light-first Tower Teal, Dubai, Western tabular digits, Direction B for the active sale, with each Constitution target marked as not yet shipped. Read before any UI work. Precedence: RT-24 / domain contracts → Constitution → Rebaseline → freeze package → DESIGN.md; where cashier behaviour is concerned RT-24 wins and the conflict is raised. |
| [`docs/design/vnext/`](docs/design/vnext/README.md) | The approved RT-104 VNext planning package (rationale, RT-25 delta, RT-24 invariants, migration map, bounded slices VN-S0…S12). Implementation only through its bounded Jira slices. |
| `docs/design/pos-v3.5/` | **Historical, reference only, not authoritative** (the v3.5 navy / Inter / dark-default handoff). Never implement from it. |
| `_reference/Data-Pulse/` | Read-only legacy reference. Gitignored. **Never copy-paste from here** (Constitution Principle IX). |

## Active feature

Current work comes from Jira RT. Visual authority follows the authoritative-documents table above: the UX/UI Constitution and its VNext Rebaseline rank above [`docs/DESIGN.md`](docs/DESIGN.md), the shipped-token record. Feature history lives in `specs/` and git log.

## Spec Kit workflow

```
/speckit-specify   →  spec.md                (✅ complete for 001)
/speckit-clarify   →  resolve [NEEDS CLARIFICATION]   (n/a — none open)
/speckit-plan      →  plan.md + research.md + data-model.md + contracts/ + quickstart.md   (✅ complete for 001)
/speckit-tasks     →  tasks.md               (next)
/speckit-analyze   →  cross-artifact validation
/speckit-implement →  execute tasks
```

Trivial fixes (typos, log-message tweaks, dependency bumps) MAY skip the pipeline.

## Key technical decisions (locked)

- Stack: Electron 44 + React 19 + Vite 8 + TypeScript 5.6 (strict) + Tailwind 4. The runtime line is
  Electron 44 (`docs/runtime/electron-44-upgrade-plan.md`); RT-986 moved it to 44.9.1 within that line.
- Local DB: `better-sqlite3` with a custom transactional migration runner.
- Secrets: Electron `safeStorage` (DPAPI on Windows). Production refuses to start without it.
- Money: integer minor units, `Number.isSafeInteger` guarded; ≥ 95% coverage on the module.
- Tests: Vitest only.
- Codegen: `openapi-typescript` v7 from a pinned snapshot in 001; live fetch later.
- CI: GitHub Actions on `windows-latest`. Gates: typecheck, lint, tests, package dry-run.

See `specs/001-foundation/research.md` for the full rationale on each.

## Hard rules (always in force)

These come from the constitution and are repeated here for quick agent reference:

- **No floats for money.** Money is integer minor units only.
- **`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`** on every BrowserWindow.
- **No upward-of-bridge IPC.** Renderer reaches the main process exclusively through the typed
  preload bridge defined in `src/shared/bridge-api.ts`.
- **No copy-paste from `_reference/Data-Pulse/`.** Re-derive instead.
- **Test-first.** Add the failing test before the implementation; tasks generated by
  `/speckit-tasks` make this explicit per-task.
- **PII / cards never in logs.**
- **Allowed observability egress.** This service may send telemetry only to Sentry (`*.ingest.de.sentry.io`, org `kemetra`) and Datadog (`*.datadoghq.eu`, the EU1 org, per the owner decision of 2026-10-19 that supersedes D5; `*.us5.datadoghq.com` stays allowed only until the RT-736 cutover is verified and as rollback; or the internal Datadog Agent). It must follow the Observability contract (RT-629): allowlisted fields only, no PII, secrets or business payloads, default-inert without keys, and never blocking on vendor failure. Any new destination is a separate owner decision.
  - POS uses the Sentry channel only (RT-634): no Datadog, no RUM. Main is the only process that
    holds the DSN and talks to Sentry; it refuses a DSN outside `*.ingest.de.sentry.io`
    (`src/main/observability/config.ts`). Renderer errors reach it over `app:report-error`.
  - **Production egress is Backend-Core only (RT-1253, RT-1251 R3).** A shipped build on update
    channel `canary` or `stable`, or on an unknown channel, ignores the env `SENTRY_DSN` and sends
    errors only to the Backend-Core tunnel (`/api/pos/v1/telemetry/envelope`, device bearer), which
    forwards to Sentry project `kemetra/pos`; the terminal holds no DSN. Lab (channel `lab`) and dev
    builds keep the direct env-DSN path (RT-1243); lab without an env DSN uses the tunnel. The
    classification lives in `src/main/observability/telemetry-mode.ts`; wiring in
    `src/main/bootstrap/telemetry.ts`.

## Main-process wiring (RT-893)

- No new wiring in `src/main/index.ts`; new areas go in `src/main/bootstrap/<area>.ts` exporting
  `register<Area>(deps)`. The CI ratchet `scripts/check-index-size.mjs` fails if the file grows;
  lower `scripts/index-size.baseline` in the same PR when it shrinks.

## Backend-Core HTTP clients (RT-880)

- **Every new main-process Backend-Core client uses the shared transport**
  [`src/main/http/transport.ts`](src/main/http/transport.ts) (`createBackendTransport`): bearer
  auth, per-call timeout, byte-capped JSON body, transport faults → `null`, and `statusOutcome`
  for the client's own status table. Do not hand-roll `fetch` calls, `Authorization` headers,
  timeouts or body reading in a new client.
- Build it on the shared `backendFetch` from `index.ts`. That fetch adds `X-Request-Id`
  (`withRequestId`), the build identity and the terminal-status observer; the transport never
  mints a request id itself.
- Older clients move onto the transport only when they are touched for another reason, one per
  PR, with characterization tests first and unchanged public signatures. Migrated so far:
  `sale-history/sale-history-client.ts`.

## Useful commands

```bash
npm install                  # install deps
npm run dev                  # open empty Electron window
npm run codegen:api          # regenerate src/shared/api-types.ts
npm run codegen:verify       # CI helper: regen → diff
npm run typecheck            # both tsconfigs
npm run lint                 # eslint + prettier --check
npm test -- --coverage       # full vitest run
npm run package:dir          # electron-builder --win --dir (unsigned)
```

## CodeScene

After changing code, run `code_health_review` on the changed files. If Code Health drops, fix the
issues, run the review again, and use `code_health_score` to confirm the result. Before each
commit, stage the files and run `pre_commit_code_health_safeguard`; commit only when it passes. It
checks staged and uncommitted changes only; once changes are committed they are out of its scope.
Before opening a PR, `analyze_change_set` reviews the whole branch. The CodeScene Code Health Review
GitHub check also gates every PR.
