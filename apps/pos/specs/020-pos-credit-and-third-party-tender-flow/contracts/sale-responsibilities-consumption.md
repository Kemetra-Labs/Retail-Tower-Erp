# Contract Consumption (prose): POS and payer responsibilities

**Feature:** 020-pos-credit-and-third-party-tender-flow
**Spec:** [../spec.md](../spec.md) · **Plan:** [../plan.md](../plan.md)

> **Prose note, not an OpenAPI document.** The binding sources are the Backend-Core contracts. This file
> pins how the till consumes them. POS authors no contract and edits no file under
> `apps/pos/contracts/**` (a pinned copy). Where this note and a contract differ, the contract wins and
> this note is wrong.

## 1. Consumed operations

| Operation | Method and path | Credential | Source | POS pin |
|:--|:--|:--|:--|:--|
| `captureSale` (with `responsibilities`) | `POST /api/pos/v1/sales` | `operatorAuthorization` (envelope) for a responsibility-bearing sale | `pos-sales/sales.yaml` (RT-417, runtime RT-418) | Present (`1.28.0-draft`) |
| `posListChargeablePayers` | `GET /api/pos/v1/payer-accounts` | `operatorAuthorization` only (no device scheme) | Backend-Core `packages/contracts/openapi/pos-payers.openapi.yaml` (RT-570, runtime RT-802) | **Missing** (spec D-1) |

Nothing else is consumed. In particular the till does not call any Console payer route, the credit-reversal
operation (Q-7), ERPNext or the Connector.

## 2. Payer lookup (`posListChargeablePayers`)

- **Scope** comes only from the envelope (tenant and store). The request carries no store, tenant, device
  or terminal identifier.
- **Role.** The server re-checks, live, that the operator is an active `owner`, `tenant_admin` or
  `store_manager` with access to the store. A failure is 403 `sale_responsibility_role_refused` (the same
  code and body as capture), with one body for every cause.
- **Query.** Optional `category`, `cursor` (opaque, from the previous page), `page_size` 1 to 200. There is
  no search parameter: the till filters the page on the device and never puts a name in a URL. The till
  does not send `category` in v1 (Q-4).
- **Response.** A keyset page ordered by `payerRef` descending, with `asOf`. Each item is `payerRef`,
  `displayName`, `category`, `erpCustomerLinked`, `chargeable`. Never an ERPNext identifier, store, status,
  version, credit limit, balance, term or contact detail. `Cache-Control: no-store`.
- **`chargeable`** is the server's structural decision: active, of this tenant, in this store's scope, and
  linked to an ERPNext Customer. It is not a credit limit or balance decision.
- **Advisory.** The read holds nothing. Capture re-checks under lock and is the only authority.
- **Online only.** The till MUST NOT persist the page, MUST NOT show a payer from any earlier read, and
  MUST NOT offer a payer when the read cannot be made. The contract defines no offline freshness rule.
- **Outcome order:** 401, 403, 400, 200; 429 from the rate limit; 500.

## 3. Capture with a responsibility (`captureSale`)

### Request mapping

| Body field | Source in the till | Rule |
|:--|:--|:--|
| `responsibilities` | The picked payer and the entered amount | Exactly one entry: `payerRef` (uuid from the live read), `amount` (positive exact-decimal string, at most 15 integer and 4 fraction digits), `sequence` 1. Part of the sale `payload_hash`. |
| `tenders` | The immediate tender, net of change | Present only when a tender exists. Absent means zero for the coverage rule. A responsibility is never turned into a tender. |
| everything else | Unchanged from today's capture | The till adds no other field for credit. No tenant, store or actor field is sent. |

Coverage rule (server, exact decimal, no rounding): `sum(tenders) + sum(responsibilities) = posTotal`.
With `responsibilities`, this replaces the tender-only rule, so a fully credited sale is a valid
full-credit sale and is not tender-unknown.

### Headers and path

- Envelope bearer; `Idempotency-Key` is required and is the deterministic key the capture client already
  derives for the sale. The same key and the same body must be sent on every retry (spec FR-8).
- The device bearer is never used, and a sale with a responsibility never takes the device path even when
  a selling cashier id is present.

### Server order of checks (so the till can reason about which refusal it sees)

1. Authentication (401).
2. For a replay of an already captured sale: the stored result, before the role check and every 422.
3. Role (403 `sale_responsibility_role_refused`) on the envelope path.
4. 422s in this order: `sale_responsibility_offline_refused` (device path only), then the coverage rule
   (`sale_responsibility_mismatch`), then voucher tenders, then the line price invariant, then the payers
   (`sale_responsibility_payer_invalid`).
5. Nothing is recorded on any failure.

## 4. Outcome matrix (till behavior)

No outcome finalizes the sale except an accepted capture. Copy is **proposed** and needs owner approval
(UX-12; Arabic is the authored language, shown here as the message intent in English).

| Outcome | Meaning | Till behavior |
|:--|:--|:--|
| 201 created, or 200 replay | Capture accepted | Finalize the sale once; clear the attempt; show completion. |
| 401 | Envelope missing, expired or revoked | Do not finalize. Ask the manager to sign in again. The attempt and cart are kept. |
| 403 `sale_responsibility_role_refused` | Operator may not charge a payer | Do not finalize. Close the credit option with a generic reason ("this account cannot record credit"). Cart intact. |
| 400 `validation_error` | Body defect (for example duplicate `sequence`) | Do not finalize, do not retry. Treat as a till defect: blocked state, logged with the request id. |
| 409 | Same key, different payload | Do not finalize, do not retry. Surface a blocked state; the attempt is not auto-repaired. |
| 422 `sale_responsibility_mismatch` | Coverage rule failed | Do not finalize. Show the coverage reason. Also log as a defect, because the local pre-check should have blocked it. |
| 422 `sale_responsibility_payer_invalid` | Payer not chargeable now (one body for every cause) | Do not finalize. Return to the picker with a fresh read; do not say which attribute failed. |
| 422 `sale_responsibility_offline_refused` | A responsibility reached the device path | Do not finalize. Till defect (R-PATH); blocked state, logged. |
| 422 other (`sale_line_pricing_invalid`, `sale_voucher_tender_invalid`) | Existing capture refusals | Existing handling; the sale is not finalized. |
| 425 `idempotency_in_progress`, 429 | Transient back-pressure | Retry synchronously, same key and body, after `Retry-After`. Not finalized meanwhile. |
| 5xx, timeout, no connection | Transient | Leave unfinalized; retry synchronously with the same key and body. If the manager cancels, the attempt is closed with the cart intact. Never queued. |

Money already applied as an immediate tender is never dropped by any row above (spec NFR-3; mechanism is
owner question Q-2).

## 5. Boundary assertions (verifiable non-goals)

- No call to ERPNext or the Connector; no Console payer route; no credit-reversal call in this feature.
- No balance, aging, limit, payment-application, claim or remittance logic in POS.
- No multi-payer entry (`maxItems 1`).
- No offline path, no outbox entry and no device-bearer request for a credit sale.
- No new contract, DTO or schema authored by POS.

## 6. Reversal note

A sale with a responsibility is voided or returned only through `recordCreditSaleReversal` (manager or
admin envelope). The ordinary void, return and refund routes answer 403 `credit_sale_reversal_restricted`
for every operator. The till must therefore not offer those routes for such a sale, and must show a
reasoned block instead (spec Q-7).
