# Quickstart: POS Credit & Third-Party Payer Flow

**Feature:** 020-pos-credit-and-third-party-tender-flow
**Spec:** [./spec.md](./spec.md) · **Plan:** [./plan.md](./plan.md)

> A reading path for the **later implementation issue**. Design documentation only: it describes the flow a
> developer would build, not code that exists. Nothing here is built, and the shapes below are illustrative.

## Prerequisites

- The POS pin of `pos-payers.openapi.yaml` is merged (spec D-1). Without it the till cannot read payers.
- The owner has answered the spec's owner questions Q-1 to Q-8.
- An online session of an `owner`, `tenant_admin` or `store_manager` holding the operator envelope.
- At least one payer in the store scope that is active and linked to an ERPNext Customer (created and linked
  in the Console, not at the till).

## Flow

```
1. Manager rings the cart as usual (Sale), opens Checkout.
2. Credit option is offered only if: online + eligible role + flag on. Otherwise hidden (role) or
   unavailable with a reason (offline, flag, read failure).
3. Open the picker: GET /api/pos/v1/payer-accounts on the envelope. Page with the opaque cursor. Filter
   on the device. Nothing is stored. chargeable:false payers are greyed out and not selectable.
4. Pick one payer. Enter the amount the payer owes. The remainder is the immediate tender (cash in pilot).
5. Coverage pre-check in integer minor units: tenders + amount = posTotal. Mismatch: commit disabled with a
   persistent reason, nothing sent.
6. Freeze the body and the idempotency key with the checkout attempt.
7. One synchronous POST /api/pos/v1/sales on the envelope, with tenders (if any) and responsibilities.
8. Accepted (201 or 200 replay): finalize the sale once, show completion, print the receipt with the payer
   line. Any other outcome: do not finalize; follow the outcome matrix in the consumption note.
```

## Illustrative request shapes (not code)

Part credit, 500.00 EGP sale, 150.00 cash, 350.00 owed by the payer:

```
tenders:          [ { method: cash, amount: "150.00", ... } ]
responsibilities: [ { payerRef: "<uuid from the live read>", amount: "350.00", sequence: 1 } ]
```

Full credit, no tender:

```
(tenders absent)
responsibilities: [ { payerRef: "<uuid>", amount: "500.00", sequence: 1 } ]
```

Amounts are exact-decimal strings converted from integer minor units at the boundary. The other fields of
the capture body are unchanged from today.

## What you will not do

- Queue a credit sale, send it later, or send it on the device path.
- Store, cache or reuse a payer list, or show one while offline.
- Offer a split across payers, a balance, a "settled" state or any word that says the credit part is paid.
- Call ERPNext, the Connector, a Console payer route, or the credit-reversal operation.
- Compute a tax split per payer.
- Edit `apps/pos/contracts/**` outside the gated pin PR.

## Status

Draft docs. Every gate in the spec is unsatisfied. Nothing is built or dispatched.
