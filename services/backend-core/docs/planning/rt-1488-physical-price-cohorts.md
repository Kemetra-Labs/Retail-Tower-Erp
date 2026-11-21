# RT-1488 — Physical Price Cohorts: cohort price key and the W1 side of W3 conservation (decision record, DRAFT)

> **Status: DRAFT, awaiting owner ratification.** Work Mode: **Planning**. Jira holds the live status.
> This file proposes options and a recommendation. It is not a ratified decision and authorizes no code,
> OpenAPI, migration or Jira status change. Horizon: **Post-Pilot**. Conditional, opt-in capability.
>
> **Baseline:** `main` at `924482fb0` (2026-11-21). Decision numbers 461–718, CR05/CR06, F02/F03 and G2 come from
> Confluence, not the repo; 470 and 602–636 do not appear in specs 041–043 and were taken from Confluence 23855106. Read-only inspection of
> `packages/db/src/schema/pricing/pricing.ts` and `specs/041-pricing-domain/{spec,data-model}.md`. No runtime exercised.
>
> **Sources:** W1 workshop P01–P12 (Confluence 83034148, P02–P06 and its reconciliation table);
> CR01–CR16 (Confluence 84050068, **CR05, CR06**, register rows F02/F03); Pricing decisions 461–718
> (Confluence 23855106: 475–477, 489–501, 522–531, 602–604, 618–636, 470, 480);
> RT-1480 quantity answer (RT-1488 comment 17795, owner-ratified 2026-11-19, D5).

## 1. Problem

Two conflicts block Physical Price Cohorts (the same physical item sold at two approved prices, for example
old-price and new-price packs on one shelf).

- **F03, pricing key.** The key has no cohort dimension. On `main` it is
  `(tenant, price_book, scope, zone-or-store, product, sell_unit, price_kind)` with an exclusion constraint on
  overlapping active intervals (`data-model.md` §2.4). Two prices for one item in one store at one instant is,
  by decisions 498–500, an invalid overlap today.
- **Conservation (the W1 side).** Cohort allocations plus unassigned quantity must equal the W3 balance
  (Item × Location × Status × real Tracking identity), with no second ledger and no fake ERP batches (CR05).

Note: the issue text labels the second item "F02/G2". In the CR register F02 is *Central Stock Grain*, not
cohorts, and "G2" is the W3 conservation gate in the P01–P12 record (§6). This record treats the conservation
topic as that gate. The owner may want the issue wording corrected.

Note: Confluence 23855106 still names `tenant_products.default_price` plus `store_product_overrides.price` as the
"current technical anchor". `main` already has the Price Book / Zone / `price_events` runtime (specs 041–043), so
this record builds on `price_events`, not on the older anchor.

## 2. Fixed constraints (not reopened here)

1. A cohort keeps the same `tenant_product.id`. It is not a Batch, Serial or ERP Item (P03, CR05).
2. Cohorts never create tracking identities. Identities come only from ERP (G7-3).
3. Pricing stays the selling authority; ERP never reprices Retail sales (CR06).
4. A published Pricing Revision is immutable. Rollback is a new revision (530–531). One coherent revision per
   publish (528).
5. Price and revision are frozen on the CartLine and SaleLine. A live cart is never silently repriced (470, 602–604).
6. A shared manufacturer barcode never guesses a cohort (P04, CR06).
7. Missing price means not sellable (480).
8. W3 owns quantity. Moving stock between cohorts writes no `stock_movements` row and no ERP stock entry (RT-1480 D5).

## 3. Decision CP-1 — cohort price key and resolver (F03)

| Option | Effect |
| --- | --- |
| **A (recommended)** | Add a nullable `price_cohort_id` to the price-event key and its exclusion constraints. `NULL` means the ordinary price. The resolver gains an optional `cohort` input. Same precedence (Store > Zone > Book), applied inside the chosen cohort. |
| B | A separate cohort price table and a resolver overlay. Creates a second price authority and a second revision story. |
| C | Model each cohort as its own Retail Item. Contradicts P03 and CR05; breaks sale, return and inventory identity. |

**Recommendation A.** It reuses the existing events, immutability trigger, Change Set lifecycle and revision fan-out.
Uniqueness follows once the exclusion constraints are rebuilt with the cohort in the key as
`coalesce(price_cohort_id, nil-uuid)`, the same way the key already uses `coalesce(price_zone_id, store_id, nil-uuid)`.
A bare nullable column is not enough: in a GiST `EXCLUDE … WITH =` a NULL never conflicts, so two overlapping ordinary
events would both be accepted and decisions 498–500 would break for merchants who never opt in. The rebuild is in
follow-up slice 2 (§8). Result: at most one active event per `(…, product, sell_unit, price_kind, cohort-or-ordinary)`.

Resolver rules under A:

- No cohort supplied: only `NULL`-cohort events are candidates. Current behaviour is byte-identical, so nothing
  changes for merchants who do not opt in.
- Cohort supplied: only that cohort's events are candidates, resolved Store > Zone > Book as today.
- **Fail closed.** A cohort with no price at any layer resolves to `unpriced(reason: no_cohort_price)`. It does **not**
  fall back to the ordinary price. A silent fallback would sell old stock at the new price. Alternative: fall back
  with an explicit provenance flag (owner choice, see §7 Q1).
- Cohort identity is a tenant-scoped, product-bound record (state, internal label code). Its fields are for the
  later contract slice, not decided here.

## 4. Decision CP-2 — cohort selection and shared barcodes

| Option | Effect |
| --- | --- |
| **A (recommended)** | Selection comes from a typed, tenant-safe, collision-checked **internal cohort-aware label**. A guarded manual choice needs permission, trustworthy physical or receiving evidence, and an audit row. |
| B | Prefer the oldest cohort automatically (FIFO guess). |
| C | Cashier always chooses. |

**Recommendation A** (P04). Rules:

- **Terms.** *Open* is a lifecycle state of the cohort (its price is published and it has not been closed), independent
  of stock. *Has stock* means a positive W3 allocation for that item at that location. The rules below use *open* only.
- A scan of a manufacturer barcode resolves the Retail Item only. If **more than one cohort is open** for that item at
  that location, the sale is refused until a label or guarded choice names one, even if only one of them currently has
  stock (allocation can change, and the till cannot prove it). It never guesses.
- If **exactly one cohort is open** for that item at that location, the sale proceeds with it (online).
- **Offline:** a cohort sale requires a cohort-identifying label. A stale snapshot listing a single open cohort is not
  enough, because a newer cohort may have reached the shelf while the till was offline and the shared barcode would then
  freeze the wrong cohort and price. Without a label, refuse the cohort sale. No claim of globally authoritative cohort
  quantity while disconnected; reconnect detects an allocation conflict and never rewrites accepted sales
  (CR06, §7 scenarios).

## 5. Decision CP-3 — revision contract (extends 522–531, 602–604)

Recommendation, one option because the constraints leave little room:

- Cohort events are authored and published through the existing Price Change Set and publish in the same revision as
  related ordinary events (528). Immutable (530); rollback is a new revision (531).
- The POS pricing projection (618–619) carries cohort rows in Snapshot and Delta. A device applies a coherent revision
  (628) and keeps its last good revision identifiable (629).
- CartLine and SaleLine freeze `price_cohort_id`, revision and provenance with the price (602–604, 470). A return
  follows the original economic facts, not today's cohort price.
- Reclassifying stock between cohorts, or repricing a cohort, never edits an accepted sale and creates no ERP entry (P06).
- Printed-label readiness stays optional and non-blocking for valid existing sales (CR15, 635–636). Cohort labels
  print online first.

## 6. Decision CP-4 — the W1 side of conservation

| Option | Effect |
| --- | --- |
| **A (recommended)** | W1 owns cohort **identity and price**. W3 owns **allocation rows** that reference the cohort id and reconcile to the W3 position. W1 stores no quantity. |
| B | W3 owns cohort identity too; W1 only references it. |
| C | W1 stores cohort quantities. Rejected: second ledger. |

**Recommendation A.** It matches RT-1480 D5 ("allocation layered on the existing W3 stock position").

- A cohort sale carries `price_cohort_id` on the sale line. The single W3 sale effect decrements that allocation. There is
  no extra movement and no second ERP effect.
- Allocation provenance, unassigned quantity, holds and negative or reservation semantics stay W3's.
- **Fallback if W3 rejects A:** B moves identity into W3, and only the price key's reference column stays here. CP-1 is
  unaffected by that choice.

## 7. Open questions for the owner

1. Cohort with no price: fail closed (recommended) or fall back to the ordinary price with a provenance flag?
2. Opt-in level: per merchant, per store, or per item? (P02 says per merchant or store.)
3. Who may reclassify stock between cohorts, and does it need maker-checker?
4. Should a cohort have a mandatory end condition (stock exhausted, date), or stay open until closed by hand?

## 8. Follow-up slices (named, not created)

Each needs its own Jira issue, the DoR, and for the first two a `[GATED]` approval.

1. **Contract** `[GATED: contract]`: cohort key on pricing inquiry and authoring, sale-line cohort field, POS projection rows (additive; `NULL` default).
2. **Schema** `[GATED: migration]`: cohort identity table, `price_cohort_id` on `price_events`, exclusion-constraint rebuild.
3. **Resolver and authoring runtime**: Backend-Core, includes the fail-closed rule and uniqueness tests.
4. **W3 allocation** (owned by RT-1480 / W3): allocation rows, conservation invariant, cohort-preserving transfers and counts.
5. **POS**: snapshot/delta consumption, label and guarded barcode selection, offline rule.
6. **Labels** (M6): cohort-aware internal label and readiness.
7. **Migration and activation**: per-merchant enablement and legacy-price handling.
8. **Verification**: two offline tills on one shared barcode, reconnect conflict, tracked items never create identities, repricing with stale devices.

## 9. Not covered here

Code, OpenAPI, migration, W3 quantity implementation, W4 fiscal, supplier terms (P08–P10), offers (Offer Engine).
This record does not change decisions 461–718. It extends them as a gated target per CR05–CR06.
