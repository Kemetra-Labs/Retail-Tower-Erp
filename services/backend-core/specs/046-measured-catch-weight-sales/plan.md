# Plan 046 — Measured / catch-weight sales: cross-module plan (Pricing Gate 5)

| | |
|---|---|
| **Jira** | RT-488 (RT-282 PR-G5, Pricing Planning Gate 5). Builds on RT-483 / spec 041 (Done) |
| **Work Mode** | Planning. This file is the deliverable. No code, OpenAPI, migration, package or CI change |
| **Scope** | Backend-Core (primary), POS and ERPNext-Connector. Cross-product planning authorized by the owner on 2026-11-06 (CLAUDE.md §8) |
| **Baseline** | Monorepo `Kemetra-Labs/Retail-Tower-Erp` `origin/main` @ `19f8cca` (2026-11-06). The issue's `Kemetra/Backend-Core` @ `ddae78a7` is stale: the products moved into this monorepo at the RT-715 cutover |
| **Decisions honoured** | Confluence RETAIL 23855106: 641–648 (Q, measured pricing), 612–617 (N, returns), 563–572 (J, rounding ownership), 590–601 (L, Fiscal), 649–664 and 675–687 (R/T, ERPNext boundary and verification), 475–479 (Sell Unit, exact money) |
| **Status** | **DRAFT — not ratified.** Every owner decision is listed as an open question in §9 (Q-1 to Q-14). A recommendation is given where one is useful, but none is selected. Fractional quantities stay rejected on every surface until the owner ratifies this plan |

> Naming note: spec 045 (RT-272) uses "G5" for the *Return Policy* gate of Sales & Returns. This plan is **Pricing**
> Gate 5 (RT-282 §2). They are different gates.

## 1. Objective

Make measured selling (rate per measurement unit, e.g. loose produce at 299.00 EGP/kg) and catch-weight selling
(a discrete item whose price follows its actual weight) **executable across modules**, without breaking the money
rules that hold today:

1. **Units:** canonical rate UOM and display comparison unit (641–644).
2. **Precision and rounding:** fractional quantity precision; the line-amount rounding rule and who owns it
   (Pricing vs Fiscal vs Payment, 566–570, 600).
3. **Line-pricing invariant:** the change RT-105 needs to accept non-integer quantities.
4. **Returns:** returns of measured lines from the original sale facts (612–617, RT-14 / RT-87).
5. **POS input:** scale input and barcode-embedded weight.
6. **Connector:** UOM mapping, and the tolerance policy of the RT-378 representation check for fractional lines.
7. **Contract changes:** exact changes per product, in contract-first order, and the bounded follow-up issues (§8).

## 2. What exists today (verified on `19f8cca`)

### 2.1 Backend-Core (`services/backend-core/`)

| # | Fact | Evidence |
|---|---|---|
| B1 | `CaptureSaleLine.quantity` is already an exact-decimal **string** with up to 6 fractional digits (`numeric(19,6)`). `unit` is free text (1–50 chars). | `packages/contracts/openapi/pos-sales/sales.yaml:2305-2320` |
| B2 | The RT-105 invariant: `unitPrice` and `lineAmount` fit the currency's ISO-4217 minor unit; `lineAmount = unitPrice × quantity` **exactly**; and `quantity` is whole ("fractional quantities, such as weighed goods, are not accepted yet"). Else 422 `sale_line_pricing_invalid`. | `sales.yaml:2273-2282` |
| B3 | Enforcement: `conforms()` rejects `!isWhole(quantity)` before the exact product check. Scaled bigint, no floats. | `apps/api/src/catalog/sales/sale-line-pricing.ts:43-91`; called at `sales.service.ts:1102` |
| B4 | RT-740 manual discount: `lineAmount = unitPrice × quantity − discount.amount`; a percent discount rounds **half up** to the minor unit once per line, on the line gross. | `sales.yaml:2284-2289,2361-2366`; `sale-line-pricing.ts:62-74` |
| B5 | Storage already allows fractions: `sale_lines.quantity NUMERIC(19,6)`, `unit TEXT`, money `NUMERIC(19,4)`. Only the service rule (B3) blocks them. | `packages/db/drizzle/0012_sales.sql:156-172`; `packages/db/src/schema/sales/sale-lines.ts:15,52-58` |
| B6 | Returns: pro-rata by cumulative difference `round4(A×(c+q)/Q) − round4(A×c/Q)`. A line sold whole accepts only whole returns; a line sold fractionally "still accepts fractional returns". `round4` results can fall below the minor unit (0.01 × 0.333333 → 0.0033), which ERPNext cannot post (RT-87). | `sales.yaml:1062-1083`; `apps/api/src/catalog/sales/sale-returns.service.ts:274-308` |
| B7 | No Sell Unit / UOM in the catalog. `tenant_products` has no unit or weighed attribute; read-down `SellableCatalogRow` has no unit field. Spec 041 keeps `price_events.sell_unit` defaulted to `each` (OD-2) until RT-281 models Sell Units. | `packages/db/src/schema/catalog/tenant-products.ts:57-81`; `packages/contracts/openapi/catalog/read-down.yaml:396-439`; spec 041 `data-model.md:96`, `decision-record.md:28-37` |
| B8 | `product_aliases.identifier_type` allows `barcode` and `plu`. Nothing parses embedded-weight or embedded-price barcodes. | `packages/db/drizzle/0007_catalog.sql:277-278` |
| B9 | Inventory: stock movement quantity is `numeric(19,4)`. Inventory Effects **skip** (never round) a sale line with more than 4 significant decimals (`quantity_precision`) or a unit different from the product's established unit (`unit_mismatch`). | `packages/db/src/helpers/inventory-effects/effect-lines.ts:47-61`; `packages/db/src/schema/inventory/stock-movements.ts:17-18` |
| B10 | Posting feed to the Connector: `SaleLine.quantity` same 6-digit pattern; `unit` passed through verbatim. | `packages/contracts/openapi/erpnext-connector/posting-feed.yaml:965-1015,765-790` |
| B11 | No shared rounding helper and no global rounding mode. Half-up (discount), Postgres `round` (returns), truncation (credit reversal) and half-even (console analytics) are each fixed locally. | `sale-line-pricing.ts:67-74`; `sale-returns.service.ts:292`; `credit-sale-reversal.checks.ts:202`; `console-sales-by-store.projections.ts:118-131` |
| B12 | Spec 008's rationale for scale-4 money already names weighed goods. | `specs/008-sales-transaction-capture/research.md:12` |

### 2.2 POS (`apps/pos/`)

| # | Fact | Evidence |
|---|---|---|
| P1 | Cart quantity is `INTEGER CHECK (quantity > 0)`; money is INTEGER minor units; `line_subtotal_minor = quantity × unit_price_minor`, never rounded. | `migrations/0010_cart_lines.sql:14-16,30-35`; `src/main/cart/line-subtotal.ts:10-42` |
| P2 | Cart bridge refuses non-integer quantities; scan always adds 1; the UI is a +/- stepper with no numeric entry. | `src/main/cart/cart-bridge.ts:609-630,798-800`; `src/renderer/sale/useDirectSaleAdd.ts:131`; `src/renderer/v5/sale/LiveCartParts.tsx:204-252` |
| P3 | `products` has `price_minor INTEGER` and no unit/weighed column (`unit_pack_label` is display only). Barcode lookup is an exact match on `barcode_norm`. | `migrations/0029_create_products.sql:36-38`; `src/main/catalogue/product-repo.ts:144-159` |
| P4 | No scale, serial-port or COM integration exists; no EAN-13 prefix-2x parsing. | grep of `apps/pos/src`, `apps/pos/package.json`; `specs/008-sale-finalization-and-receipts/coordination.md:268` |
| P5 | Sale sync throws on a non-integer quantity and sends a hard-coded `unit: 'unit'` ("OWNER-CONFIRM"). Local `sales.lines_json` reader requires safe integers. | `src/main/sales-sync/create-sale-sync-client.ts:120-128,352-377`; `src/main/sales/sale-lines.ts:35-48` |
| P6 | Returns are whole-only (`return_journal_lines.quantity INTEGER CHECK >= 1`, `parseWholeQuantity`); pro-rata math mirrors B6 in bigint ten-thousandths. | `migrations/0039_create_return_journal.sql:121`; `src/main/returns/returns-money.ts:4-82` |
| P7 | Receipts print `${quantity}× name` with no unit or weight. | `src/main/receipts/template-engine.ts:202-207`; `src/main/returns/returns-slip.ts:139` |
| P8 | Backend-Core contracts are pinned by blob SHA (`contracts/backend-core/PIN`, `npm run contracts:repin`); response validation tolerates extra fields. | `apps/pos/contracts/backend-core/PIN`; spec 043 design §2.2 P6 |

### 2.3 ERPNext-Connector (`integrations/erpnext-connector/`)

| # | Fact | Evidence |
|---|---|---|
| C1 | Posts a Sales Invoice with `update_stock=1`, `disable_rounded_total=1`, `ignore_pricing_rule=1`; each item sends `qty`, `uom = uom_for(unit)`, `rate = price_list_rate = unitPrice`, `amount = lineAmount`. No `conversion_factor` is sent. | `retail_tower_erpnext_connector/connector/posting/builder.py:210-256` |
| C2 | Wire quantity regex already accepts 6 fractional digits ("weighed goods, e.g. 1.234567 kg"). | `posting/uom.py:27-32` |
| C3 | UOM map: exact, case-sensitive `dp2_unit → erpnext_uom` rows from Connector Settings; a miss fails closed (`UnmappedUnit`). Decision Option A, signed 2026-06-04. `Nos` appears only in test harnesses (`{"each": "Nos"}`). | `posting/uom.py:36-51`; `docs/decisions/mapping-uom.md:28-44` |
| C4 | Nothing reads the ERPNext UOM flag `must_be_whole_number`, the `qty` field precision or System Settings float precision. The compatibility profile only checks currency precision of `rate` against the ISO minor unit. | `posting/compatibility_glue.py:48-49,142-149,183`; `posting/compatibility_profile.py:192-204` |
| C5 | RT-378 representation check: item, qty, uom, rate, amount, warehouse compared **exactly** (`Decimal`, zero tolerance); `grand_total` = Σ line amounts. Mismatch before submit → rollback, `permanently_rejected/validation`; after submit → `reconciliation_required`. | `posting/representation_check.py:9-13,32-34,208-210,245-251`; `frappe_glue.py:656,852,1015` |
| C6 | Discounted lines and return lines require `rate × qty == amount` exactly (the builder notes ERPNext recomputes `amount = flt(rate × qty, precision)`). | `posting/builder.py:26-34,102-150`; `posting/return_builder.py:23-27,154-156` |
| C7 | RT-380 recorded the rounding gate as "N/A by contract" because only whole quantities can reach the Connector. | `docs/planning/rt-282-pricing-backlog-draft.md:58` (RT-380 comment 11590) |

### 2.4 The incompatibility in one line

At 299.00 EGP/kg, 0.735 kg is 219.765 EGP. That amount is **not representable** in EGP (2 minor digits), so
`lineAmount = unitPrice × quantity` *exactly* (B2) cannot hold, ERPNext would store its own rounded `amount` (C6), the
RT-378 check would fail closed (C5), the POS cannot hold the quantity at all (P1), and returns would price to sub-minor
amounts (B6). Every module needs a coordinated change; no single one can fix it alone (648).

## 3. Units (641–644)

| Concept | Plan |
|---|---|
| **Measured Sell Unit** | A Sell Unit (RT-281, OD-2 seam) gains a `measure` kind: `count` (today's `each`) or `measured`. A measured Sell Unit names a **canonical rate UOM** from a closed list (`kg`, `l`, `m` proposed; Q-2) and a **quantity precision** (Q-3). |
| **Canonical rate UOM** (642) | The price stored in Pricing (`price_events.price`, `sell_unit = <measured unit>`) is the rate **per canonical UOM**, minor-unit representable like every price (479). Example: 299.00 per `kg`. |
| **Display comparison unit** (643–644) | A display-only unit and factor (e.g. `100 g`, factor 0.1). Authoring may accept 29.90/100 g; it normalizes to 299.00/kg at authoring time, exactly (×10). The reverse (299.95/kg → 29.995/100 g) is **display rounding only** and never feeds calculation. Shelf labels and receipts may show both. |
| **Catch-weight** | Recommended to use the same line shape as measured selling: the line is in the canonical rate UOM with the actual weight as quantity. Whether catch-weight items keep a separate count (pieces) on the line is Q-1. |
| **Count Sell Units** (646) | A Case or other count unit keeps a normal Pricing entry and whole quantities. Not part of this gate. |
| **Quantity offers** (645) | "3 for 100" belongs to the Offer Engine (RT-286). Not part of this gate. |

## 4. Precision and rounding

### 4.1 Quantity precision

- Wire and storage already carry 6 fractional digits (B1, B5, B10, C2). The plan **does not** change that bound.
- A measured Sell Unit declares a precision `p`; a line with more fractional digits than `p` is invalid. The cap on
  `p` is the owner's choice (Q-3: 3, per-UOM, or up to the wire bound of 6). Recommended `p = 3` because:
  - Inventory Effects accept at most 4 decimals (B9), so `p ≤ 4` keeps measured sales flowing into stock. If the owner
    picks `p > 4`, Inventory Effects would **skip** those lines (`quantity_precision`, never rounded), so that choice
    also needs an Inventory change in G5-BC-2: stock movement/position quantity scale raised to `p` (a migration), or an
    explicit owner rule for rounding stock quantity, which today's "skipped, never rounded" policy forbids;
  - the ERPNext `qty` field precision must be ≥ `p` (§7.2), and a site default is commonly 3 — **needs verification on rt9**;
  - scales and EAN-13 weight barcodes commonly resolve to 1 g (5 digits = up to 99.999 kg).
- Precision alone does not guarantee an Inventory Effect: a product whose established store unit (B9) is not the
  measured UOM (e.g. stock moved so far in `unit` or `Kg`) would have every measured sale skipped as `unit_mismatch`.
  Making a product measured therefore needs a **per-product, per-store readiness step** in G5-BC-1: report products
  whose established unit differs from the canonical UOM, and block switching them to measured (Q-14). The established
  unit is read from the product's existing stock movements in that store, and the ledger is append-only
  (`packages/db/src/helpers/inventory-effects/sale-effects.ts:149-203`), so an ordinary stock adjustment **cannot**
  change it. Re-baselining would need its own inventory design (an explicit, audited established-unit record or unit
  epoch per store and product that Inventory Effects read instead of the latest movement). Unless that design is
  ratified and built, the switch is refused. The ERPNext `stock_uom` check (§7.1) does not cover this Backend-Core state.
- The same readiness step also blocks **tracked products** (`tracking_mode` other than `none`): Inventory Effects skip
  them as `tracked_product` (B9), so their measured sales would produce no Inventory Effect. Selling tracked
  (batch/expiry) products by weight is out of this plan's scope until tracked selling produces Inventory Effects.
- Quantity is always an exact-decimal string in Backend-Core and the Connector; the POS holds it as an integer count of
  10^-p canonical units (with `p = 3` and `kg`, grams: `735` for 0.735 kg). Never a float.

### 4.2 The line-amount rounding rule (ownership)

| Amount | Owner | Rule |
|---|---|---|
| Extended line amount `round_m(unitPrice × quantity)` of a measured line | **Pricing** — it is the commercial price of the line (590). Reading 566–567 (no silent re-rounding of an approved price) as compatible with this rule is part of ratification: the rate is never re-rounded, only its extension by a weight that did not exist at authoring time | Rounded **once per line** to the currency's ISO minor unit, with one tenant-wide mode (Q-4). Recommended: half-up, as RT-740 percent discount already does (B4) |
| Tax on the line | **Fiscal** (569, 600; RT-294) | Unchanged. Fiscal derives from the rounded commercial line amount like any other line |
| Cash-tender rounding of the sale total | **Payment / Tender** (570) | Unchanged |
| Manual discount on a measured line | **Pricing** (RT-740 rule) | Gross = the rounded extended amount; the percent rule then applies unchanged. **Not postable as-is**, see §7.3: recommended refused at capture in the first slice (Q-13) |

- The rounding is computed by **the POS at scan** and frozen on the cart line (602); Backend-Core **re-verifies** it
  exactly at capture (it does not recompute and replace). Fiscal and Payment rules are unaffected.
- One shared exact-decimal helper (`roundToMinor(value, exponent, mode)`) should exist in Backend-Core and be mirrored
  in the POS; today each site hard-codes its own mode (B11). That helper is part of the first BC implementation slice,
  not a refactor of existing sites.
- The ERP site must round the same way, or the representation check fails closed (§7.2, Q-9).

## 5. The RT-105 invariant change (capture)

Additive and opt-in per line. A line **without** the new marker keeps today's rule bit for bit (count lines, ad-hoc
lines).

**Old POS builds must not sell a measured product as a count item.** A terminal that ignores the new read-down fields
(P8) would add one unit at the per-kg rate and send no `measure`, which the unchanged count rule would accept. Two
guards, both required:

1. **Distribution:** read-down includes a measured product only for a terminal that declares the
   `measured_sales` capability (a device/build capability reported at pairing or on the read-down request; exact
   mechanism in K1). Other terminals never receive it, so it is not scannable there, online or offline.
2. **Capture:** a line with `tenantProductRef` whose product's Sell Unit is measured (at the line's sale time) and that
   carries no `measure` is refused (422, typed reason). Together with rule 5 below, this catalog cross-check is mandatory
   whatever Q-5 decides, because it is the only server-side guard for a terminal that held a stale catalogue offline.

Proposed `CaptureSaleLine` additions (names indicative; the contract PR decides spelling):

```yaml
measure:                 # optional; absent = count line (today's rule)
  type: object
  required: [kind, uom, precision, source]
  properties:
    kind:      { enum: [measured] }            # catch_weight too if Q-1 says so
    uom:       { type: string }                # canonical rate UOM code, equals `unit`
    precision: { type: integer, minimum: 0, maximum: 3 }   # maximum = the Q-3 cap (3 recommended, ≤ 6)
    source:    { enum: [scale, barcode_weight, barcode_price, manual] }   # subset per Q-6/Q-7
```

New invariant for a line with `measure` (422 `sale_line_pricing_invalid` otherwise):

1. `unitPrice` and `lineAmount` fit the currency minor unit (unchanged).
2. `quantity > 0` and has at most `measure.precision` significant fractional digits.
3. `unit == measure.uom` and is one of the canonical UOM codes.
4. `lineAmount = round_m(unitPrice × quantity)` exactly, under the ratified mode; with `discount`,
   `lineAmount = round_m(unitPrice × quantity) − discount.amount` and the RT-740 rule applies to that gross.
5. **Product-linked measured lines are bound to the catalog UOM (mandatory):** a line with `tenantProductRef` and
   `measure` is refused unless the product's Sell Unit at the line's sale time is measured and `measure.uom` equals its
   canonical UOM. Self-consistency alone would let a terminal send `l` for a `kg` product, which passes rule 3 but is
   then skipped by Inventory Effects as `unit_mismatch`. This check covers stale offline submissions, because it is
   evaluated against the catalog in force at the line's sale time. Ad-hoc lines (no `tenantProductRef`, FR-004) keep
   the self-consistency rules 1–4 only. Q-5 now asks only what else capture checks and freezes.

Storage: no migration is needed for quantity or unit (B5). Freezing `measure.kind`/`source` on `sale_lines` needs an
additive column set (Q-5 decides how much is frozen); that migration belongs to the BC implementation slice, gated by
this plan's ratification.

## 6. Returns of measured lines (612–617, RT-14 / RT-87)

The original sale facts are the only basis (612–616), and ERP return posting must preserve them (617). Today's
cumulative `round4` rule (B6) produces sub-minor amounts for fractional quantities, which ERPNext cannot post (RT-87),
and the Connector requires `rate × qty == amount` on return lines (C6), which a rounded measured line never meets.

| Option | Content | Effect |
|---|---|---|
| **R-A (recommended)** | A measured line is returned **whole only**: `quantity = Q`, `lineAmount = A` (the original amounts, exactly). A partial weight return is refused with a typed reason. | Exact by construction; ERP credit note mirrors the original row; no new rounding rule. A customer with half a melon gets a manager-approved line-level adjustment instead (Return Policy, spec 045) |
| R-B | Partial returns re-weighed: cumulative difference rounded to the **minor unit**, `round_m(A×(c+q)/Q) − round_m(A×c/Q)`, so all returns sum to `A` exactly. | Needs the Connector return check (C6) to accept `amount ≠ rate × qty` for measured lines, which ERPNext itself recomputes (`flt(rate × qty)`), so the credit note would need an explicit per-row rate. Larger Connector and ERP-compatibility work |
| R-C | Partial returns at `round_m(unitPrice × q)` with the last return taking the remainder. | Same ERP representation problem as R-B on the final return |

Q-8 decides. Whatever is chosen replaces the existing "fractional sale accepts fractional returns" sentence in
`sales.yaml:1079-1080` for lines with `measure`; lines captured before this change are unaffected.

## 7. Connector (UOM, compatibility, representation tolerance)

### 7.1 UOM mapping

- Keep the signed Option A (C3): the Connector maps the canonical UOM code (`kg`, …) to an ERPNext UOM (`Kg`, …) by
  configured rows; unmapped fails closed.
- **ERP master data:** a measured Item must have `stock_uom` equal to the mapped sale UOM (the Connector sends no
  `conversion_factor`, C1), and that UOM must have `must_be_whole_number = 0`. Selling a measured item through an Item
  whose stock UOM is `Nos` is out of scope (it would need a conversion factor and a valuation decision owned by ERPNext).
- Side finding, out of scope here: the POS sends `unit: 'unit'` (P5) while the harnesses map `each` (C3). Production is
  whatever the operator configures. Recommended to settle in the POS Sell-Unit slice (G5-POS-1), not here.

### 7.2 Compatibility profile additions (preflight, 665–674)

| Check | Severity if failed |
|---|---|
| Every mapped measured UOM exists, is enabled and has `must_be_whole_number = 0` | critical (posting of measured lines paused) |
| Sales Invoice Item `qty` precision (and `stock_qty`) ≥ the largest declared `precision` | critical |
| The site's numeric rounding method gives the same result as the ratified `round_m` mode for `amount = rate × qty` | critical (Q-9) |
| Optional per-Item check at posting: `Item.stock_uom == mapped uom` | line `validation` (fails closed) |

The Frappe field names for rounding method and float precision **need verification on rt9** before the contract is
written; this plan does not assume them.

### 7.3 Representation-check tolerance policy (RT-378)

- **Recommended: tolerance stays zero** (683, 687). The plan makes exact representation possible instead of tolerating
  drift: quantity is sent at ≤ `p` digits that the site can store (§7.2), and the amount Backend-Core sends is the
  amount ERPNext will compute under the same rounding (§4.2, Q-9).
- For an **undiscounted** measured line the builder rule (`rate × qty == amount`, C6) becomes `round_m(rate × qty) ==
  amount`, using the same helper semantics; a mismatch still fails closed before submit.
- A **discounted** measured line has no postable form under today's builder, which posts a minor-unit *net rate*:
  3.001 kg at 1.00/kg less 0.01 is 2.99, but `round_m(3.001 × 0.99) = 2.97` and `round_m(3.001 × 1.00) = 3.00`; no
  two-decimal rate gives 2.99. Changing the equality alone would not fix it. Options (Q-13): **(a, recommended)**
  refuse manual discounts on measured lines at capture (and in the POS) in the first slice, fail closed; (b) post the
  gross rate with a separate discount representation that ERPNext keeps exactly — needs its own rt9 proof before
  acceptance. Until Q-13 is decided and proven, an unrepresentable measured line is refused before capture, never
  posted approximately.
- Any non-zero tolerance (e.g. ±1 minor unit on `amount`) would make "posted ≠ sold" a success path and conflicts with
  617 and 683. It is listed as Q-10 only so the owner can reject it explicitly.
- RT-380's "rounding gate N/A by contract" (C7) becomes applicable once G5-CNR-1 lands; its re-verification on rt9 is
  part of G5-V1.

## 8. POS input (scale, barcode-embedded weight)

| Input | Plan |
|---|---|
| **Scale** | A serial/USB retail scale returns a stable net weight (tare handled by the scale). The POS takes the weight only when the scale reports *stable*, in the canonical UOM, cut to `p` digits (direction part of Q-6; recommended down, never in the store's favour). Needs a hardware choice and a new native dependency (serial access), which is an owner decision (Q-6) and a package change in its own slice. Legal-for-trade certification of the scale is a pilot-store question, not code |
| **Barcode-embedded weight** | EAN-13 in-store prefix range (20–29) with a configurable layout per tenant: prefix, item-code digits (looked up as a `plu`/`barcode` alias, B8), weight digits and decimals, check digit(s). Quantity = embedded weight; price comes from the POS's applied pricing as for any scan. Which layouts are supported is Q-7 |
| **Barcode-embedded price** | The label carries the amount, not the weight. Deriving `quantity = price / rate` is generally not exact and breaks §5 rule 4. Recommended: **not supported** in the first slice, or supported only with a weight digit field too (Q-7) |
| **Manual keyed weight** | A fraud vector. Recommended: allowed only behind a manager approval (RT-114 action kind) or disabled by default (Q-6) |
| **Cart and storage** | New quantity representation on cart lines and `sales.lines_json`: integer count of 10^-p units plus the UOM; count lines unchanged. Line total = `round_m(price_minor × qty_scaled / 10^p)` with the ratified mode, frozen at scan (602–603). A measured line is one line per weighing (no merge on re-scan) |
| **Receipt** | Print weight with unit and the rate: `0.735 kg × 299.00/kg   219.77`. Display comparison unit optional |
| **Returns** | Per Q-8; with R-A the return flow offers a measured line only as a whole |
| **Offline** | Unchanged: measured prices come through the same pricing projection as every price (spec 043); no new offline rule |

## 9. Owner decisions needed for ratification (open questions)

None of these is decided by this plan.

| ID | Question | Options | Recommendation (not selected) |
|---|---|---|---|
| **Q-1** | Is catch-weight modelled exactly like measured selling (line in kg, actual weight as quantity), or does a catch-weight line also carry a piece count? | A: same shape; B: add `pieces` | A for the first slice; B later if stock is counted in pieces |
| **Q-2** | Which canonical rate UOMs are allowed? | `kg` only; `kg`,`l`,`m`; open list | `kg` only for the pilot store's needs, list extensible |
| **Q-3** | Quantity precision for measured lines | `p = 3`; per-UOM `p`; up to 6 | `p = 3` (fits Inventory Effects and common ERP precision) |
| **Q-4** | Rounding mode of `round_m(unitPrice × quantity)` | half-up; half-even; truncate | Half-up (matches RT-740) — but must equal the ERP site's method (Q-9) |
| **Q-5** | Beyond the mandatory measured-flag and UOM binding (§5 rules 2 and 5), does capture check more against the catalog (e.g. precision, display unit), and what is frozen on `sale_lines`? | A: no further checks, freeze `measure.kind`+`source`; B: also check precision against the Sell Unit, freeze `precision` too | B: precision is cheap to check and is needed to replay returns |
| **Q-6** | Scale integration and manual weight entry | Scale in the pilot or barcode-only first; manual entry allowed / approval-gated / disabled | Barcode-weight first; scale as a separate slice once hardware is chosen; manual entry approval-gated |
| **Q-7** | Supported embedded-barcode layouts | Weight-embedded only; plus price-embedded | Weight-embedded only, layouts configured per tenant |
| **Q-8** | Returns of measured lines | R-A whole only; R-B pro-rata minor-unit; R-C remainder | R-A |
| **Q-9** | Who aligns rounding between Retail Tower and ERPNext? | A: preflight requires the site method to match (critical if not); B: Connector sends rounding-neutral data | A, without changing global ERP settings blindly (668–669) |
| **Q-10** | Representation tolerance for measured lines | Zero; ±1 minor unit on amount | Zero (683, 687) |
| **Q-11** | Release horizon: is G5 a V1 Pilot need or Post-Pilot? RT-488 is `Post-Pilot`; spec 041 OD-1 lists measured pricing as "Later". | Post-Pilot; pilot | Post-Pilot unless a pilot store sells loose goods |
| **Q-12** | Sell Unit ownership: does RT-281's Sell Unit model carry `measure`/`uom`/`precision`, or does Pricing own them? | Catalog (RT-281); Pricing | Catalog (OD-2 already sends Sell Units to RT-281) |
| **Q-13** | Manual discounts on measured lines (§7.3) | (a) refused in the first slice; (b) separate exact discount representation, rt9-proven first | (a) |
| **Q-14** | Products whose established inventory unit differs from the measured UOM (§4.1) | Refuse the switch; design an audited established-unit record (unit epoch) that Inventory Effects read, then re-baseline | Refuse. A unit-epoch design is a separate Inventory planning item if ever needed |

## 10. Contract changes, in contract-first order

Each step is a separate PR; no consumer implementation starts before the contract it consumes is merged (CLAUDE.md §9).

| # | Product | Contract change | Additive? |
|---|---|---|---|
| K1 | Backend-Core | Catalog: measured Sell Unit (`measure`, canonical `uom`, `precision`, display comparison unit) on the product master and as optional fields on read-down `SellableCatalogRow`; the `measured_sales` terminal capability and the rule that read-down omits measured products for terminals without it. Barcode-layout configuration resource if Q-7 needs tenant layouts | Yes (POS tolerates extra fields, P8) |
| K2 | Backend-Core | Pricing (spec 041 amendment): `price_events.sell_unit` accepts a measured Sell Unit; the price is the rate per canonical UOM; authoring normalization from the display unit | Yes (OD-2 seam) |
| K3 | Backend-Core | `pos-sales/sales.yaml`: optional `CaptureSaleLine.measure`; the measured invariant (§5); the measured-line return rule (§6); new typed refusal reasons | Yes for capture; return rule replaces one sentence for measured lines only |
| K4 | Backend-Core | `erpnext-connector/posting-feed.yaml`: `SaleLine.measure` and `ReturnLine.measure` (kind, uom, precision) so the Connector can apply the measured rules | Yes |
| K5 | Connector | Compatibility profile and representation-check spec: §7.2 checks; measured builder rule (§7.3) | Yes |
| K6 | POS | Contract re-pin to K1/K3 (`npm run contracts:repin`); Connector re-pin to K4 | n/a |

## 11. Proposed follow-up issues (created only after ratification)

Precedent: RT-282 created gated items only after its gate was ratified. All are `[GATED: RT-488 ratified]`.

| Proposed key | Product | Work Mode | Bounded scope | Depends on |
|---|---|---|---|---|
| G5-BC-1 | Backend-Core | Implementation | K1 + K2 contracts and catalog/pricing storage for measured Sell Units; `measured_sales` terminal capability and capability-filtered read-down (§5); store readiness report for established units and tracked products (§4.1, Q-14) | RT-281 Sell Unit model (Q-12) |
| G5-BC-2 | Backend-Core | Implementation | K3 capture: `measure`, measured invariant, shared `roundToMinor`, `sale_lines` freeze columns, the count-line guard (§5). Ships **disabled** behind a per-tenant `measured_sales` enablement | G5-BC-1 contract |
| G5-BC-3 | Backend-Core | Implementation | K3 returns rule for measured lines (per Q-8). Prerequisite of the enablement gate | G5-BC-2 |
| G5-BC-4 | Backend-Core | Implementation | K4 posting feed: `measure` on sale and return lines | G5-BC-2 |
| G5-CNR-1 | Connector | Implementation | K5: UOM/precision/rounding preflight, measured builder and return builder rules, RT-378 check for measured lines | G5-BC-4 |
| G5-POS-1 | POS | Implementation | Re-pin; declare the `measured_sales` capability; measured Sell Unit in local catalogue; cart quantity representation; line rounding; receipt; sale sync `measure`; settle the `unit` token | G5-BC-1, G5-BC-2 |
| G5-POS-2 | POS | Implementation | Embedded-weight barcode parsing with tenant layouts (Q-7) | G5-POS-1 |
| G5-POS-3 | POS | Implementation | Scale integration (Q-6), incl. the native dependency | G5-POS-1; hardware decision |
| G5-POS-4 | POS | Implementation | Measured-line returns (Q-8) | G5-BC-3, G5-POS-1 |
| G5-V1 | All | Verification | rt9 end to end: barcode-weight sale → capture → Inventory Effect → ERP Sales Invoice (exact qty/uom/rate/amount) → return → credit note; re-run the RT-380 rounding gate | all above |

**Enablement gate.** Merging G5-BC-2 does not enable measured sales. A tenant's `measured_sales` enablement may be
switched on only when the owner has decided Q-8 and G5-BC-3 (measured-line returns) is deployed. Today's return
service still accepts partial returns of fractional lines and prices them by `round4` (B6): 0.147 kg of a 0.735 kg
line at 219.77 gives 43.9540 EGP, which EGP cannot represent. It also needs G5-BC-4 (feed) and G5-CNR-1 (Connector)
deployed, the Connector compatibility preflight (§7.2)
is green for that tenant's ERP site, the UOM rows are configured, and the store readiness step (§4.1) is clean. Mapping
`kg` alone never enables capture. G5-V1 proves the gate on rt9.

Admin-Console surfaces (authoring a measured price, barcode layouts) are not in RT-488's authorization; if needed they
become a separate Admin-Console item after K1/K2.

## 12. What stays true until ratification

- Fractional quantities stay rejected at capture (`sale_line_pricing_invalid`), and the POS stays whole-quantity only.
- No contract, OpenAPI, migration, package or code changes were made by this plan.

## 13. Acceptance-criteria trace (RT-488)

| AC | Where |
|---|---|
| A cross-module plan exists (ratification is the owner's) | this file; owner decisions §9 |
| It names the bounded follow-up issues per repo | §11 |
| No code, OpenAPI or migration change | the PR diff is this file only |
| Scope items 1–7 | §3 units; §4 precision/rounding; §5 invariant; §6 returns; §8 POS input; §7 Connector; §10 contract order |
