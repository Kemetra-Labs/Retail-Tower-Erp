# Tasks: POS Credit & Third-Party Payer Flow

**Feature:** 020-pos-credit-and-third-party-tender-flow
**Spec:** [./spec.md](./spec.md) · **Plan:** [./plan.md](./plan.md)
**Last updated:** 2026-11-22 (RT-420 re-scope)

> **Two parts.** Part A is the docs deliverable of RT-420 (done by this change). Part B is the task outline
> for the **separate implementation issue** (spec D-5). Part B is not authorized work: it starts only after
> an owner go-ahead and the Q-1 to Q-10 answers. Nothing in Part B is built.

## Part A: RT-420 docs deliverable

- [x] A1 Rewrite the spec around payer responsibilities on the sale (R-SALE) with rules R-OFFLINE, R-PATH, R-ROLE, R-SYNC, R-ONE, R-COVER, R-FRESH, R-NOSUBMIT, R-TRUTH, R-NOTAX. (`spec.md`)
- [x] A2 Remove the retired intent route everywhere in this folder, including its consumption note. (`contracts/`)
- [x] A3 Add the consumption note for `captureSale` with `responsibilities` and `posListChargeablePayers`, with the outcome matrix. (`contracts/sale-responsibilities-consumption.md`)
- [x] A4 Specify the offline rule and the coverage pre-check with Given/When/Then scenarios (spec scenarios 3, 4, 5, 6).
- [x] A5 Record the envelope-path / synchronous-capture mode (R-SYNC, FR-5, FR-7, FR-8) and its departure from the old draft.
- [x] A6 State the payer-lookup dependency correctly (server side done, POS pin missing, D-1).
- [x] A7 List the owner questions (Q-1 to Q-10).
- [x] A8 Remove healthcare-specific framing (no insurance, co-pay, claim or policy fields).
- [x] A9 Check: a case-insensitive search of this folder for the retired route's names returns nothing. Command: `grep -rniE "settlement[-]intent|Settlement[I]ntent" apps/pos/specs/020-pos-credit-and-third-party-tender-flow` (exit 1 means clean).

## Part B: implementation issue outline (not started)

Order follows the plan phases. `[T]` means a test is written first (RED, then GREEN).

### B0. Gate and pin
- [ ] B0.1 Owner answers Q-1 to Q-10 and approves the implementation issue.
- [ ] B0.2 `[GATED: contract pin]` PR: vendor `pos-payers.openapi.yaml`, regenerate `api-types.ts` and the snapshot; narrow source-scope-guard exemption on that branch; `pos` preflight on CircleCI (RT-981 rules).

### B1. Payer read (main process)
- [ ] B1.1 [T] Payer client on `createBackendTransport`: pages, `cursor`, typed results for 401, 403, 400, 429, 5xx, transport fault.
- [ ] B1.2 [T] Assert nothing is persisted and no earlier page is ever returned (R-FRESH).

### B2. Credit capture mode (main process)
- [ ] B2.1 [T] Frozen body and idempotency key stored with the checkout attempt before the first send (FR-8).
- [ ] B2.2 [T] One synchronous envelope send; finalize only on 200 or 201; never `sale_sync_outbox`; never the device bearer (R-SYNC, R-PATH).
- [ ] B2.2a [T] Finalize route for a credit checkout (R-FINALIZE, Q-9): the automatic finalize scan skips a credit checkout even when its cash tender has settled; a full-credit sale (no settled tender) reaches finalize; an accepted sale is recorded with its server sale reference and no pending outbox row; a restart between settle and capture does not finalize or enqueue it.
- [ ] B2.2b [T] Persist the accepted payer fact with the local sale (migration, gated path; FR-5b) and assert a reprint after a restart shows the payer line.
- [ ] B2.3 [T] Outcome matrix: one test per row of the consumption note, none finalizing except acceptance.
- [ ] B2.4 [T] Transient retry with the same key and body; honors `Retry-After`; cancel closes the attempt with the cart intact.
- [ ] B2.5 [T] A cashier session cannot reach this mode (R-ROLE).

### B3. Checkout UI (renderer)
- [ ] B3.1 [T] Credit option shown only for an online, eligible, flag-on session; offline shows the reason (scenarios 4, 12).
- [ ] B3.2 [T] Picker: online load, device filter, greyed `chargeable: false` payers, empty and error states (scenarios 9, 10).
- [ ] B3.3 [T] Amount entry and coverage pre-check, exact arithmetic, persistent reason, commit disabled on mismatch (scenarios 1 to 3). Scanner bursts rejected in the amount field (M-S5).
- [ ] B3.3a [T] Credit is unavailable while an automatic offer applies to the cart, with a persistent reason, and no capture body for a credit sale ever carries `promotion` (R-NOPROMO, FR-12, scenario 14; Q-10).
- [ ] B3.4 Arabic copy approved by the owner before it ships; RTL, logical properties, 44px targets, no new shortcuts.

### B4. Receipt and guards
- [ ] B4.1 [T] Receipt line for the payer responsibility without a "paid" word (scenario 13; Q-5, Q-6).
- [ ] B4.2 [T] Void and return screens show a reasoned block for a sale that has a responsibility (Q-7).
- [ ] B4.3 [T] Audit events carry no payer name or free-text `payerRef` (FR-10).

### B5. Evidence
- [ ] B5.1 Behavioral-tier tests present and discovered by the POS Vitest run (root `CLAUDE.md` section 12).
- [ ] B5.2 Run the new files with the per-file coverage gate before the first push.
- [ ] B5.3 Packaged-app proof against the lab: happy path (part and full credit) and the offline refusal. State "posting held" until RT-419 lands.

## Dependency order

```
B0.1 (owner answers) ──► B0.2 (pin) ──► B1 ──► B2 ──► B3 ──► B4 ──► B5
                                           └──────► B2 can start on the existing sales.yaml pin
                                                    in parallel with B1 once B0.1 is done
```

B2 uses the capture field that the POS pin already carries, so it does not wait for the payer pin. B3
needs both B1 and B2.
