# Spec 048 — Offer Engine V1: "Buy X, get Y at P% off the cheapest" with brand / category targeting and exclusions

| | |
|---|---|
| **Jira** | RT-286 (Offer Engine / promotions, Planning, Post-Pilot) |
| **Work Mode** | Planning. This folder is the deliverable. No OpenAPI, migration, runtime, package or CI file is changed |
| **Primary repository** | `Kemetra-Labs/Retail-Tower-Erp`, `services/backend-core/` (the authority). Consumers: `apps/admin-console/`, `apps/pos/`, `integrations/erpnext-connector/` |
| **Baseline** | `origin/main` @ `2beff6d` (2026-11-11) |
| **Decisions honoured** | Confluence RETAIL 23134209 (owner-approved 2026-10-07) §11 and §16–21; Pricing decisions (Confluence RETAIL 23855106) 465, 537, 542, 610, 645 as routed to RT-286 by `docs/planning/rt-282-pricing-backlog-draft.md` |
| **Decision record** | [decision-record.md](decision-record.md): OD-1 to OD-10 and OD-12 permissions approved by the owner on 2026-11-11; OD-11 decided: option A plus Hybrid (2026-11-12); OD-12 guardrail deferral proposed |
| **Status** | DRAFT for owner review |

## 1. Objective

Let a tenant run an automatic promotion of the form **"buy X eligible items, get Y more at P% off, the discount
going to the cheapest items"**. The example that motivated it: *buy one, get the second at 40% off*.

The items that count for the offer are chosen by **product, category or brand**, with **exclusions** (by product,
category or brand) that always win.

V1 is the smallest slice of the approved Offer Engine baseline (§16 "Buy X Get Y", §17 "reward choice such as
cheapest … is configured") that delivers this, and it keeps the seams the rest of the baseline needs.

## 2. What exists on `main` today (re-verified on `2beff6d`)

| # | Fact | Evidence |
|---|---|---|
| F-1 | **No Offer Engine.** There is no promotion, campaign or offer table, contract or runtime. "Promotion" in the code means POS pilot release promotion, which is unrelated. | grep of `services/`, `apps/`; `packages/db/src/schema/` |
| F-2 | The only discount is the **manual per-line discount** (RT-740): optional `CaptureSaleLine.discount` with `kind` percent \| amount, a whole percent 1–100, half-up rounding on the line gross at the currency minor unit (OD-28-3), manager authority. The line's `lineAmount` is its **net**. | `packages/contracts/openapi/pos-sales/sales.yaml` (RT-740 block); `apps/api/src/catalog/sales/sale-line-pricing.ts` |
| F-3 | The manual discount object is validated and hashed but **not stored**. Only the net `lineAmount` is persisted. | `sales.yaml` RT-740 block |
| F-4 | The **ERPNext-Connector posts discounted lines** (RT-857, OD-28-13): `price_list_rate = unitPrice`, a per-unit `discount_amount`, and `rate` = the net per-unit price. A line whose net does not divide exactly by its quantity at the minor unit is refused (`discount_not_divisible`, fail closed). | `integrations/erpnext-connector/.../posting/builder.py:26-35,103-115` |
| F-5 | **Categories exist, and they are flat**: `tenant_product_categories`, and `tenant_products.category_id` (`ON DELETE SET NULL`). | `packages/db/src/schema/catalog/tenant-product-categories.ts`, `tenant-products.ts:59` |
| F-6 | **There is no brand** anywhere in the catalog schema or contracts. | grep `brand` over `packages/db/src/schema/catalog/`, `packages/contracts/openapi/catalog/` |
| F-7 | The POS catalog read-down carries `product_id, sku, name, aliases, price, tax_category, active, row_cursor`. **There is no category and no brand.** | `packages/contracts/openapi/catalog/read-down.yaml:43,400` |
| F-8 | Returns price each returned line from the frozen sale line (`unitPrice × q`, or the net for a discounted line). Pilot returns are online-only, manager/admin, cash-only (RT-271 R-12, RT-114 C5). | `apps/api/src/catalog/sales/sale-returns.service.ts`; `specs/045-return-policy/plan.md` F-1, P-1 |
| F-9 | Measured / catch-weight lines may carry a fractional quantity. Spec 046 routes "quantity offers" (645) to RT-286. | `specs/046-measured-catch-weight-sales/plan.md:90` |
| F-10 | The precedent for a versioned, device-read policy is the cash-variance policy: immutable revisions, pure resolution, ETag/304 device read, attributed audit. | `specs/045-return-policy/plan.md` F-7; `apps/api/src/cash-variance-policy/` |

## 3. V1 scope

### 3.1 In V1

- One offer type: **`buy_x_get_y_percent`** (the reward is a percentage off).
- Reward selection: **cheapest**. It is a field of the offer, with one allowed value in V1 (§17: the reward choice is configured, never implicit).
- Targeting: an **include** set and an **exclude** set, each made of products, categories and brands. Exclusion wins (OD-1).
- **Brand** as a new flat catalog dimension, so offers can target it (prerequisite slice S1).
- Scope: the whole chain (all stores), or a list of stores. Schedule: start and optional end, in store-local time.
- Lifecycle: Draft → Scheduled → Active → Paused → Ended → Archived (§16). Every publish is a new immutable version.
- Automatic application at the till, online and offline from a versioned **Offer Pack** (§19).
- Frozen sale facts per line (§20), and **return clawback** (OD-3).

### 3.2 Not in V1 (deferred, with the seam kept)

Promo or coupon codes; other offer types (fixed amount, fixed price, bundle price, spend X get Y, free gift, quantity
breaks); reward selection other than cheapest; separate trigger and reward pools; stacking between offers or with
manual discounts (OD-5); Best Deal arbitration between overlapping offers (OD-7); customer segments; budgets and caps;
measured or fractional-quantity lines (F-9); hierarchical categories; product tags and CSV/XLSX import (§11:
planned, later); analytics beyond the frozen facts.

## 4. Domain model (conceptual)

Column-level design belongs to the migration slice (S3). This section fixes the concepts.

| Concept | Definition |
|---|---|
| **Brand** | A tenant-owned, flat taxonomy entry (`tenant_product_brands`), shaped like `tenant_product_categories`. A product has at most one brand (`tenant_products.brand_id`, nullable, `ON DELETE SET NULL`). |
| **Offer** | A tenant-owned promotion identity with a lifecycle state. Its rules live in versions. |
| **Offer version** | Immutable once published. It holds the type, parameters (§5.1), eligibility rules (§5.2), store scope, schedule, offline policy and combination policy. Editing a published offer publishes a new version. A version used by a completed sale is never mutated (§16). |
| **Eligibility rules** | `include: {productIds[], categoryIds[], brandIds[]}`, `exclude: {productIds[], categoryIds[], brandIds[]}`. |
| **Eligible set** | The resolved set of product ids for one offer version at one Pack revision: `(products in any include dimension) − (products in any exclude dimension)`. It is materialised by Backend-Core (OD-6), never computed from catalog attributes on the till. |
| **Offer Pack revision** | An immutable, tenant-wide, monotonically numbered snapshot of every offer version that is Scheduled or Active for a store, with its eligible set. Backend-Core publishes a new revision when an offer is published, paused or ended, or when a catalog change moves a product into or out of an eligible set. |
| **Offer application** | The result of evaluating one offer on one cart: which lines take part, and the discount on each reward unit. |
| **Sale line promotion fact** | Persisted per sale line: offer id, offer version, Pack revision, `eligible = true`, and `discountAmount` (0 for an eligible line that is not a reward). |

## 5. Offer definition

### 5.1 Parameters of `buy_x_get_y_percent`

| Field | Rule |
|---|---|
| `buyQuantity` (X) | Integer, at least 1 |
| `getQuantity` (Y) | Integer, at least 1 |
| `percentOff` (P) | Whole percent, 1–100, the same domain as the manual discount (F-2). 100 means free |
| `rewardSelection` | `cheapest` (the only value in V1) |
| `maxApplicationsPerSale` | `null` (unlimited) or an integer, at least 1 |
| `priceBasis` | `resolved_store_price` (the only value in V1): the regular unit price the POS shows, after store override (§16 price basis) |

"Buy one, get the second at 40% off" is `X = 1, Y = 1, P = 40, rewardSelection = cheapest`.

### 5.2 Eligibility

1. `include` must name at least one product, category or brand. A whole-catalog offer is out of V1.
2. A product is eligible if it matches **any** include entry and **no** exclude entry. **Exclusion always wins** (OD-1).
3. A product with no category or no brand never matches a category or brand rule.
4. Retired or inactive products are never eligible.
5. The eligible set is shown in the Console preview before publish (count, plus a sample), per §18 "Draft → Validate → Preview".

Examples:

| Include | Exclude | Product | Eligible? |
|---|---|---|---|
| category Shoes | product "Z runner" | "Z runner" (Shoes) | No: the product exclusion wins |
| brand Nike | category Socks | Nike socks | No: the category exclusion wins |
| brand Nike, category Shoes | — | Adidas shoe | Yes: it matches the category |
| brand Nike | — | product with no brand | No |

## 6. Evaluation algorithm (pure and deterministic)

```
evaluate(cartLines, offerVersion, eligibleSet) -> OfferApplication
```

The same function, with the same golden test vectors (S5), runs on the POS and in Backend-Core. Its inputs are only
the cart and the Pack. It reads no clock, no network and no catalog.

1. **Eligible units.** Expand every cart line whose product is in `eligibleSet` into units of quantity 1. These lines are skipped:
   - lines that carry a manual discount (OD-5: exclusive);
   - lines with a non-whole quantity (F-9).
2. **Order.** Sort the units by unit price, highest first. Break ties by cart line order, then by product id, so the order is total.
3. **Applications.** With `G = X + Y` and `n` eligible units: `k = floor(n / G)`, capped at `maxApplicationsPerSale` when it is set.
4. **Rewards are the cheapest units** (OD-2): the last `k × Y` units in the order take the reward. Every other eligible unit is a non-reward participant.
5. **Discount per reward unit** = `P%` of its unit price, rounded **half up once at the currency minor unit**. This is the same rule as the manual percent discount (OD-28-3).
6. **Line split** (OD-4). Each reward unit becomes its own sale line with quantity 1:
   `lineAmount = unitPrice − discountAmount`. The remaining units of the original line stay on a line with
   `lineAmount = unitPrice × quantity`. With quantity 1, the Connector's divisibility rule (F-4) always holds.
7. **Re-evaluation.** Any material cart change (add, remove, quantity, manual discount, void line) re-runs steps 1–6 from scratch before payment (§16 deterministic recalculation). Earlier splits are undone and recomputed. The cashier never edits a promotion discount by hand.

**Guardrails.** `P ≤ 100`, so a net is never negative. A tenant-wide maximum percent and a minimum selling price
(§17) need a price-floor field the catalog does not have; they are deferred (OD-12).

### 6.1 Worked examples (EGP, minor unit 2, offer `X = 1, Y = 1, P = 40`)

| # | Cart (eligible unit prices) | k | Reward units | Discount | Total |
|---|---|---|---|---|---|
| E1 | 300, 200 | 1 | 200 | 80.00 | 420.00 |
| E2 | 100, 80, 60, 40 | 2 | 60, 40 | 24.00 + 16.00 = 40.00 | 240.00 |
| E3 | 100, 60, 40 | 1 | 40 | 16.00 | 184.00 |
| E4 | product A 150.00 × 2 (one line) | 1 | one A unit | 60.00 | 240.00. The till shows two lines: A × 1 at 150.00, and A × 1 at 90.00 |
| E5 | E2 with `maxApplicationsPerSale = 1` | 1 | 40 | 16.00 | 264.00 |
| E6 | 33.33, 50.00 | 1 | 33.33 | 13.33 (13.332 rounded half up) | 70.00 |
| E7 | 100 (with a manual discount), 60 | 0 | — | 0 | Only one eligible unit, so the offer does not apply |
| E8 | 100, 60, 40 with E2's pool, where 40 is an excluded product | 1 | 60 | 24.00 | 176.00 |

E2 shows the OD-2 rule: the discount goes to the **cheapest units in the whole basket** (60 and 40). It does not go to
"every second unit" in price order, which would discount 80 and 40.

## 7. Offer Pack and offline behaviour (§19)

- **Device read.** The POS fetches the store's current Pack revision through an ETag/304 read, as it already does for policy (F-10). The Pack holds, for each offer version that is Scheduled or Active for the store: id, version, parameters, schedule, offline policy, and the **materialised eligible set** (OD-6).
- **Offline policy per offer** reuses the RT-284 P-F vocabulary: `allow_cached` (V1 default for automatic offers) or `online_only`.
- **Trusted time** (OD-8). The till may not apply a scheduled offer by trusting the workstation wall clock (§19). V1 rule: the Pack carries the server time it was issued at, and the till measures the time since then with a monotonic clock. "Now" = `issuedAt + monotonic elapsed`. After a restart, with no fresh Pack, offers whose window is not fully known are **not** applied. This is fail-safe: the customer pays the regular price, and the cashier sees «العرض غير متاح بدون اتصال».
- **Freshness.** A Pack older than the tenant's freshness window (default 24 h, OD-8) is stale. Stale means no offer is applied offline.
- **Revalidation on sync.** Backend-Core judges an offline sale against the Pack revision the sale cites, not against the current offers. The sale is not invalid just because the offer has since ended (§19).

## 8. Sale capture and frozen facts (§20)

**Contract change (slice S2, gated):** `CaptureSaleLine` gains an optional `promotion` object:

```jsonc
"promotion": {
  "offerId": "0193…",
  "offerVersion": 3,
  "packRevision": 118,
  "discountAmount": "16.00"   // "0.00" on an eligible line that is not a reward
}
```

- Line invariant: `lineAmount = unitPrice × quantity − promotion.discountAmount`. A reward line has `quantity = 1`.
- `promotion` and the manual `discount` are **mutually exclusive** on a line (OD-5). Both present is 400.
- Unlike the manual discount (F-3), the promotion fact **is stored** in a new `sale_line_promotions` table (S3), and it is returned by `readSale` and the sale history. Returns and analytics need it (§20).
- It is part of the payload hash and the `Idempotency-Key` fingerprint, like every other line field.
- **Server check (OD-9).** Backend-Core re-runs §6 with the cited Pack revision:
  - It **rejects** a body that breaks arithmetic (the line invariant, rounding, or quantity 1 on reward lines), with 422 `sale_line_pricing_invalid`, the existing RT-105 and RT-740 refusal for a line whose price does not hold. A malformed object is 400 `validation_error`.
  - It **accepts and flags for review** a sale whose offer result differs from the server's (for example, a wrong eligible set on the till). The sale happened and money was taken, so the fact is kept and the mismatch goes to the sale-review path. It is never silently re-priced. **Runtime (RT-1337):** the server judges each cited `(offerId, offerVersion, packRevision)` against the materialised eligible set of the sale's store at that Pack revision: a cited product outside the set, or a total discount other than the §6 evaluation of the sale's lines, is a mismatch. The flag is an `audit_events` row `sale.offer_review_flagged` (sale, store, offer, recorded and expected discount, reasons) written in the capture transaction. There is no sale-review queue table yet.
- **Receipt.** Under each reward line, print the offer name and the discount, for example «عرض: القطعة التانية بخصم 40% −16.00». Copy is finalised under the UX Constitution in the POS slice.
- **ERPNext.** Nothing new is needed for the sale: a reward line is a discounted line with quantity 1, which RT-857 already posts as a visible discount (F-4). ERPNext stays out of offer authority (§20, 465).

## 9. Returns and clawback (OD-3)

Returns use the **frozen** offer version and frozen unit prices of the original sale. They never use the current
offer catalog (§20).

For a return of some units of a sale that had offer O, counting every earlier return of the same sale:

```
D_held      = Σ discountAmount of the O units not returned before this return
              − Σ clawbacks of O already recorded on earlier returns of the sale
disc_ret    = min( Σ discountAmount of the O units returned now, D_held )
D_remaining = evaluate(the O-eligible units the customer still keeps after this return,
                       O's frozen version and prices).totalDiscount
refund_O    = Σ gross of returned O units − max( disc_ret, D_held − D_remaining )
clawback_O  = max( 0, D_held − D_remaining − disc_ret )
```

On a first return `D_held = D_orig` (Σ discountAmount over the sale's O lines), and the rule reads
`refund_O = min(Σ net of returned O units, Σ gross of returned O units − (D_orig − D_remaining))`.
Subtracting earlier clawbacks from `D_held` stops a second return from clawing back the same discount twice
(RT-1335 review; for example E1: return the 300 → 220.00 with a clawback of 80.00, then the 200 → 200.00, 420.00 in
all, which is what was paid). `returnTotal` = Σ returned `lineAmount` − Σ clawback + Σ give-back (OD-11 Hybrid, below).

- The `max` stops a return from **creating** a discount the customer did not get at sale time.
- If `refund_O < 0`, the return is **refused** with `promotion_clawback_exceeds_refund`. The till asks the cashier to add the reward units to the return. This can only happen when `Y > X` or `P` is high (OD-10).
- Units not under offer O are refunded as today (F-8).
- **Give-back (OD-11 Hybrid, owner decision 2026-11-12).** `giveBack_O = Σ discountAmount of the O units returned now − disc_ret`: the part of an EARLIER clawback that a returned reward unit gives back. It is 0 unless an earlier return recorded a clawback of O. Then `refund_O = net returned + giveBack_O − clawback_O` (the identity holds in every case). S3 step 2: the reward unit (net 120.00) refunds 200.00 = 120.00 + a give-back of 80.00, so the customer gets exactly what was paid.
- **Allocation to lines.** The ledger needs both per returned line, in whole minor units. The clawback of O goes to the returned O lines that are not rewards, in proportion to their `lineAmount`, and only when those cannot hold it to the returned reward lines of O (a clawback the returned lines cannot hold is refused, `promotion_clawback_exceeds_refund`). The give-back of O goes to the returned reward lines of O in proportion to the discount of the units returned now. `taxAmount` on the feed line is not adjusted by either. Largest remainder first, ties by sale line order; no line takes more than its `lineAmount` (clawback) or that discount (give-back). The rule is written in `pos-sales/sales.yaml` `recordReturn` and implemented once in `offers/evaluator/offer-return-allocation.ts`.

Using E3 (100, 60, 40, with the 40 discounted 16.00 and 184.00 paid):

| Return | D_remaining | refund | Customer keeps / paid |
|---|---|---|---|
| the 40 (reward) | 24 (the 60 would be the reward now) | min(24, 40 − (16 − 24) = 48) = **24.00** | 100 + 60 for 160.00, the regular price |
| the 100 (trigger) | 16 (60 + 40 still qualify) | min(100, 100 − 0) = **100.00** | 60 + 40 for 84.00, still under the offer |
| E1, return the 300 | 0 | min(300, 300 − 80) = **220.00** | the 200 item for 200.00, the regular price |

**Where it changes code.** The return contract gains a per-offer clawback amount. Backend-Core `recordReturn`
computes it, which is the authority, and the POS quote shows it. The posting feed
(`erpnext-connector/posting-feed.yaml` 1.13.0-draft) carries the per-line split on `ReturnLine`:
`promotionClawbackAmount` and `promotionGiveBackAmount`, both optional and omitted when 0. `refundTenders` sum to
Σ `lineAmount` − Σ `promotionClawbackAmount` + Σ `promotionGiveBackAmount`. OD-11 decides how they appear in ERPNext:
option A, a reduced credit-note rate on the returned units, plus the Hybrid give-back, a non-stock "promotion
give-back" row of quantity −1 next to the reward unit at its net (RT-1340 bench proof). It fails closed. The shares
are derived from stored rows (the per-offer clawback rows and the return and sale lines), so no column holds them.

**Runtime (RT-1337, S4, as validated).** Backend-Core fails closed. A return is refused with 422
`promotion_return_requires_clawback`, and nothing is recorded, when (a) an offer's clawback is above 0, (b) it carries
a **give-back** (golden sequence S3, step 2, where the refund 200.00 exceeds the returned line's net 120.00), or (c) it
includes a **reward** line (`discountAmount` above 0). A return whose `refund_O` would be below 0 is refused first
(`promotion_clawback_exceeds_refund`, OD-10; the "add the reward units" remedy only works after reward-line returns
are allowed). The reason is the ledger: the Connector has no option A or give-back yet (RT-1340), so such a return
would be rejected at ERPNext for good; the Connector's return builder also needs `unitPrice` × `quantity` =
`lineAmount`, which a reward line does not satisfy. The feed contract is now in place; the refusals lift after the
Connector supports both feed fields and applies the discount to a returned unit as it does to a sale (S8). Until then
`promotionClawbacks` is never present; `sale_return_promotion_clawbacks` and the net-of-clawback refund rule stay in
place for that lift. A return of a non-reward promoted line that changes no discount is an ordinary return. The single
returns and the multi-return sequences are golden vectors in `packages/contracts/fixtures/offers/golden-vectors.json`
(`returns`, `returnSequences`, with `giveBack` and the per-line `feedLines`); the pure settlement and allocation specs
run all of them, the integration specs run the first step of each against the refusals.

## 10. Administration (Admin Console, control surface only)

- **Offers list** with state, schedule, scope, and the current version.
- **Editor** with: name (Arabic and optional English), X / Y / P, max applications, include and exclude pickers for products, categories and brands, stores, schedule and offline policy.
- **Validate → Preview → Publish / Schedule.** The preview shows the eligible-set count and a sample, overlaps with other offers (OD-7 refuses them), and a simulation box: "cart of these prices → result" (§18).
- **Pause** (emergency, with a required reason and audit), **End**, **Archive**. Pausing never deletes history (§21).
- **Brands.** A list and an editor next to categories, plus a brand field on the product form (S1).
- **Permissions (OD-12).** `offers.manage` and `offers.publish` go to owner and tenant_admin; `offers.pause` also goes to store_manager for their own stores only, with a required reason and audit; resuming a paused offer needs `offers.publish`. These are evaluated through the Policy engine (RT-284), not a separate authority model (§21).

## 11. Delivery slices (follow-ups to create after owner approval)

| Slice | Repo area | Mode | Gate | Depends on |
|---|---|---|---|---|
| **S1** Brand in the catalog: table, `brand_id`, Console CRUD and product field, read and filter | backend-core, admin-console | Impl | **[GATED: contract, migration]** | — |
| **S2** Offer contracts: Console offer CRUD and lifecycle; device Pack read; `CaptureSaleLine.promotion`; return clawback fields and refusal codes | backend-core contracts | Impl | **[GATED: contract]** | this spec approved |
| **S3** Offer schema: offers, versions, eligibility rules, materialised eligible sets, Pack revisions, `sale_line_promotions` | backend-core db | Impl | **[GATED: migration]** | S1, S2 |
| **S4** Backend-Core runtime: authoring and lifecycle, materialisation on publish and on catalog change, Pack read, capture validation and review flag, return clawback | backend-core api | Impl | — | S3 |
| **S5** Golden test vectors for §6 and §9 (the E and R tables, plus edge cases), consumed by the Backend-Core and POS evaluators | contracts fixtures | Impl | per MR rules | S2 |
| **S6** Admin Console: brands, offers editor, preview and simulation, lifecycle | admin-console | Impl | — | S1, S4 |
| **S7** POS: Pack sync and trusted time, evaluator, line split, receipt, capture, return quote | pos | Impl | — | S4, S5 |
| **S8** Connector: return credit note with clawback (OD-11); regression test that reward lines post | erpnext-connector | Impl | — | S2 |
| **S9** Cross-repo verification in the lab: E1–E8 and R-cases end to end to ERPNext | all | Verification | — | S4, S6, S7, S8 |

## 12. Acceptance criteria for this Planning item

1. The owner has accepted the OD-12 guardrail deferral, and OD-11 is decided in slice S8. OD-1 to OD-10 and the OD-12 permissions are approved (2026-11-11) and recorded on RT-286.
2. Each slice in §11 exists as an RT issue that passes OS §4A, with no duplicate of an existing issue.
3. The durable decisions are reflected on the Confluence promotions page (23134209), or on a child page linked from RT-286.
