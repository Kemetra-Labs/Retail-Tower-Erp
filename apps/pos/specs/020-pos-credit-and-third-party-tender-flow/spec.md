# Feature Specification: POS Credit & Third-Party Payer Flow (payer responsibilities on the sale)

**Feature ID:** 020-pos-credit-and-third-party-tender-flow
**Status:** Draft, re-scoped by RT-420 (Planning, docs only). Not built. No product code, no OpenAPI, no migration.
**Created:** 2026-06-16
**Last Updated:** 2026-11-22 (RT-420 re-scope; baseline `origin/main` `510706c4d`)
**Owner:** POS (consumer). Backend-Core owns the consumed contract.
**Repo path:** `apps/pos/` in `Kemetra-Labs/Retail-Tower-Erp` (the former `Kemetra/POS` repository is frozen).
**Jira:** RT-420 (this re-scope), RT-413 (plan, owner decision R-1), RT-417 (contract), RT-418 (runtime), RT-570 and RT-802 (payer lookup), RT-422 (removal of the old runtime), Epic RT-2.

> **What changed from the 2026-06-16 draft.** The draft bound this feature to a separate post-sale
> intent route that Backend-Core has since retired (owner decision R-1, RT-413 comment 11669; contract
> RT-417; runtime removed by RT-422, #772). The draft also described a multi-payer insurance co-pay
> flow. Both are gone. The sale now carries who owes what, in the sale itself. This file is the
> replacement; nothing of the retired route is kept.

---

## 0. What this spec is and is not

This is a **consumer spec**. It defines how the till captures a **payer responsibility** on a sale and
submits it inside the sale capture that POS already makes, and how the till gets the payers it may
charge. It consumes two Backend-Core operations that are already on Backend-Core `main`:

1. `captureSale` (`POST /api/pos/v1/sales`) with the optional `responsibilities` field
   (`apps/pos/contracts/backend-core/openapi/pos-sales/sales.yaml`, the pinned copy; RT-417).
2. `posListChargeablePayers` (`GET /api/pos/v1/payer-accounts`;
   `services/backend-core/packages/contracts/openapi/pos-payers.openapi.yaml`; RT-570 contract, RT-802 runtime).
   **POS has no pin of this contract yet** (see Dependencies D-1).

It **is not**:

- A contract spec. POS authors no OpenAPI and does not edit `apps/pos/contracts/**` (a pinned copy).
- A receivables, balance, cash-application, claim or remittance feature. ERPNext owns the A/R balance,
  aging, terms, credit limits and collection. Backend-Core keeps only the immutable per-sale payer
  allocation and the payer identity. POS shows no balance and no "settled" state.
- An offline feature. **Offline credit is disabled** (rule R-OFFLINE below).
- A reversal feature. A credit sale is voided or returned only through the manager/admin credit-reversal
  operation (`recordCreditSaleReversal`, RT-577). This spec adds no reversal flow.
- A product-code change. The implementation is a separate issue (Dependencies D-5).

## Overview

Today the till can finalize a sale that is fully tendered at the counter. It cannot record that part
or all of the sale is owed by a named business payer (a credit customer on account, or another third
party). RT-417 gave the sale a `responsibilities` field for this. This spec defines the till side:

- who may use it (an owner, tenant admin or store manager who holds the operator envelope);
- how the payer is chosen (a live, online read of the payers the operator may charge);
- how the amounts are checked locally before anything is sent;
- how the sale is captured (synchronously, online, before it is finalized, never queued);
- what the cashier sees when the server refuses, and on the receipt.

The visible outcome: an eligible manager can ring a sale, name one payer for the unpaid part, take the
remainder (if any) in the immediate tender, and the till captures it honestly or stops it with a reason.

---

## Rules (normative)

| ID | Rule | Source |
|:--|:--|:--|
| **R-SALE** | The payer allocation is part of the sale (`responsibilities` in the `captureSale` body, part of the sale `payload_hash`). It is never a separate call after the sale. | RT-413 R-1; sales.yaml |
| **R-OFFLINE** | **Offline credit is disabled.** A sale with a payer responsibility is never saved to be sent later, never put in `sale_sync_outbox`, and never sent on the device path. While the till is offline the credit option is unavailable with a stated reason. | Owner decision 2026-10-16 (Option A); RT-413 R-1 |
| **R-PATH** | A responsibility-bearing sale uses the operator envelope (`operatorAuthorization`) path only. The device bearer is never used for it. | sales.yaml `captureSale` |
| **R-ROLE** | Only an operator whose live role is `owner`, `tenant_admin` or `store_manager` may attach a responsibility. For any other operator the credit option is **not offered** (hidden). The server decides (403 `sale_responsibility_role_refused`); the till never trusts its own role check. | sales.yaml; RT-417 |
| **R-SYNC** | Capture is synchronous, online, before finalize. The sale is finalized (locally and as a completed sale) only after the server accepts the capture. A transient failure leaves the sale unfinalized. | sales.yaml; comment 12134 |
| **R-FINALIZE** | A responsibility-bearing checkout is **not** finalized by the existing automatic path. Today a sale is finalized by a background scan of settled payments, and finalizing always writes a pending `sale_sync_outbox` row. A credit checkout must stay out of that scan until the server has accepted the capture, and on acceptance must be recorded as a sale that is already captured, with its server sale reference and **no** pending outbox row. A full-credit sale has no settled tender, so it needs its own way to reach finalize. The mechanism is an implementation choice (Q-9); the rule is not. | Independent review of this change; `finalize-listener.ts`, `finalize-transaction.ts` |
| **R-ONE** | At most **one** payer per sale in this version (`responsibilities` has `maxItems 1`, `sequence` is 1). No split across payers. | sales.yaml `responsibilities` |
| **R-COVER** | Coverage pre-check: `sum(tenders) + responsibility amount = posTotal`, exactly, in integer minor units, before submit. A mismatch blocks the commit locally. An absent `tenders` counts as zero; a sale fully covered by the payer is a valid **full-credit sale** (not a tender-unknown sale). The server rule is authoritative. | sales.yaml; RT-417 |
| **R-FRESH** | The payer list is read online at the moment the manager opens the picker, is never stored for later use and is never shown from a cache. `chargeable` is advisory, not a reservation. | pos-payers contract |
| **R-NOSUBMIT** | A payer with `chargeable: false` may be listed greyed out with its reason, and is never selectable or submitted. | pos-payers contract |
| **R-TRUTH** | The till never describes the credit part as paid, received or settled. It shows only what the server returned. | UX-12.13; I-17 |
| **R-NOPROMO** | No automatic offer is applied to a credit sale. The contract refuses a line `promotion` together with `responsibilities` (400), because a credit sale is reversed through the credit reversal, which does not settle an offer clawback, and says the till applies no offer to a credit sale. How the till gets there when the cart already has an offer is owner question Q-10. | sales.yaml (RT-1337 note on `promotion`) |
| **R-NOTAX** | The till computes no tax split per payer. Tax stays as it is today (pending). | sales.yaml `SaleResponsibility` |

## User scenarios and testing

### Primary user story

A store manager is signed in at the till and rings a sale of 500.00 EGP for a business customer who has
an account. They open the credit option, choose the customer from the list of payers the till loaded
just now, enter 350.00 as the amount owed by the payer, and take 150.00 in cash for the rest. The till
checks 150.00 + 350.00 = 500.00 locally, captures the sale on the server in one synchronous call, and
only then finalizes it. The receipt shows the cash taken and a line saying 350.00 is owed by the payer.

### Acceptance scenarios

Each scenario is a test target for the implementation issue. Money is shown as EGP for readability; the
wire form is an exact-decimal string and the till works in integer minor units.

1. **Part credit, accepted.**
   Given an online manager session and a chargeable payer, a cart with `posTotal` 500.00, a cash tender
   of 150.00 and a responsibility of 350.00,
   When the manager commits,
   Then the till sends one `captureSale` with `tenders` (150.00) and `responsibilities` (one entry,
   `sequence` 1, 350.00) on the envelope path, finalizes the sale only after the server accepts, and the
   sale never enters `sale_sync_outbox`.
2. **Full credit, no tender.**
   Given `posTotal` 500.00 and a responsibility of 500.00 with no tender,
   When the manager commits,
   Then `tenders` is absent from the body, the sale is accepted as a full-credit sale, and it is not
   recorded as tender-unknown.
3. **Local coverage mismatch blocks before submit.**
   Given a cash tender of 100.00 and a responsibility of 350.00 against `posTotal` 500.00,
   When the manager tries to commit,
   Then the commit is disabled with a persistent reason, nothing is sent, and the cart is intact.
4. **Offline credit is refused locally.**
   Given the till has no connection (real connectivity signal),
   When the manager opens checkout,
   Then the credit option is shown unavailable with the offline reason, the payer list is not requested
   or shown from any cache, and a sale cannot be captured with a responsibility.
5. **Connection lost during capture.**
   Given the manager commits and the request times out,
   When the till retries,
   Then it retries synchronously with the **same** `Idempotency-Key` and the same body, the sale stays
   unfinalized until a capture is accepted, it is never queued for the background drain, and it is never
   re-sent without its responsibility or with the responsibility turned into a tender.
6. **The device path never carries a responsibility.**
   Given a sale with a responsibility and a selling cashier id that would normally select the device
   path,
   When the sale is captured,
   Then the envelope path is used, or the capture does not happen. A body with `responsibilities` is
   never sent with the device bearer.
7. **Role refused.**
   Given the server answers 403 `sale_responsibility_role_refused`,
   When the till receives it,
   Then the sale is not finalized, the credit option closes with a generic reason (the till does not say
   which standing failed), and the cart is intact.
8. **Each 422 reaches the till before finalize.**
   Given the server answers 422 `sale_responsibility_mismatch`, `sale_responsibility_payer_invalid` or
   `sale_responsibility_offline_refused`,
   Then the sale is not finalized and is not dead-lettered. `mismatch` shows the coverage reason (the
   local pre-check should have prevented it, so it is also logged as a till defect);
   `payer_invalid` returns the manager to the payer picker with a fresh read; `offline_refused` is a
   till defect (the till must never use the device path for credit) shown as a blocked state.
9. **Stale `chargeable`.**
   Given a payer was `chargeable: true` when listed and was suspended or unlinked before commit,
   When the server answers 422 `sale_responsibility_payer_invalid`,
   Then the till treats the read as advisory, reloads the payers, and does not finalize.
10. **Unlinked payer is never submitted.**
    Given a payer with `chargeable: false` (not linked to an ERPNext Customer),
    When the manager views the picker,
    Then the payer is greyed out with the reason, cannot be selected, and no request names it.
11. **Replay returns the stored result.**
    Given a capture that succeeded but whose response was lost,
    When the till resends the same key and the same body,
    Then it receives the stored result and finalizes the sale once. A changed body under the same key is
    a 409 and is surfaced, not retried.
12. **Not offered to a cashier.**
    Given a cashier session (device path, no envelope),
    When the cashier opens checkout,
    Then the credit option is not shown.
13. **Receipt shows the payer line without a "paid" claim.**
    Given an accepted credit sale,
    When the receipt is printed or previewed,
    Then it shows the immediate tender as taken and a separate line naming the payer and the amount owed
    by the payer, with no word that says the credit part was paid, received or settled.

14. **Offers never reach a credit sale.**
    Given a cart on which an automatic offer applies, and a manager who chooses credit,
    When the manager commits,
    Then no line of the capture body carries `promotion`, so the server never answers 400 for
    `promotion` plus `responsibilities`. How the cart reaches that state (credit is blocked while an offer
    applies, or the cart is re-priced without the offer) is Q-10; until decided, the till blocks credit while
    an offer applies, with a persistent reason, and nothing is sent.

### Edge cases

- **Amount bounds.** The responsibility amount is strictly positive and not above the amount due. An
  amount of zero, a negative amount or an amount above `posTotal` blocks the commit locally.
- **Change.** Immediate tender is net of change (existing cash rules). A responsibility never changes
  how change is computed; there is no change on the credit part.
- **No payers.** An empty payer page is a normal state ("no payer is available for this store"), with a
  pointer that an admin creates payers in the Console. The till does not create a payer.
- **Payer list fails.** If the read fails (400 `validation_error` for a bad cursor or category, 401, 403, 429, 5xx, timeout), no payer is offered and the
  credit option stays blocked with the reason. The till does not fall back to any stored list.
- **Settled cash before capture.** The immediate tender may settle before the capture call. That must not finalize the sale (R-FINALIZE, FR-5a). If the capture is then refused, Q-2 decides what happens to the cash.
- **Restart mid-capture.** The key and the frozen body survive a restart (see FR-8) so a retry is a
  replay, not a second sale.
- **Void or return of a credit sale.** The existing POS void and return screens must not offer the
  ordinary route for a sale that has a responsibility (the server refuses it with 403
  `credit_sale_reversal_restricted`). Whether POS offers the credit-reversal operation itself is an
  owner question (Q-7).

## Requirements

### Functional requirements

- **FR-1.** The till MUST offer the credit option only to an online session that holds the operator
  envelope for an eligible role (R-ROLE), with the feature enabled. Otherwise it is hidden (role) or
  shown unavailable with a reason (offline, flag, payer read failure).
- **FR-2.** The till MUST load the payer picker from `posListChargeablePayers` on the envelope path, once
  per opening of the picker, and MUST NOT persist, cache or reuse the result. Filtering is on the device
  (there is no search parameter). Paging follows the opaque `cursor`. The list shows `displayName` and
  whether the payer is `chargeable`; it does not show or store `externalRef`, status or any balance
  (the contract does not return them).
- **FR-3.** The till MUST let the manager pick exactly one payer and enter one amount; it MUST show the
  immediate-tender remainder and the running coverage check, and MUST block the commit on any mismatch
  (R-COVER), with persistent reason text.
- **FR-4.** The till MUST build `responsibilities` as `[{ payerRef, amount, sequence: 1 }]` with `amount`
  as an exact-decimal string converted from integer minor units at the boundary only (no float), and MUST
  send `tenders` only when a tender exists.
- **FR-5.** The till MUST capture the sale with one synchronous `captureSale` call on the envelope path
  and finalize the sale only on acceptance (R-SYNC). It MUST NOT queue the sale, MUST NOT use the
  device bearer (R-PATH) and MUST NOT strip, move or convert the responsibility on any retry.
- **FR-5a.** The till MUST keep a responsibility-bearing checkout out of the automatic finalize scan until a capture is accepted (R-FINALIZE). Neither a settled cash tender nor a restart may cause that sale to be finalized and enqueued without its `responsibilities`. A sale recorded without its responsibilities while a credit capture is pending, or sent later under the same key without them, is the failure this requirement prevents.
- **FR-5b.** The till MUST persist the accepted payer fact (`payerRef`, `amount`, the server sale reference) locally with the sale, so that the receipt line (FR-9), a reprint after a restart and the void/return guard (Q-7) know the sale carries a responsibility without asking the server first. Adding that storage is a POS migration (a gated path) and belongs to the implementation issue.
- **FR-6.** The till MUST map every outcome deterministically (see the consumption note, section 4):
  accepted, 401, 403 role refusal, 400, 409, each 422, 425, 429, 5xx and transport failure. No outcome
  finalizes a sale except acceptance.
- **FR-7.** A transient outcome (transport failure, timeout, 425, 429, 5xx) MUST leave the sale
  unfinalized and MAY be retried synchronously with the same key and the same body, honoring any
  `Retry-After`.
- **FR-8.** The idempotency key and the frozen request body MUST be stored with the checkout attempt
  before the first send, so a retry after a restart is byte-identical (same `payload_hash`).
- **FR-9.** The receipt MUST show the payer responsibility as its own line (payer name, amount) and MUST
  NOT claim that part was paid (R-TRUTH). The receipt keeps its current tax wording.
- **FR-10.** The till MUST audit the credit capture with the existing sale audit events (operator, sale,
  outcome), and MUST NOT log the payer name, `payerRef` values in free text, amounts with a name, or any
  card or credential data.
- **FR-11.** The till MUST NOT call ERPNext or the Connector and MUST NOT compute any balance, aging,
  credit limit or tax split (R-NOTAX).

- **FR-12.** The till MUST NOT send `promotion` on any line of a responsibility-bearing capture (R-NOPROMO) and MUST keep the credit option unavailable while an automatic offer applies to the cart, until Q-10 is decided. A 400 from `promotion` plus `responsibilities` is therefore a till defect, never an expected outcome.

### Non-functional requirements

- **NFR-1. Boundary.** Egress is Backend-Core only. No POS to ERPNext path (root `CLAUDE.md` section 4).
- **NFR-2. Money.** Integer minor units inside; exact-decimal strings on the wire; the coverage check is
  exact arithmetic with no rounding.
- **NFR-3. No silent loss (RT-24 core rule 1).** A valid cart is never lost on any refusal. Cash already applied is
  never silently dropped (see Q-2 for the mechanism).
- **NFR-4. No fake success (RT-24 core rule 2).** "Captured" is shown only after the server accepted. The credit part is
  never shown as paid.
- **NFR-5. Non-disclosure.** 401, 403 and `payer_invalid` show generic reasons that do not say which
  standing or payer attribute failed (the contract returns one body for every cause).
- **NFR-6. Privacy.** `displayName` may name a private person. It is business-class data: shown to the
  eligible role, never put in a URL, never logged, never kept in the payer cache (there is none).
- **NFR-7. UX rules.** Arabic-first and RTL, logical properties, 44px targets, no new keyboard shortcuts
  (D-K1), a scanner burst never enters the amount field (M-S5), no rolling money. Copy in this folder is
  **proposed** and needs owner approval before shipping.

## Success criteria

- **SC-1.** A reviewer can trace the till behavior to exactly two consumed operations (`captureSale` with
  `responsibilities`, and `posListChargeablePayers`) and confirm nothing else is consumed.
- **SC-2.** The offline rule (R-OFFLINE) and the coverage pre-check (R-COVER) each have Given/When/Then
  scenarios above (scenarios 3, 4, 5, 6).
- **SC-3.** Every server outcome of the consumed operations maps to one till behavior with no outcome that
  finalizes a sale except acceptance.
- **SC-4.** The folder consumes nothing from the retired intent route (history notes only), no insurance or
  co-pay flow is specified and no claim fields exist.
- **SC-5.** The open owner questions are listed (see Owner questions).

## Key entities

- **Payer responsibility** (`SaleResponsibility`): `payerRef` (uuid), `amount` (positive exact-decimal
  string), `sequence` (integer, 1 in v1). Part of the immutable sale. Not a receivable: no balance, no state.
- **Chargeable payer** (`PosPayer` item): `payerRef`, `displayName`, `category`, `erpCustomerLinked`,
  `chargeable`. Read-only, online, advisory.
- **Credit capture attempt** (till-local): the frozen body, the idempotency key and the outcome, kept until
  the sale is accepted or abandoned. Not a new server concept.

## Assumptions

- The operator envelope is held only by manager/admin sessions on the till today (sales.yaml note), which
  is why credit is manager/admin-only. Whether a cashier-rung sale can be handed to a manager is not
  defined by any contract (Q-1).
- A payer must exist and be linked to an ERPNext Customer before it can be charged. Creating and linking
  payers is a Console job (RT-421, RT-572); POS only picks.
- `payerRef` values come only from the live read. POS never types, guesses or stores one.
- The category set in the payer contract includes a value named for insurers. POS cannot change that
  enum; whether the till shows the category at all is Q-4.

## Out of scope

- Any offline credit, cached credit decision or freshness rule (needs its own owner decision and a new
  contract version; RT-413 R-1).
- More than one payer per sale (needs a later contract version once RT-419 fixes the ERPNext shape).
- Void, return or refund of a credit sale (RT-577; see Q-7).
- Creating, updating or linking payers (Console).
- Balances, aging, payment application, claims, remittance (ERPNext).
- Tax split per payer.
- Any change to `apps/pos/contracts/**`, the generated client, or any product code in this issue.

## Dependencies

| ID | Dependency | State (2026-11-22) |
|:--|:--|:--|
| D-1 | **POS pin of `pos-payers.openapi.yaml`** (`posListChargeablePayers`): copy into `apps/pos/contracts/backend-core/openapi/`, regenerate `src/shared/api-types.ts` and `scripts/openapi-snapshot.json`. A `[GATED: contract pin]` PR; trips the source-scope-guard, so it needs a narrow exemption on its own branch (skill `merging-rt-pull-requests`). | **Missing.** Backend-Core side done (RT-570, RT-802). |
| D-2 | `captureSale` `responsibilities`, coverage rule, 403/422 codes (RT-417) and runtime (RT-418). | Done on Backend-Core `main`. POS pin already carries the field (`sales.yaml` 1.28.0-draft). |
| D-3 | Connector posting of credit sales to the payer's ERPNext Customer (RT-419). Until it lands the posting feed holds a credit sale. | To Do. Not a blocker for the till capture; a blocker for end-to-end proof and pilot use. |
| D-4 | Credit-sale reversal (RT-571, RT-577; `recordCreditSaleReversal`). | Done on Backend-Core. POS surface is Q-7. |
| D-5 | A POS **implementation issue** for the till flow (not yet written). Needs an owner go-ahead and the answers to the owner questions. | Not created. |
| D-6 | Pilot scope: pilot is cash only with no split tender (RT-536 D4); RT-420 is fix version Post-Pilot. This flow is post-pilot. | Stated. |
| D-7 | Admin Console specs 017 to 019 still describe the retired model (RT-421 re-pointed the Console). | Follow-up, not this issue. |
| D-8 | **Future cached credit decision** with freshness and amount limits, the condition under which offline credit could ever be enabled (RT-413 R-1; baseline 1361 to 1447). Needs its own owner decision and a new contract version. Until then R-OFFLINE stands and the payer read defines no offline freshness rule. | Not started; named as a future dependency, not a blocker. |

## Owner questions

These are listed, not decided. Each states the default the docs assume.

- **Q-1. Who rings the sale?** Only manager/admin sessions hold the envelope, and no contract defines a
  handoff from a cashier. Must the manager be the signed-in operator who rings the whole sale?
  *Assumed:* yes. No handoff flow is specified.
- **Q-2. Cash already applied when capture is refused.** The immediate tender is applied locally before the
  capture call (the body needs it). If capture then returns a 422/403, the sale is not finalized. What
  happens to the cash already collected: keep it as an applied tender in the same checkout so the manager
  can fix the payer and retry, or reverse it through the existing recovery path? Touches RT-24 core rules 1 and 3.
  *Recommended:* keep the applied tender, stay in Checkout with the reason, and never start a second sale.
- **Q-9. How does a credit checkout reach finalize?** The existing finalize path is a background scan of settled payments that always enqueues the sale for the background drain. Options: (a) gate that scan so it skips a credit checkout, and add a finalize variant that records an accepted, already-captured sale with no outbox row; (b) build a separate credit finalize that does not use the scan at all, which also covers a full-credit sale (no settled tender). Either changes finalize or the scan, not only the capture client. *Recommended:* (b), because a full-credit sale has no settled payment to key on and a gate on the shared scan puts the cash-sale path at risk.
- **Q-10. Offers on a credit sale.** The contract refuses an automatic offer on a credit sale. When a cart already has an offer and the manager chooses credit: (a) block credit while an offer applies, so the manager removes the offer's items or pays normally, or (b) re-price the cart without the offer, which changes the amount due the manager already saw. *Assumed until decided:* (a), because (b) changes a price after the cashier agreed it (a truth risk). Also decide whether the manager is told which offer blocks credit.
- **Q-3. Shift rule for a full-credit sale.** RT-998 refuses cash without an open shift. Does a sale with
  no cash tender need an open shift? *Assumed:* the existing rule is unchanged and applies only when a
  cash tender exists.
- **Q-4. The `insurer` payer category.** The server enum still contains an insurer value. The issue asks
  for no healthcare-specific terms. Show the category in the till at all? *Recommended:* do not show it;
  show the payer name and the linked state only. Renaming or dropping the enum value is a Backend-Core
  decision.
- **Q-5. Receipt wording and payer name.** Approve the credit line wording and whether the payer's name is
  printed on the customer receipt (it can name a private person). Proposed copy is in the consumption note.
- **Q-6. Where the receipt gets the payer name.** The captured `Sale.responsibilities` carries `payerRef`
  only. The name would come from the picker at sale time and be stored with the till's receipt data. OK to
  store the name locally for reprints? Needs verification against the receipt snapshot contract (RT-537).
- **Q-7. Reversing a credit sale at the till.** The ordinary void and return routes refuse it. Does POS
  offer the manager credit-reversal operation, or is a credit sale reversed only in the Console? Until
  decided, the till shows a reasoned block on the ordinary screens.
- **Q-8. Feature flag and pilot posture.** Confirm the flow ships behind a fail-closed `POS_PULSE_FEATURE_*`
  flag and stays off for the cash-only pilot.

## Gate mapping

All gates below are **unsatisfied** at spec time. Nothing here claims anything built, verified or merged
beyond the docs.

| Gate | Meaning | Status |
|:--|:--|:--|
| G-CONSUME | The till sends `responsibilities` on the envelope path exactly as the contract requires and handles each outcome. | Unsatisfied (not built) |
| G-FINALIZE | A credit checkout is finalized only after server acceptance, as an already-captured sale with no pending outbox row. | Unsatisfied (not built) |
| G-OFFLINE | A responsibility-bearing sale is never queued, never sent offline and never sent on the device path. | Unsatisfied (not built) |
| G-COVER | The local coverage pre-check blocks every mismatch before submit. | Unsatisfied (not built) |
| G-FRESH | The payer list is online only and never cached or persisted. | Unsatisfied (not built) |
| G-PIN | The POS pin of the payer lookup contract exists (D-1). | Unsatisfied (missing) |
