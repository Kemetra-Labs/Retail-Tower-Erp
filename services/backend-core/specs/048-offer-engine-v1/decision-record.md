# Spec 048 — Decision record (RT-286)

**Status.** OD-1 to OD-10 are **approved by the owner** in the RT-286 planning session of 2026-11-11 (chat):
OD-1 to OD-5 first, then OD-2 (confirmed), OD-6 to OD-10 by answering the recommended option. They still need to be
recorded on RT-286. OD-12's permissions are approved too; its guardrail deferral is still proposed. OD-11 is decided
(option A) by the RT-1340 bench proof, under the owner's delegation of 2026-11-11. None of them is in OpenAPI, a
migration or code, so a reversal now costs only a doc change.

Section numbers like §17 refer to Confluence RETAIL 23134209 (owner-approved 2026-10-07).

---

## OD-1 — Exclusions, and which rule wins

| Option | Content |
|---|---|
| **A (approved)** | Include = products ∪ categories ∪ brands. Exclude = products ∪ categories ∪ brands. **Exclusion always wins**, whatever its dimension. |
| B | The most specific rule wins (product over brand over category). An excluded brand could then be re-included by product, which is harder to preview and easy to get wrong. |

**Approved: A.** It gives one rule a cashier and a manager can both predict. §11 targeting (product, category,
brand) gains the exclusion set it did not mention.

## OD-2 — "Cheapest" with more units than one application needs

| Option | Content |
|---|---|
| **A (approved)** | Sort the eligible units by price. The `k × Y` **cheapest units in the whole basket** are the rewards. E2: 100, 80, 60, 40 → the discount goes to 60 and 40 (40.00 off). |
| B | Pairwise: sort by price, then every (X+1)-th unit is a reward. E2 → 80 and 40 (48.00 off). It is common in some retailers, but it does not match "the discount goes to the cheapest". |

**Approved: A.** It is the literal owner rule ("الخصم على الأرخص سعراً"). It is also the lower discount cost of the
two, and it does not depend on how units are paired.

*Note.* In the chat proposal, the method was worded as "every second unit" and the outcome as "the two cheapest
units". Those disagree for E2. The owner confirmed option A on 2026-11-11, with E2 as the example.

## OD-3 — Where the discount sits, and returns

| Option | Content |
|---|---|
| **A (approved)** | The whole discount sits on the **reward unit(s)**. A return recomputes the offer on the units kept, using the frozen version and prices, and **claws back** a discount the kept units no longer earn (spec §9). |
| B | Spread the discount across all participating units in proportion to price. Returns need no clawback, but every participating line shows an odd net, and the "second item at 40%" receipt no longer reads as such. |

**Approved: A.** It gives a readable receipt, and a customer cannot keep the discounted item and return the item
that paid for it at full refund.

## OD-4 — Lines with quantity above one

**Approved:** the till **splits** each reward unit into its own quantity-1 line (spec §6 step 6). The reward's net
then always divides by its quantity, which the Connector requires (RT-857 `discount_not_divisible`). Returns also
stay per unit.

## OD-5 — Combining with other discounts

**Approved:** V1 offers are **exclusive**:

- a line with a manual discount is not eligible for an offer;
- an offer line cannot also take a manual discount;
- a unit belongs to at most one offer (see OD-7).

Stacking modes (Exclusive, Stackable, Best Deal, §17) remain the model. V1 implements only Exclusive. The manual
discount keeps its own manager authority (§17: an offer cannot bypass it).

---

## OD-6 — How the till knows which products are eligible

| Option | Content |
|---|---|
| **A (recommended)** | Backend-Core **materialises the eligible set** (product ids) per offer version into each Pack revision. It re-materialises when a catalog change moves a product into or out of a set. The till matches product ids only. |
| B | Add `categoryId` and `brandId` to the POS read-down. The Pack carries the rules, and the till resolves eligibility. |

**Approved: A** (owner, 2026-11-11). The read-down contract does not change. Server verification of an offline sale is exact ("was
the product in the set of Pack revision R?"), and it cannot drift with a category edit made while the till was
offline. The till runs the Pack and invents no rule (§19). Cost: a large category-wide offer makes a larger Pack
(about 10 000 ids, roughly 400 KB before compression), which is acceptable.

## OD-7 — Two active offers that cover the same product

**Approved** (owner, 2026-11-11): in V1, **publish refuses** an offer whose eligible set overlaps another Scheduled or Active offer in
any shared store during an overlapping window. The conflict preview names the other offer and the shared products.
Evaluation never has to choose between offers. Best Deal (§17) comes later, together with stacking.

**Clarifications** (owner-delegated, RT-1335 contract review, 2026-11-11; contract `offers.openapi.yaml`):

- **Paused offers count.** The conflict check covers Scheduled, Active **and Paused** offers, because a paused offer
  can be resumed; a resume re-runs the same check and is refused with `offer_conflict` when it would create an
  overlap.
- **Catalog re-materialisation.** A catalog change after publish (a product moved into a category or brand) can make
  two live offers (Scheduled, Active or Paused) want the same product in the same store. Backend-Core then keeps the
  product only in the offer published **earliest** (tie: the lower `offerId`), removes it from the later offer's
  eligible set in that Pack revision, and reports the later offer with a conflict (`rematerialisationConflicts` on
  the Console offer read and preview). Each product id therefore appears in **at most one** offer's
  `eligibleProductIds` per Pack, an invariant the till may rely on.

## OD-8 — Trusted time and freshness offline

**Approved** (owner, 2026-11-11):

- The Pack carries `issuedAt` (server time).
- The till computes "now" as `issuedAt + monotonic elapsed time`.
- After a restart without a fresh Pack, scheduled offers are not applied.
- A Pack older than **24 h** (a tenant setting, 1–72 h) is stale, and offers are not applied offline.

This is fail-safe: the customer pays the regular price. It meets the §19 requirement that a trusted-time basis is
defined before offline scheduling ships.

## OD-9 — The server finds a different offer result from the till's

**Approved** (owner, 2026-11-11):

- Arithmetic errors (line invariant, rounding, a reward line with quantity other than 1) are **rejected** as a till defect: 422 `sale_line_pricing_invalid`, the existing line-pricing refusal (RT-105, RT-740), as fixed by the RT-1335 contract. A malformed object is 400.
- A rule-level mismatch (eligible set, `k`, which units are rewards) is **accepted and flagged** to the sale-review path. The sale happened, so its frozen facts are kept, and Backend-Core never re-prices it silently.

## OD-10 — A return that would need the customer to pay back

**Approved** (owner, 2026-11-11): if `refund_O < 0` (possible when Y > X or P is high), the return is **refused**
(`promotion_clawback_exceeds_refund`). The till asks the cashier to add the reward units to the return. A return
never charges the customer in V1.

## OD-11 — How a clawback is posted to ERPNext

| Option | Content |
|---|---|
| **A (decided)** | Reduce the credit-note rate of the returned non-reward units by the clawback. The return line is split to quantity 1 where the clawback does not divide. |
| B | Post the credit note at the original nets, plus a separate non-stock "promotion clawback" line. |

**Decided: A** (2026-11-12, RT-1340). The owner delegated the choice on 2026-11-11 ("I delegate you to decide and
choose recommended", RT-286 comment 16658), with the rule: implement A if it posts exactly on ERPNext v16, else B if
B does, else stop. The bench proof is in
[`integrations/erpnext-connector/docs/research/rt-1340-od11/`](../../../../integrations/erpnext-connector/docs/research/rt-1340-od11/README.md)
(Frappe v16.52.0, ERPNext v16.51.0). That was a local disposable bench with the `connector/bench` pins. The lab's ERP
image is built from the same ERPNext 16.51.0, but the proof did not run on the lab hosts. The lab run is RT-1341 step 5,
once A is implemented; the owner may revisit the choice then. Results:

- **A posts exactly.** E1, return the 300 with a clawback of 80.00: one row of −1 × 220.00 (`price_list_rate` 300.00,
  `discount_amount` 80.00), total −220.00, which equals the refund. GL balances. A clawback of 10.01 on 3 × 100.00
  splits into rows of 96.66, 96.66 and 96.67 on the same original row: total −289.99. ERPNext's over-return cap still
  holds.
- **B does not post.** ERPNext v16 refuses a positive-quantity row in a return. It refuses a negative rate unless the
  site-wide "Allow Negative rates for Items" is on, and the Connector never changes Selling Settings (RT-283 D6).

Consequences:

- The clawback shows on the credit note as a native visible discount on the returned units, in the RT-857 shape. No
  item, account or ERPNext setting is added. Pricing Rules stay ignored (`ignore_pricing_rule = 1`).
- Fail closed: a clawback that cannot be represented exactly at the currency minor unit is
  `permanently_rejected / validation`, and nothing is posted.
- **Not yet postable, needs a contract change first** (recorded on RT-1340):
  1. The Connector's posting feed (`erpnext-connector/posting-feed.yaml`) carries no clawback and no line promotion,
     so the Connector cannot learn the clawback or which returned units take it. The interim refusal
     `promotion_return_requires_clawback` stays until a contract issue adds them and RT-1340 implements A.
  2. ERPNext refuses a credit-note rate above the original row's rate. So a return that gives back an earlier clawback
     (golden sequence S3 step 2: the reward unit refunded at 200.00 after a sale net of 120.00) cannot be posted under
     A alone. A give-back row of quantity −1 on a non-stock item, next to the reward unit at its net, does post. The
     `recordReturn` rule cannot carry this refund either (`returnTotal` = Σ `lineAmount` − Σ clawback = 120.00).

## OD-12 — Permissions and guardrails

**Permissions approved** (owner, 2026-11-11):

- `offers.manage` and `offers.publish` go to owner and tenant_admin.
- `offers.pause` goes to owner and tenant_admin for every store, and to store_manager for **their own stores only**. A pause needs a reason and writes an audit row. A store_manager cannot publish, edit or resume an offer; resuming a paused offer is `offers.publish`.
- All three run through the Policy engine (RT-284).

**Guardrails, still proposed** (not yet asked):

- Price guardrails (a minimum selling price, a tenant maximum percent, §17) are deferred until the catalog has a price-floor field. V1 is bounded only by `P ≤ 100`.
