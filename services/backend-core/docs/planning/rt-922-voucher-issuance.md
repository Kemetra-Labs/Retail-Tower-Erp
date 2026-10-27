# RT-922 — Voucher issuance: tenant-scoped issuance contract and admin surface (plan)

> **Status:** planning record (Work Mode: **Planning**, release horizon **Post-Pilot**). **Jira holds the live
> status.** This file records the 2026-10-27 planning pass and is not a status tracker.
>
> No runtime, migration, OpenAPI, package, CI, Connector, Admin-Console or POS change.
>
> **Sources:** Jira RT-922; RT-810 (runtime plan, comments 14245, 14246, 14247, 14251); RT-218; RT-79 / RT-103
> (voucher tender off for the pilot). Monorepo `Kemetra-Labs/Retail-Tower-Erp` `origin/main` **`a7ca517`**
> (read-only inspection of the files cited below). No runtime was exercised.

---

## 1. The need

RT-810 planned the runtime for the three POS redeem operations of Contract V-A
(`packages/contracts/openapi/pos-payments/vouchers.yaml`). Nothing can be redeemed until a voucher exists, and
today no voucher can be created: there is no issuance contract, route, table or console page. This plan
defines the smallest issuance surface. It is slice 1 of the RT-810 plan and blocks every later slice.

## 2. Owner decisions already recorded (not re-opened here)

| # | Decision | Where |
|---|---|---|
| D1 | Release horizon: Post-Pilot. | RT-810 c14246 |
| D2 | Each tenant (chain owner) issues its own vouchers. A voucher is valid only in that tenant's stores, never across tenants. | RT-810 c14247 |
| D3 | The issuer chooses the accepting stores: all stores, or any subset. | RT-810 c14247 |
| D4 | An "all stores" voucher automatically includes stores added later; an explicit subset never grows by itself. | RT-810 c14251 |

## 3. Verified current state

| Fact | Evidence |
|---|---|
| No issuance contract or route. V-A says tenant-admin voucher CRUD "has no contract or route yet". | `packages/contracts/openapi/pos-payments/vouchers.yaml` (info.description) |
| POS must not issue, cancel or edit vouchers. | `apps/pos/specs/006-payments-tender/coordination.md` (voucher authority section) |
| No voucher table; sale tenders allow only `cash` and `card_external`. | `packages/db/drizzle/0033_sale_tenders.sql:88-89` |
| Stores are tenant-owned, with `is_active` and soft delete `deleted_at`; `(tenant_id, id)` is unique and is a composite-FK target. | `packages/db/drizzle/0000_initial.sql:126-144` |
| A tenant has one default currency, `tenants.default_currency_code` (default `USD`). | `packages/db/drizzle/0007_catalog.sql:38-42` |
| The closest console precedent is payer accounts: cookie auth (`DashboardAuthGuard` + `TenantContextGuard`), `RolesGuard` with `owner` / `tenant_admin` (403 on insufficient role), `@Idempotent("required")` on create, tenant and store scope from `request.context`, never the body. | `apps/api/src/settlement/payer-accounts.controller.ts:1-80` |
| The matching Admin-Console precedent exists. | `apps/admin-console/src/payers/` (`PayerCreate.tsx`, `PayerList.tsx`, `payerIdempotency.ts`, `payerAccess.ts`) |
| Tenant roles in use: `owner`, `tenant_admin`, `store_manager`. | `apps/api/src/auth/roles*.ts`, `apps/api/src/memberships/` |
| Secrets are generated with `generateRawToken()` (random bytes) and stored only as `hashToken()` (SHA-256). Pairing codes follow this: the raw code is returned once and never persisted. | `packages/auth/src/tokens.ts:14-28`; `packages/db/drizzle/0024_pairing_codes.sql:23` |
| A response that carries secret material can opt out of idempotent replay: `@Idempotent(..., { replay: "forbid", replayMarkerFields: [...] })`. | `apps/api/src/idempotency/idempotent.decorator.ts:33-45`; used by `apps/api/src/connector/connector-registration.controller.ts:171` |
| Read audit codes must be registered; a drift spec enforces it. | `apps/api/src/audit/audit-action-kinds.ts` header |
| A console rate-limit guard exists (RT-574). | `apps/api/src/console-rate-limit/` |

## 4. Needs verification

1. **Residual balance (owner decision).** V-A v1 is "single full redemption", yet `posValidateVoucher` accepts
   `applied_amount_minor` smaller than the balance (`applied <= balance`). When a 100 voucher pays a 70 sale,
   the contract does not say whether the remaining 30 is forfeited or kept. This plan's issuance model works
   either way, but RT-810 slice 4 cannot be built until it is decided. **Recommendation:** forfeit in v1 (the
   voucher becomes `redeemed`), with the console showing the redeemed amount; keep partial balances for a later
   contract version.
2. **Currency.** V-A's validate request carries no currency. A voucher in the tenant default currency is safe
   only while every store of the tenant sells in that currency. Whether a tenant can have stores in another
   currency is not verified.
3. **`store_manager` scope.** The payer precedent has store-scope errors (`PayerStoreNotInScopeError`); the
   exact store-scope model for a `store_manager` read was not traced.
4. **Accounting.** How an issued and a redeemed voucher appear in ERPNext (liability, discount, expense,
   Mode of Payment) is a Connector / Fiscal (RT-4) question. It is named here, not decided.

## 5. Proposed design

### 5.1 Authority and surfaces

- **Backend-Core** is the voucher authority: code hash, value, status, expiry, store eligibility.
- **Admin-Console** is the issuing UI, calling only Backend-Core (architecture invariant: the console never
  calls ERPNext).
- **POS** only redeems through V-A (RT-810).
- **ERPNext** receives an accounting representation later (§4 item 4); it is never the authority.

### 5.2 Operations (new console contract, `[GATED]` OpenAPI)

Proposed file `packages/contracts/openapi/vouchers-admin.openapi.yaml`, `x-runtime-status: contract-only`
until the runtime lands. Every route uses the human cookie stack of the payer precedent: `DashboardAuthGuard`
(which carries the RT-430 Origin check on cookie-authenticated POSTs, the CSRF defence for
`consoleIssueVouchers` and `consoleCancelVoucher`), then `TenantContextGuard`, then `RolesGuard`. No bearer
or alternative guard. Tenant from `request.context`.

| Operation | Method and path | Roles | Notes |
|---|---|---|---|
| `consoleIssueVouchers` | `POST /api/v1/vouchers` | `owner`, `tenant_admin` | Creates 1..N vouchers with the same value, expiry and eligibility. `@Idempotent("required", { replay: "forbid", replayMarkerFields: ["batch_id"] })`: the codes are returned **once**; a same-key retry is `409 idempotency_key_conflict` and never re-issues or re-shows codes. |
| `consoleListVouchers` | `GET /api/v1/vouchers` | `owner`, `tenant_admin` (and `store_manager`, see §4 item 3) | Cursor pagination; filter by status, batch, eligible store, expiry window. Never returns a code. |
| `consoleGetVoucher` | `GET /api/v1/vouchers/{voucher_id}` | same as list | Value, status, eligibility, redemption summary. Never returns a code. |
| `consoleCancelVoucher` | `POST /api/v1/vouchers/{voucher_id}/cancel` | `owner`, `tenant_admin` | `@Idempotent("required")`. Cancelling a cancelled voucher returns 200 `already_cancelled: true`. A redeemed voucher cannot be cancelled (`voucher_already_redeemed`). Cancel races with redeem are settled as in §5.4 "Status transitions". |

Issue request (sketch): `count` (1..500), `amount_minor` (> 0), `expires_at` (optional, future),
`applies_to_all_stores` (bool), `eligible_store_ids` (required and non-empty when not all stores),
`note` (optional, internal, no PII). Currency is the tenant default (§4 item 2).

Issue response (sketch): `batch_id`, `vouchers[] { voucher_id, code, amount_minor, currency_code, expires_at }`.
The Admin-Console shows the codes once and offers a CSV download from that response only.

Closed error set (sketch): `validation_failure`, `store_not_found` (a store outside the tenant or soft-deleted;
non-disclosing), `store_inactive`, `voucher_not_found`, `voucher_already_redeemed`, `forbidden`,
`idempotency_key_required`, `idempotency_key_malformed`, `idempotency_key_conflict`.

### 5.3 Code generation and secrecy

- The server generates the code; the issuer never chooses it.
- Format: 16 characters of Crockford base32 (no `I L O U`), shown as `XXXX-XXXX-XXXX-XXXX`, about 80 bits of
  entropy. It is typable at a till and scannable as a barcode. Input is normalised (upper case, hyphens and
  spaces removed) before hashing, on both issue and validate.
- Stored as `hashToken(normalised_code)` only. Unique `(tenant_id, code_hash)`.
- Never logged, never in audit payloads, never in a read response. A lost code cannot be re-shown: cancel and
  re-issue.

### 5.4 Data model (`[GATED]` migration, plan only)

- `vouchers`: `id`, `tenant_id`, `batch_id`, `code_hash`, `amount_minor`, `currency_code`, `status`
  (`active | redeemed | cancelled`), `expires_at` (expiry is derived at read time, not a stored status),
  `applies_to_all_stores`, `issued_by_user_id`, `cancelled_by_user_id`, `cancelled_at`, timestamps,
  `note`.
- **Expiry on the read side.** Expiry is never written back, so a voucher can be stored `active` with
  `expires_at` in the past. Every read derives one effective status: `expired` when the stored status is
  `active` and `expires_at <= now()`, otherwise the stored status. List and detail return that effective
  status plus `expires_at`. The list filter uses the same rule: `status=active` excludes expired vouchers,
  `status=expired` selects them. V-A validate already refuses them with `voucher_expired`.
- **Cancelling an expired voucher** (owner decision, §8 item 5). Recommendation: allowed, so an admin can
  close out an expired voucher cleanly; the conditional cancel below stays `WHERE status = 'active'` and does
  not check expiry. If the owner says no, cancel adds `AND (expires_at IS NULL OR expires_at > clock_timestamp())` and a
  zero-row result on an expired voucher returns `voucher_expired`.
- `voucher_eligible_stores`: `(tenant_id, voucher_id, store_id)`, primary key over all three, with two
  composite FKs so neither side can cross tenants: `(tenant_id, store_id) REFERENCES stores (tenant_id, id)`
  and `(tenant_id, voucher_id) REFERENCES vouchers (tenant_id, id)`. `vouchers` therefore carries
  `UNIQUE (tenant_id, id)` as the FK target (the `stores_tenant_id_uk` pattern). RLS alone does not stop a
  row pointing at another tenant's voucher; these FKs do.
  Rows exist only when `applies_to_all_stores = false`.
- Eligibility rule (D3, D4): `applies_to_all_stores = true` accepts any active store of the tenant, including
  stores created later; otherwise only listed stores. A listed store that is later deactivated simply cannot
  redeem (the POS of an inactive store cannot operate); its row is kept for history.
- RLS `ENABLE` + `FORCE` with tenant-scoped policies, following `0033_sale_tenders.sql:105-115`, plus an
  UPDATE policy on `vouchers`. Down migration included.
- The RT-810 redeem tables (`voucher_redemption_intents`, `voucher_redemptions`) are **not** part of this
  migration; they stay in RT-810 slice 3.

**Status transitions.** Cancel (this plan) and redeem (RT-810) are separate write paths on the same row, so
each transition is one conditional write inside its transaction, never a read-then-write:

- Cancel: `UPDATE vouchers SET status = 'cancelled', cancelled_at = now(), ... WHERE tenant_id = $1 AND
  id = $2 AND status = 'active'`. One row updated means this request won. Zero rows means the voucher was not
  active: re-read it and answer `already_cancelled: true` if it is cancelled, `voucher_already_redeemed` if it
  is redeemed, `voucher_not_found` if absent.
- Redeem (RT-810 slice 4 must follow the same rule): the balance decrement and the `redeemed` transition are
  conditioned on `status = 'active'` under the same row lock (`SELECT ... FOR UPDATE`), so a voucher cancelled
  first fails redeem with `voucher_cancelled`. The expiry predicate
  `expires_at IS NULL OR expires_at > clock_timestamp()` sits in the WHERE clause of that same final
  conditional write (the `UPDATE` that decrements the balance and sets `redeemed`), so it is evaluated at the
  write itself, not only by an earlier check: a redemption-intent token issued by validate just before expiry
  must not redeem after it, and no gap between a check and the write can let an expired voucher through. An
  application-side pre-check may stay as a fast path but is never the guard. Use `clock_timestamp()` (wall
  clock at evaluation), not `now()`: `now()` is fixed at transaction start, so a redeem that waited on the
  row lock past `expires_at` would still pass. Zero rows updated: re-read and answer `voucher_cancelled` if
  cancelled, else `voucher_expired` if expired (cancelled first, then expired).
- Both start from `active`: whichever transaction commits its conditional write first wins; the other sees
  zero rows (or blocks on the row lock, then sees the new status) and gets the refusal above. No voucher ever
  ends both cancelled and redeemed.

### 5.5 Audit and rate limiting

- Change events written in the service transaction (the console-catalog write pattern): `voucher.issued`
  (with `batch_id`, `count`, `amount_minor`, eligibility; never codes), `voucher.cancelled`.
- Read codes `vouchers.listed`, `vouchers.read` added to `LIVE_READ_CODES` (drift spec).
- The RT-574 console rate-limit guard covers the routes; issuance is the `write` class.

## 6. Proposed implementation issues (each needs owner authorization)

| # | Issue | Work Mode | Gate |
|---|---|---|---|
| I-1 | Issuance OpenAPI contract `vouchers-admin.openapi.yaml` (contract-only) plus contract spec. | Implementation | `[GATED]` OpenAPI |
| I-2 | Migration: `vouchers`, `voucher_eligible_stores`, RLS, down migration. | Implementation | `[GATED]` migration |
| I-3 | Backend-Core runtime for the four operations on the `DashboardAuthGuard` + `TenantContextGuard` + `RolesGuard` stack (RT-430 Origin check on both POSTs), conditional status transitions (§5.4), audit, rate-limit class. | Implementation | after I-1, I-2 |
| I-4 | Admin-Console vouchers page (issue, show once, CSV, list, detail, cancel), following `src/payers/`. | Implementation | after I-3 |

Order: I-1, then I-2, then I-3, then I-4. RT-810 slices 2-6 (auth alignment, redeem tables, redeem runtime,
tender integration, POS enablement) follow and stay owned by RT-810's plan.

## 7. Test cases the implementation issues must carry

- Cross-tenant: issuing with another tenant's store id is refused with the non-disclosing `store_not_found`.
- A soft-deleted or inactive store in `eligible_store_ids` is refused.
- `applies_to_all_stores = false` with an empty store list is `validation_failure`.
- `store_manager` cannot issue or cancel (403).
- Codes are unique per tenant across a 500-voucher batch; hashes collide with no existing code.
- Same Idempotency-Key retry of issue: 409, and no second batch is created.
- Cancel twice: second call `already_cancelled: true`; cancel after redeem refused.
- Expired but stored `active`: detail and list show effective status `expired`; `status=active` excludes
  it and `status=expired` includes it; cancel follows the §8 item 5 decision.
- Validate succeeds before `expires_at`, redeem is called after it: redeem fails with `voucher_expired` and
  the balance is unchanged (RT-810 slice 4).
- Redeem starts before `expires_at` but waits on the voucher row lock (held by another transaction) until
  after it: once the lock is granted, redeem fails with `voucher_expired` (RT-810 slice 4).
- Concurrent cancel and redeem started from one `active` voucher: exactly one succeeds, the other gets the
  documented refusal, and the final status is either `cancelled` or `redeemed`, never both (I-3 for cancel,
  RT-810 slice 4 for redeem).
- Migration: an eligible-store row whose `voucher_id` belongs to another tenant, or does not exist, is
  rejected by the composite FK; the same for `store_id`.
- A cross-site POST (wrong or missing `Origin`) to issue or cancel is refused by the RT-430 check.
- A cancelled voucher fails V-A validate (`voucher_cancelled`); an expired one fails (`voucher_expired`).
- D4: an "all stores" voucher validates in a store created after issuance; a subset voucher does not.
- No code appears in logs, audit rows, list or detail responses, or idempotency storage.

## 8. Owner decisions still open

1. Residual balance on under-application: forfeit (recommended for v1) or keep (§4 item 1).
2. Whether `store_manager` may read vouchers for their stores (§4 item 3).
3. Batch size limit: 500 proposed.
4. Accounting representation in ERPNext, for the Connector / Fiscal owner (§4 item 4).
5. Whether an expired voucher can be cancelled: allowed (recommended) or refused with `voucher_expired`
   (§5.4).

## 9. One next safe action

Owner answers §8 items 1-3 and 5, then authorizes I-1 (the contract-only OpenAPI PR).
