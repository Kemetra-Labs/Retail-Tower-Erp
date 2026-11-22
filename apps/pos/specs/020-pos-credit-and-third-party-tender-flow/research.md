# Research: POS Credit & Third-Party Payer Flow

**Feature:** 020-pos-credit-and-third-party-tender-flow
**Spec:** [./spec.md](./spec.md) · **Plan:** [./plan.md](./plan.md)
**Re-verified:** 2026-11-22 against `origin/main` `510706c4d` (read-only inspection)

> Records the verified ground truth the spec binds to. Jira and Confluence are context; the code and
> contracts named here are what was read on `main`.

## R1. The allocation lives in the sale (decision)

Owner decision R-1 (RT-413 comment 11669, 2026-10-12): the payer responsibility is captured on the sale at
checkout, as an optional `responsibilities` field on `captureSale`, hashed into the sale payload. The old
post-sale intent route was retired from the contract (RT-417, `settlement.yaml` 2.0.0) and its runtime and
tables were removed (RT-422, #772, `403c14f0c`). Under `apps/pos/src` no code used the retired route; the
remaining references were documentation.

## R2. Offline and path (owner decision, Option A, 2026-10-16)

Credit is accepted only on the operator-envelope path, only from `owner`, `tenant_admin` or `store_manager`,
and is captured synchronously, online, before finalize. The device path answers 422
`sale_responsibility_offline_refused`; a non-eligible envelope operator gets 403
`sale_responsibility_role_refused`. Offline credit stays disabled until a cached credit decision with
freshness and amount limits exists (RT-413 R-1; baseline 1361 to 1447). Source: pinned
`apps/pos/contracts/backend-core/openapi/pos-sales/sales.yaml`, notes on `responsibilities` and
`CaptureForbidden` / `CaptureUnprocessable`.

## R3. What the contract says about the body (verified)

- `responsibilities`: `minItems 1`, `maxItems 1`; item `{ payerRef (uuid), amount (positive decimal string),
  sequence (integer >= 1) }`; unique `payerRef` and `sequence` per sale.
- Coverage: `sum(tenders) + sum(responsibilities) = posTotal`, exact decimal; an absent `tenders` counts as
  zero, so full credit is valid and not tender-unknown (RT-10 D8 applies only when both are absent).
- Check order: authentication, replay answer, role (403), then 422s: offline refusal, coverage, voucher,
  line price, payers.
- A transient failure (timeout, 429, 5xx) leaves the sale unfinalized; the till may retry the same capture
  synchronously with the same `Idempotency-Key`, never through the background drain; a refusal is never
  silently retried; the sale is never re-sent without the responsibility or with it turned into a tender.
- Rollout: the server accepts the field from RT-418 (Done). POS's pin is `1.28.0-draft` and already carries it.
- A credit sale is reversed only through `recordCreditSaleReversal`; the ordinary void, return and refund
  routes answer 403 `credit_sale_reversal_restricted`.

## R4. The payer read exists server-side; POS has no pin (verified, corrects the brief)

`posListChargeablePayers` (`GET /api/pos/v1/payer-accounts`) is in Backend-Core
`packages/contracts/openapi/pos-payers.openapi.yaml` (`1.0.0-draft`), runtime RT-802 (changelog entry
`RT-802-added.md`; controller `apps/api/src/catalog/sales/payers/pos-payers.controller.ts`). Envelope only,
role re-checked live, keyset pages, minimum disclosure, `chargeable` shared with capture's payer predicate,
`Cache-Control: no-store`, no offline freshness rule, no search parameter. RT-570 and RT-802 are Done.

`apps/pos/contracts/backend-core/openapi/` has no `pos-payers` file, so the generated client has no such
operation. The pin is the missing piece (spec D-1).

## R5. POS code facts (verified)

- No file under `apps/pos/src` references the retired route. `grep` for "responsibilit" in `src` finds only
  unrelated hits (read-down, payments, receipts print pipeline wording, returns messages, generated
  `api-types.ts`). There is no responsibility capture in product code.
- Sale capture-up is the background engine in `src/main/sales-sync/` (`sale-sync-engine.ts`,
  `create-sale-sync-client.ts`) wired by `src/main/bootstrap/sale-sync.ts`. The envelope is read in-process
  per POST; the device path is composed separately (`compose-device-path.ts`, RT-224). The client already
  uses a deterministic `Idempotency-Key` (the payload `externalId`) and classifies 425 and 429 as transient
  and other 4xx as permanent (dead-letter). **A credit sale needs a different mode: none of that
  dead-lettering or queuing may apply to it** (R-SYNC).
- Finalize is not driven by the checkout screen: a background scan (`sales/finalize-listener.ts`, `finalize-dispatch.ts`) finds settled payments with no sale row, and `finalize-transaction.ts` then inserts the sale and a `pending` `sale_sync_outbox` row in one transaction. A credit checkout must not take that route as is (spec R-FINALIZE, Q-9). Found by independent review of this change.
- `src/main/bootstrap/sale-void.ts` is the existing precedent for a synchronous envelope-authenticated call
  with the shared backend transport and the approval service.
- Specs index lists 020 as Deferred. `apps/pos/README.md` line 132 lists credit and third-party tender as not
  implemented.

## R6. Pilot and UX constraints that apply

Pilot is cash only, no split tender (RT-536 D4); RT-420 is fix version Post-Pilot. POS wave 1 is keyless
(D-K1). No insurance or prescription claims on the till (I-17). Verbs must not exceed evidence (UX-12.13).
Machine data (amounts, ids) is LTR-isolated in Arabic text. Offline copy and state come from real signals
only. These are why the spec labels all copy as proposed and adds no shortcut.

## Alternatives considered and rejected

- **Keep a separate post-sale intent route.** Retired by owner decision R-1 and removed server-side.
- **Queue a credit sale and send it later.** Forbidden by Option A and refused server-side on the device path.
- **Cache the payer list for offline use.** The payer contract forbids it in v1; an offline mode needs its own
  decision and a new contract version.
- **Multi-payer split (patient plus third party).** The contract caps at one payer; a split needs a later
  version once RT-419 fixes the ERPNext shape.
- **Show a credit balance or "settled" state.** ERPNext owns the balance; Backend-Core holds none.
- **Authoring the payer contract pin in this issue.** It is a gated contract pin with its own exemption and
  preflight; docs-only scope forbids it.

## Traceability

| Spec element | Where it is pinned |
|:--|:--|
| R-SALE, FR-4, FR-5 | consumption note sections 3 and 4; data-model E1, E2 |
| R-OFFLINE, R-PATH, R-ROLE | spec rules table; consumption note sections 2, 3, 5 |
| R-COVER | data-model validation; spec scenarios 1 to 3 |
| R-FRESH, R-NOSUBMIT | consumption note section 2; spec scenarios 4, 9, 10 |
| FR-6, FR-7, FR-8 | consumption note section 4; data-model E4 |
| FR-9, Q-5, Q-6 | spec scenario 13; data-model E5 |
| D-1 to D-7, Q-1 to Q-9 | spec Dependencies and Owner questions |
