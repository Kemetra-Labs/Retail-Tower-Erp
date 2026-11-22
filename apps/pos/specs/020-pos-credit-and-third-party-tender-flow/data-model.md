# Data Model: POS Credit & Third-Party Payer Flow

**Feature:** 020-pos-credit-and-third-party-tender-flow
**Spec:** [./spec.md](./spec.md) · **Plan:** [./plan.md](./plan.md)

> Describes the till-side shapes and how they map to the **consumed** contracts. The schemas live in the
> Backend-Core contracts; this file maps to them and does not redefine them. No code, YAML or migration.

## E1. Payer responsibility (in the sale body)

Maps to `SaleResponsibility` in `captureSale`'s `responsibilities`.

| Till value | Wire field | Type and rule |
|:--|:--|:--|
| Picked payer | `payerRef` | uuid from the live payer read. Never typed, guessed or stored. |
| Amount owed by the payer | `amount` | Positive exact-decimal string (`^[0-9]{1,15}(\.[0-9]{1,4})?$`, not zero). Converted from integer minor units at the boundary only. |
| Position | `sequence` | Integer, always 1 in this version (one payer per sale). |

`responsibilities` has `minItems 1, maxItems 1`. It is part of the sale `payload_hash`: a replay that adds,
drops or changes it is a different payload (409). Absent `responsibilities` leaves the hash as it was.

## E2. Tenders next to a responsibility

`tenders` (existing) is sent only when a tender exists. Net of change. With a responsibility, the rule is
`sum(tenders) + amount = posTotal`; an absent `tenders` counts as zero (full-credit sale, not tender-unknown).

## E3. Chargeable payer (read-only, online)

Maps to an item of `PosPayerPage` from `posListChargeablePayers`.

| Field | Till use |
|:--|:--|
| `payerRef` | Carried into E1 when picked. |
| `displayName` | Shown to the eligible role only; may name a person; never in a URL or log. |
| `category` | Not shown in v1 (Q-4). |
| `erpCustomerLinked` | Explains a greyed-out payer. |
| `chargeable` | `false` means listed greyed out, never selectable, never submitted. Advisory only. |
| `asOf` (page) | Freshness of the page; the till does not reuse a page. |

The contract returns no `externalRef`, store, status, version, balance, limit, term, contact or tenant. The
till stores none of them.

## E4. Credit capture attempt (till-local, not a server concept)

| Field | Purpose |
|:--|:--|
| frozen request body | Byte-stable so a retry has the same `payload_hash` (FR-8). |
| idempotency key | The deterministic key the capture client derives for the sale. |
| state | `composing`, `sending`, `retrying`, `accepted`, `refused`, `abandoned`. |
| last outcome code | The server `error.code` or a transport class; no payer name. |

Stored before the first send, kept until `accepted` or `abandoned`. It is **not** an outbox row: a credit
sale never enters `sale_sync_outbox`. Whether it lives in the existing local checkout record or its own
table is an implementation decision; any new table needs a POS migration (a gated path) in the implementation
issue, not here.

## E4a. Local sale record of an accepted credit sale

FR-5b: after acceptance the till stores, with the local sale, the server sale reference and the accepted
`payerRef` and `amount` (and the payer name if Q-6 allows). Reason: the receipt line, a reprint after a restart
and the void/return guard must know the sale carries a responsibility without a server call. Today the local
sale row carries none of it. The storage change is a POS migration, a gated path, owned by the implementation
issue. The sale is recorded as already captured: **no** pending `sale_sync_outbox` row (R-FINALIZE).

## E5. Receipt data

The accepted `Sale.responsibilities` returns `payerRef` and `amount` only. The receipt line needs a payer
name, which would come from the picker at sale time (Q-6). The line shows the amount owed by the payer and
no "paid" word (R-TRUTH).

## Money boundary

```
Till internal: integer minor units (src/shared/money.ts)
        |  convert only at the contract boundary
        v
Wire: exact-decimal string, "350.00"
```

Round trip is exact. No float decides an amount. The coverage pre-check runs on integer minor units.

## State discipline (till view)

```
[ cart ready, eligible online manager ]
   | pick payer (live read) + enter amount + coverage pre-check passes
   v
[ freeze body + key ]──► one synchronous captureSale (envelope)
   ├─ accepted (201 / 200 replay) ─► finalize once ─► completion
   ├─ 401 / 403 / 400 / 409 / 422 ─► not finalized, reason shown, attempt kept or closed per outcome
   └─ transient (transport, 425, 429, 5xx) ─► not finalized ─► retry, same key and body
```

The till holds no receivable, balance or settled state. Everything after acceptance (posting to the payer's
ERPNext Customer, collection) is Backend-Core, the Connector and ERPNext.

## Local validation before submit

1. Online, eligible role, flag on.
2. One payer picked from the current read, `chargeable: true`.
3. `amount` > 0 and not above the amount due.
4. `sum(tenders) + amount = posTotal` exactly, in integer minor units.
5. No float in any money field.
6. Operator envelope present (else do not submit).
