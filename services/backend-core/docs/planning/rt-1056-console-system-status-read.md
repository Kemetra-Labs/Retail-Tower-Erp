# RT-1056 — Console system-status read: decision record and contract draft

> **Status:** decision record + `[GATED]` contract draft (Work Mode: **Planning**, contract-first).
> **Jira holds the live status.** This file records the 2026-11-02 planning pass and is not a status tracker.
>
> **Authority.** The owner delegated decisions on 2026-11-02 to the captain session, with the instruction to pick
> the recommended option wherever an owner decision is needed. Each decision below is therefore
> **selected under owner delegation of 2026-11-02 (captain session), recommended option; the owner may revisit it.**
>
> **Deliverables in this change:** this record; the contract
> `packages/contracts/openapi/console-system-status.openapi.yaml` (`1.0.0-draft`, the operation marked
> `x-runtime-status: contract-only`); its console rate-limit class file; a changelog fragment.
> No runtime, migration, package, CI or Admin-Console change.
>
> **Sources (read-only):** Jira RT-1056 and RT-993; Admin-Console `DESIGN.md` §12.2, §12.4, §12.8.6;
> Backend-Core contracts `health.openapi.yaml`, `pos-device-health.openapi.yaml`,
> `erpnext-connector/connector-health.yaml`, `erpnext-sync-ops/console-sync-ops.yaml`,
> `sale-sync-ops/sale-sync-ops.yaml`, `console-sales-by-store.openapi.yaml` (conventions);
> `packages/db/src/schema/outbox_events.ts`, `sales/sale-sync-deadletters.ts`;
> `apps/api/src/connector-health/connector-health.liveness.ts`; `apps/worker/src/outbox/drainer.processor.ts`.
> Baseline `origin/main` `a43ad962c`. No runtime was exercised. Query cost and row volumes are **NOT VERIFIED**.

---

## 1. The need, and why the existing reads do not answer it

The sidebar footer of the Admin-Console tenant shell has a system-status block. Since RT-993 it renders a
«قريبًا» frame (owner decision, RT-993 comment 15088; DESIGN.md §12.8.6 item 6), because no console read
summarises system state for a tenant. If the Console composed one from other reads, it would invent a
"healthy" claim, which UX-07 and UX-13 forbid.

| Existing piece | What it answers | Why it is not this read |
| --- | --- | --- |
| `health.openapi.yaml` (`getHealthLiveness`, `getHealthReadiness`) | Process liveness and platform dependency readiness (database pools, Redis) | Unauthenticated, platform-wide infrastructure probe for deployment checks. It is not tenant-scoped, and exposing its detail to a tenant would disclose platform state. |
| `pos-device-health.openapi.yaml` | Per-terminal heartbeat, version compliance | Device fleet, not the server path. Kept out of v1 (§3, D-1). |
| `erpnext-connector/connector-health.yaml` (`listConnectorHealth`) | Per-registration `liveness` (`healthy` / `stale` / `never_seen` / `disabled`), 5-minute threshold | Per-instance list. No tenant verdict, and the Console must not derive one itself. |
| `erpnext-sync-ops/console-sync-ops.yaml` (`consoleGetSyncOpsSummary`) | Posting dead letters, reconciliation, posting freshness facts | ERP posting, not the sale sync queue. Its posting `status` counts failures only (RT-565 §1). |
| `sale-sync-ops/sale-sync-ops.yaml` (`consoleListNeedsRepair`) | The NEEDS_REPAIR queue | Failures only; says nothing about a queue that has stopped moving. |

The worker's own liveness signal (`worker.heartbeat` span, RT-684) goes to Datadog only. Backend-Core cannot read
it back, so the read decides `saleSync` from the tenant's queue facts in the database (D-1).

## 2. Decisions

### D-1 — Components and states

**Options.**

- **A.** Three fixed components (`server`, `saleSync`, `erpConnector`) with the shared state vocabulary `ok` /
  `degraded` / `down` / `unknown`, a closed reason code per state, and a server-computed worst-of `overall`.
- **B.** A, plus `posDevices` (from `device_health`) and `erpPosting` (from RT-565 posting freshness).
- **C.** A free-form list of components with a status string each.

**Recommendation and selection: A.** It is what the block (three pipeline nodes, POS → server → ERPNext, minus the
POS node, which has no connectivity record per DESIGN.md §12.4) needs. B adds two judgements that have their own
screens and open rules (posting freshness deliberately has no current / behind verdict, RT-565 D-rules), and
C cannot be checked by a client or a test. A component can be added later as an additive change.

**Selected: A** — under owner delegation of 2026-11-02 (captain session), recommended option; owner may revisit.

Rules (normative, also in the contract):

- **`unknown` is never `ok`.** `unknown` means no evidence the server can stand behind. No client maps it to `ok`.
- **`server`** — in a 200 always `ok` / `answered`. A server that cannot answer returns no 200; the Console then
  shows every component `unknown`, because it cannot tell a down server from a lost network. No platform dependency
  is reported (D-3).
- **`saleSync`** — the tenant's undelivered `sale.captured` outbox events (`pending`, `claimed`, `failed`) and open
  NEEDS_REPAIR sales (spec 032). Age is `now() - created_at`, server clock.

  | Condition (first match wins) | State | Reason |
  | --- | --- | --- |
  | Facts not read within the check bound | `unknown` | `check_timed_out` |
  | An undelivered event older than 30 min | `down` | `queue_stalled` |
  | An undelivered event older than 5 min | `degraded` | `queue_behind` |
  | At least one open NEEDS_REPAIR sale | `degraded` | `needs_repair` |
  | Otherwise (including an empty queue) | `ok` | `keeping_up` |

  An empty queue is `ok`: no sale is waiting, so nothing is behind. That is a true statement about the queue, not
  a claim that the worker is alive, which this read cannot see (§1).
- **`erpConnector`** — the spec 020 liveness of the tenant's registrations (derived at read, 5-minute threshold).
  Backend-Core makes no outbound ERPNext call; the Console never calls ERPNext.

  | Condition over registrations (first match wins) | State | Reason |
  | --- | --- | --- |
  | Facts not read within the check bound | `unknown` | `check_timed_out` |
  | No registration | `unknown` | `not_configured` |
  | Every registration disabled | `unknown` | `all_disabled` |
  | Every enabled one `never_seen` | `unknown` | `never_seen` |
  | No enabled one `healthy`, at least one `stale` | `down` | `heartbeat_stale` |
  | Some but not all enabled ones `healthy` | `degraded` | `some_instances_stale` |
  | All `healthy`, at least one self-reports `erpnextReachable: false` | `degraded` | `erp_unreachable_reported` |
  | All enabled ones `healthy` | `ok` | `heartbeat_fresh` |

  `erp_unreachable_reported` is the connector's self-report, never a Backend-Core probe.
- **`overall`** — the worst component state in the order `down` > `degraded` > `unknown` > `ok`; `ok` only when every
  component is `ok`.

### D-2 — Freshness

**Options.**

- **A.** Computed on every read, no server cache: `asOf` (read time) on the body, `observedAt` (evidence time) per
  component, `Cache-Control: no-store`. The Console shows `asOf` and marks the snapshot stale 10 minutes after it
  received it, by its own clock.
- **B.** A server-side cached snapshot refreshed by a worker sweep, with its age on the body.
- **C.** No time on the body; the Console uses its own fetch time.

**Recommendation and selection: A.** B needs a new worker job and a table or cache (out of scope, and spec 020
chose derive-at-read for the same reason). C repeats the RT-565 gap (no `asOf`, spec 016 A-5).

**Selected: A** — under owner delegation of 2026-11-02 (captain session), recommended option; owner may revisit.

The Console never compares `asOf` with its local clock (skew). A stale snapshot keeps its states, shown muted with
the time and a Refresh action; it is never upgraded and never re-labelled `ok`. `observedAt` is the newest
`lastSeenAt` of an enabled registration for `erpConnector` (null when there is none) and the read time for
`saleSync` and `server`.

### D-3 — Scope, roles, refusal and disclosure

**Options.**

- **A.** Tenant-wide only (no `store_id`); roles `owner` and `tenant_admin`; any other role the non-disclosing 404;
  no platform-wide or other-tenant state on the body.
- **B.** A, plus `store_manager` with the components narrowed to their stores.
- **C.** A, plus a platform incident banner (shared dependency failures) shown to every tenant.

**Recommendation and selection: A.** The components are tenant-level (one connector registration set, one queue per
tenant). The roles match the reads it summarises: `listConnectorHealth` and the sale-sync-ops surface are
`owner` / `tenant_admin` (and the Console's `canReadErpStatus` / `canUseSaleSyncOps` mirror that). B would show a
store manager a tenant-wide verdict over data they cannot open. C discloses platform-wide state to tenants; there is
no clear reason that outweighs the default of non-disclosure, and no decided alert source exists (DESIGN.md §12.4,
the alert banner is not shipped). It can be a separate decision.

**Selected: A** — under owner delegation of 2026-11-02 (captain session), recommended option; owner may revisit.

The Console renders the block only for roles that can read it, so other roles send no request. The guards are the
console chain `SessionOnlyAdminGuard` → `TenantContextGuard` → `RolesGuard`, `cookieAuth` only. The body never holds a
host name, error text, version or another tenant's data.

A platform-admin session passes the role gate, as on every `@Roles` route (the repo-wide `RolesGuard` rule, the same as
`listConnectorHealth`), and still reads only its active tenant: the checks run with `isPlatformAdmin: false`
(RT-1062 review, captain decision under owner delegation of 2026-11-02).

### D-4 — How often the Console may read it

**Options.**

- **A.** Once when the tenant shell loads (and when its tenant changes), and again only on the user's Refresh. No
  polling, no refetch on window focus or interval. Rate-limit class `cheapRead`; each check bounded server-side, a
  timeout is that component's `unknown` / `check_timed_out`.
- **B.** A stated polling budget (for example every 5 minutes while visible).
- **C.** Server push (SSE / websocket).

**Recommendation and selection: A.** The Overview uses no polling (NG-7); B would be the first polling read in the
shell and needs its own decision, C a new transport. A keeps the cost to one bounded read per shell load.

**Selected: A** — under owner delegation of 2026-11-02 (captain session), recommended option; owner may revisit.

The read is not audited: it carries operational status only, no business figure and no personal data, like
`listConnectorHealth` and `consoleGetSyncOpsSummary`, and auditing a per-shell-load read would flood the log.

### D-5 — Destinations

**Options.**

- **A.** One closed `link` value per component, the same for every state: `saleSync` → `sale_sync_ops`
  (the sales-needing-repair screen, `/sales-needing-repair`), `erpConnector` → `erp_connection`
  (`/erp-connection`), `server` → `none` (no link).
- **B.** A per-state link (for example `ok` → none, others → the screen).
- **C.** A URL in the body.

**Recommendation and selection: A.** Both screens exist today and are readable by exactly the roles of D-3, so no
destination is dead (UX-09). `server` has no screen, so it has no link rather than a dead one. B hides the path to
the screen when things look fine, which is when an operator checks it. C puts routing into Backend-Core.

**Selected: A** — under owner delegation of 2026-11-02 (captain session), recommended option; owner may revisit.

## 3. Out of scope

The runtime; alerting and notifications (RT-1033 / RT-1034 family); the Admin-Console block (RT-993 ships the
«قريبًا» frame); the support card; POS device fleet status and ERP posting freshness in the block (D-1 B);
platform incidents (D-3 C).

## 4. Contract

`packages/contracts/openapi/console-system-status.openapi.yaml`, `1.0.0-draft`:

- `GET /api/v1/system-status`, `operationId: consoleGetSystemStatus`, `cookieAuth`, no parameters;
  `x-runtime-status: contract-only` with its `x-runtime-note`.
- 200 `ConsoleSystemStatus` (`asOf`, `overall`, `components.server | saleSync | erpConnector`), every object
  `additionalProperties: false`, `Cache-Control: no-store`.
- 400 `validation_error` (any query key), 401, 404 non-disclosing, 429 `rate_limited` (RT-574 shape), 500.
- Console rate-limit class `cheapRead` (`apps/api/test/console-rate-limit/classes/console-system-status.rate-limit.yaml`).

## 5. Runtime follow-up (identified, not created)

**Proposed Implementation issue:** "Backend-Core — `consoleGetSystemStatus` runtime
(`GET /api/v1/system-status`)", parent W5 (RT-5), relates to RT-1056 and RT-993. Scope: controller, guards, service
and bounded queries under tenant RLS per D-1 to D-4; reuse `connector-health.liveness.ts` for the verdict; unit and
HTTP integration tests (each reason, `unknown` never `ok`, the 404 for other roles, cross-tenant isolation, a check
timeout); remove only the operation's contract-only marker. **Risk to check there:** `outbox_events` has no
tenant-led index for undelivered events (`outbox_events_drainer_claim_idx` is `(delivery_state, next_attempt_at)`);
if the query is not bounded without one, adding an index is a migration and needs its own `[GATED]` approval.

A second, later Admin-Console issue replaces the «قريبًا» frame with the block once the runtime is on `main`.
Neither issue is created before the owner (or the delegated captain) approves.
