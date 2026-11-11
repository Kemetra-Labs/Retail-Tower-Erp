# Spec 048 — Decision record (RT-286)

**Status.** OD-1 to OD-5 are **approved by the owner** in the RT-286 planning session of 2026-11-11 (chat). They still
need to be recorded on RT-286. OD-6 to OD-12 are **proposed** by this spec, with a recommended option. None of them
is in OpenAPI, a migration or code, so a reversal now costs only a doc change.

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
units". Those disagree for E2. This record fixes the outcome the owner approved (A). The owner should confirm this
during review.

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

## OD-6 — How the till knows which products are eligible (proposed)

| Option | Content |
|---|---|
| **A (recommended)** | Backend-Core **materialises the eligible set** (product ids) per offer version into each Pack revision. It re-materialises when a catalog change moves a product into or out of a set. The till matches product ids only. |
| B | Add `categoryId` and `brandId` to the POS read-down. The Pack carries the rules, and the till resolves eligibility. |

**Recommended: A.** The read-down contract does not change. Server verification of an offline sale is exact ("was
the product in the set of Pack revision R?"), and it cannot drift with a category edit made while the till was
offline. The till runs the Pack and invents no rule (§19). Cost: a large category-wide offer makes a larger Pack
(about 10 000 ids, roughly 400 KB before compression), which is acceptable.

## OD-7 — Two active offers that cover the same product (proposed)

**Recommended:** in V1, **publish refuses** an offer whose eligible set overlaps another Scheduled or Active offer in
any shared store during an overlapping window. The conflict preview names the other offer and the shared products.
Evaluation never has to choose between offers. Best Deal (§17) comes later, together with stacking.

## OD-8 — Trusted time and freshness offline (proposed)

**Recommended:**

- The Pack carries `issuedAt` (server time).
- The till computes "now" as `issuedAt + monotonic elapsed time`.
- After a restart without a fresh Pack, scheduled offers are not applied.
- A Pack older than **24 h** (a tenant setting, 1–72 h) is stale, and offers are not applied offline.

This is fail-safe: the customer pays the regular price. It meets the §19 requirement that a trusted-time basis is
defined before offline scheduling ships.

## OD-9 — The server finds a different offer result from the till's (proposed)

**Recommended:**

- Arithmetic errors (line invariant, rounding, a reward line with quantity other than 1) are **400** (a till defect).
- A rule-level mismatch (eligible set, `k`, which units are rewards) is **accepted and flagged** to the sale-review path. The sale happened, so its frozen facts are kept, and Backend-Core never re-prices it silently.

## OD-10 — A return that would need the customer to pay back (proposed)

**Recommended:** if `refund_O < 0` (possible when Y > X or P is high), the return is **refused**
(`promotion_clawback_exceeds_refund`). The till asks the cashier to add the reward units to the return. A return
never charges the customer in V1.

## OD-11 — How a clawback is posted to ERPNext (open, for the Connector slice S8)

| Option | Content |
|---|---|
| A | Reduce the credit-note rate of the returned non-reward units by the clawback. The return line is split to quantity 1 where the clawback does not divide. |
| B | Post the credit note at the original nets, plus a separate non-stock "promotion clawback" line. |

**No recommendation yet.** S8 decides after a lab proof on ERPNext v16. Until then, a partial return that needs a
clawback is refused (`promotion_return_requires_clawback`), which fails closed.

## OD-12 — Permissions and guardrails (proposed)

**Recommended:**

- `offers.manage` and `offers.publish` go to owner and tenant_admin.
- `offers.pause` goes to owner, tenant_admin, and store_manager for their stores.
- All three run through the Policy engine (RT-284).
- Price guardrails (a minimum selling price, a tenant maximum percent, §17) are deferred until the catalog has a price-floor field. V1 is bounded only by `P ≤ 100`.
