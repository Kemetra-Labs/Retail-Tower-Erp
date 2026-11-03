# RT-827 — Product create from the Console: contract decision record

| | |
|---|---|
| **Jira** | RT-827 (Admin-Console product create, split from RT-768 by D9). Inputs: RT-972 v4.0 boards, the design brief `apps/admin-console/docs/design/rt827-product-create/README.md` (PR #109), owner decisions of 2026-10-29 (RT-827 comment 14416). Related: RT-752 (field contract, AC 3), RT-738 (interim catalog writes), RT-484 / RT-485 (pricing plans, specs 042 / 044), RT-282 (pricing decomposition). |
| **Work Mode** | Planning (contract-first), at the coordinator's request. Docs only: no contract file, code, migration, rate-limit class or CI change. **Note:** the Jira field on RT-827 says *Implementation*; this record does not change it. |
| **Status** | **Proposed.** Every option below needs an owner decision. Any contract change it leads to needs an owning issue and `[GATED]` approval. |
| **Baseline** | `Kemetra-Labs/Retail-Tower-Erp` `origin/main` = `6e3ffc99` (RT-1082, #267). `catalog/console-catalog.yaml` is `1.1.0-draft`. |
| **Why docs only** | `packages/contracts/openapi/**` and SQL migrations are `[GATED]` (`services/backend-core/CLAUDE.md`). Nothing in RT-827 authorizes a contract change. |

Line references are to `origin/main` at the baseline above.

---

## 0. Summary

**The premise "Backend-Core has no create-product contract" is not true on `main`.** The create contract exists and is served:

- `consoleCreateCatalogProduct`, `POST /api/v1/catalog/products` (`console-catalog.yaml` lines 287–341), owner-approved under RT-738 (O-1 "Allow interim writes", O-2 "Exclude price for now").
- Runtime: `console-catalog.write.controller.ts` lines 92–102 (`@Post(PRODUCTS)`, `@Roles("owner", "tenant_admin")`, `@Idempotent("required")`); `console-catalog.write.service.ts` line 188 onwards (`INSERT INTO tenant_products` at line 202, no price column).
- Rate-limit class `write` (`apps/api/test/console-rate-limit/classes/catalog/console-catalog.rate-limit.yaml`).
- RT-827 comment 14055 (2026-10-27) already recorded this: "Not a contract gap".

**The only gap is price.** No contract on `main` writes a price (O-2), POS read-down omits unpriced products (spec 041 F4), and D9 holds create until a price write exists. There is also **no price-writer Implementation issue**: RT-282, RT-484, RT-485 and RT-284 are all *Done* as Planning, and no Implementation child exists (JQL, 2026-11-03).

| Item | Proposal | Owner decision |
|---|---|---|
| Create operation | **Reuse** the `consoleCreateCatalogProduct` operation (same path and identity). No new `createTenantProduct`. Its contract and runtime stay unchanged unless PD-2 picks (P-b), which adds `initialPrice` to it | PD-1 |
| Price | The decision that unblocks RT-827: (P-a) price only through the Pricing change-set path, or (P-b) a bounded legacy-authority initial price, or (P-c) a separate interim legacy price write | PD-2 (central) |
| Unknown-items create path | Keep separate on the wire; no change | PD-5 |
| Store overrides at create | No | PD-6 |
| ERPNext Item mapping | After create, through the existing 013 backlog; create calls nothing ERP-side | none (fact) |
| Migration | (P-a): none for RT-827. (P-b): no DDL. (P-c) with a `price_history` row per write: a `[GATED]` migration, because a second write cannot close the open interval today (§8). A tenant-currency source is `[GATED]` for (P-b) and (P-c) | PD-2 / PD-3 / PD-7 |
| Implementation split | Depends on PD-2 (§10) | PD-8 |

**Naming.** This record's decisions are **PD-n** and its price options **(P-a) / (P-b) / (P-c)**, so they do not collide with the brief's owner decisions OD-2 / OD-3 / OD-4 and D9 option (b) (brief §9, `RT-972-notes.md` §1). "Brief OD-2" below means the 2026-10-29 decision.

---

## 1. Rules every fragment follows

Taken from `console-catalog.yaml` 1.1.0-draft as it is on `main` (lines 136–226):

- `cookieAuth` only, through `SessionOnlyAdminGuard` → `TenantContextGuard` → `RolesGuard`. The tenant and the actor come from the session, never from the body (§III, §XII).
- A role outside the list is a **non-disclosing 404** (`denyAs: 404`), never a 403. A write answers 403 only with `origin_rejected` (RT-430) or `tax_override_forbidden`.
- **Order of checks on a write:** session / `Origin` / role → `Idempotency-Key` (create only) → path and body (400) → product and store (404) → the write's own rules (403 / 409 / 422) → write and audit row in one transaction.
- Every accepted write appends one `audit_events` row in the same transaction. A refused write and an idempotent replay write none.
- `catalog_change_log` triggers record every product change, so the POS read-down delta picks it up with no other step.
- Money is an exact-decimal string plus an ISO-4217 `currencyCode`, `numeric(19,4)` at rest. Never a float.
- Each `cookieAuth` operation has a class in its contract's own file under `apps/api/test/console-rate-limit/classes/`, in the same PR as the contract (RT-805).
- **Contract-only marker:** a new operation carries `x-runtime-status: contract-only` only when its contract PR lands before its runtime. If contract and runtime ship in one PR, it carries neither `x-runtime-status` nor `x-runtime-note`.

---

## 2. Board → contract field map

Sources: `Product-create.dc.html`, `Product-create-states.dc.html`, `RT-972-notes.md` §1, brief §4.

| Board field | Wire field (`CreateCatalogProductRequest`, lines 1190–1212) | On `main`? | Note |
|---|---|---|---|
| الاسم | `name` (required, 1–500, not whitespace-only, no NUL) | Yes | Client trims the ends (D5) |
| الوصف | `description` (nullable, 1–2000) | Yes | Empty → `null` |
| الفئة | `categoryId` (nullable uuid, not retired) | Yes | 422 `category_unavailable` |
| فئة الضريبة | `taxCategory` (required, 1–50) | Yes | Free text, no registry (brief G2) |
| متاح للبيع افتراضيًا | `isActive` (default `true`) | Yes | Brief OD-2 variant (2026-10-29) replaces it with a read-only line if create ships before price |
| التتبع «بلا تتبع» | none (display only) | Server default | New product starts `none`; changed only on `catalog/tracking-profile.yaml` |
| **السعر** | **none** | **No** | Board draws a placeholder (PC-1). The only missing field. See §4 |
| Identifiers (barcode / SKU) | none on create | By design | Added on the detail page with `consoleAddProductIdentifier` (RT-752 AC 3, brief §5: create is not atomic with identifiers). The v3 note "identifiers added inline" (RT-827 comment 14542) is superseded by the v4.0 board and the brief |

**Not on the board and not proposed:** store, supplier, cost, unit of measure, image, ERP item code. Nothing in RT-827, RT-752 AC 3 or the boards justifies them.

### 2.1 States → responses

All 15 states on `Product-create-states.dc.html` already map to a response on `main`:

| State | Response |
|---|---|
| 1–2 entry, empty list | `consoleListCatalogProducts` 200 |
| 3–4 loading, categories failed | `consoleListCatalogCategories` 200 / error |
| 5 read-only role | Client-side (role from context); the server would answer 404 |
| 6 server refusal | 404 `WriteNotFound` (non-disclosing) |
| 7 submitting | — |
| 8 key fault | 400 `idempotency_key_required` / `idempotency_key_malformed` |
| 9 conflict | 409 `idempotency_key_conflict` |
| 10 in progress | 425 `idempotency_in_progress` + `Retry-After` / `retryAfterSec` |
| 11 category | 422 `category_unavailable` |
| 12 unknown outcome | 500 or no response (same key retry replays the 201) |
| 13 rate limited | 429 `rate_limited` + `Retry-After` |
| 14 landing | 201 `ConsoleCatalogProductDetail` (and `Idempotent-Replayed: true` on replay) |
| 15 brief OD-2 variant | Conditional: only if create ships before price |

PC-3 (brief OD-2 line wording), PC-4 (categories-failed copy) and PC-5 (aside surface) are copy or design questions, not contract questions. They stay with the Console.

---

## 3. The create operation: reuse, unchanged

Recommendation (PD-1): **reuse** `consoleCreateCatalogProduct`. A second create operation next to an implemented, audited, idempotent one would split the write path and its audit action for no field the board needs.

What it already gives, quoted from `main` for the record (not a change):

```yaml
# catalog/console-catalog.yaml 1.1.0-draft — UNCHANGED, quoted for reference
/api/v1/catalog/products:
  post:
    operationId: consoleCreateCatalogProduct
    x-idempotency: required            # Idempotency-Key header, 16–128 printable ASCII
    x-audit-action: catalog.product.create
    # roles: owner, tenant_admin (store_manager / store_staff → non-disclosing 404)
    # precondition: none (a create has no expectedUpdatedAt); categoryId must be a live category
    requestBody: CreateCatalogProductRequest   # name, taxCategory required; description, categoryId, isActive
    responses:
      "201": ConsoleCatalogProductDetail       # + Idempotent-Replayed: true on replay
      "400": validation_error | idempotency_key_required | idempotency_key_malformed
      "401": unauthenticated
      "403": origin_rejected
      "404": non-disclosing (role, tenant)
      "409": idempotency_key_conflict
      "422": category_unavailable
      "425": idempotency_in_progress (Retry-After)
      "429": rate_limited (Retry-After)
      "500": system_failure
# rate-limit class: write  (classes/catalog/console-catalog.rate-limit.yaml)
```

Every RT-827 acceptance criterion about error codes (400 / 409 / 425 / 422) is already served. A price in the body is 400 `validation_error` today (`WriteValidationFailure`, line 1446).

---

## 4. Price: the decision that unblocks RT-827

### 4.1 Facts on `main`

- `tenant_products.default_price numeric(19,4)` + `default_currency_code char(3)` exist, paired by a CHECK (`packages/db/src/schema/catalog/tenant-products.ts` lines 8–10, 63–64).
- `price_history` exists, INSERT-only under RLS, with one open interval per scope (`price-history.ts` lines 1–18, migration `0007_catalog.sql`). **No application code writes it** (no `price_history` reference in `apps/api/src` or `packages/db/src/cli`).
- The only **reachable** price writer is the seed CLI (`packages/db/src/cli/seed-catalog.ts`). Spec 044 §2.2 also lists `StoreOverrideService.create` (`apps/api/src/modules/catalog/store-override.service.ts`, writes an override `price`, registered in no module, so unreachable) and direct SQL. There is no HTTP price-authoring surface (spec 044 line 47).
- `price_history` keeps one open interval per product (`UQ_idx_price_history_tenant_open`, `0007_catalog.sql` lines 346–348) and no session can update a row (`price_history_no_update`, `USING (false)`, lines 377–380). So a **second** price write cannot close the earlier open row, and inserting a new open row breaks the unique index.
- **No tenant currency exists:** `packages/db/src/schema/tenants.ts` has no currency column, and none of the catalog schemas hold one. The legacy currency is per product (`default_currency_code`), and 044 refuses to import a multi-currency tenant (044 plan line 642).
- The pricing target is specs 041 / 042 / 044: Price Books, change sets with preview, four-eyes approval and publish (042 §3, §7), and a per-tenant single writable authority `legacy | cutover_in_progress | pricing` (044 §6.1, decision 712). Under `legacy` the legacy columns are writable; under the other two they are frozen by a trigger (044 §6.2). **None of this is on `main`:** `tenant_pricing_authority` does not exist in `packages/` or `apps/`.
- V1 roles: owner and tenant_admin author prices; store_manager authors none (042 §7, Q-B2). That matches the create roles.

### 4.2 Options (PD-2)

| | Option | What RT-827 gets | Cost and risk |
|---|---|---|---|
| **(P-a)** | **Create stays price-free.** Price comes only through the Pricing change-set path (042 PR-04 contract → PR-10 runtime) after cutover. | Create ships after pricing. The landing page links to "set a price" in the Pricing UI. | Longest path. Needs the RT-281 primitive, 042 §7's interim `pricing.change_set_approval` setting (shaped for RT-284 to absorb), 041 tables, 042 runtime, and the tenant's 044 cutover (044 §6.1 rejects Pricing authoring under `legacy`; MC-11 keeps new tenants on `legacy`). No issue exists yet for any of it. |
| **(P-b)** | **Optional initial price on create**, legacy authority only. An additive optional `initialPrice: Money` on `CreateCatalogProductRequest`. Written to `default_price` + `default_currency_code` (+ a `price_history` row, PD-7) in the create transaction. | One form, one request. The item reaches the POS only when it passes the read-down sellable filter (`read-down.yaml` lines 32–36: active for the store, priced, currency present, amount representable in the currency's minor unit) and has an active `sku` identifier, which every sellable row carries (line 410). A barcode alone, or a retired SKU, is not enough. | Creates a second legacy price writer that 044 must import and later freeze. Needs the currency rule (PD-3). Does not cover **changing** a price after create, so a typo needs (P-c) or (P-a) anyway. |
| **(P-c)** | **A separate interim legacy price write**, `consoleSetProductDefaultPrice`, in the RT-738 interim style (direct, audited, `expectedUpdatedAt`), replaced by change sets at cutover. | Create stays as is; the landing page offers "set price". Also covers corrections. | A new interim write the owner has not approved. 042 §7's v1 default is `mode: always`, so **every** change set is sensitive and needs a second approver; an interim direct write skips that unless the owner accepts it for `legacy` authority (PD-4). Keeping a `price_history` row per write (PD-7) needs a `[GATED]` migration to close the open interval (§4.1, §8). |

**Recommendation: (P-a) as the target, with (P-c) only if the owner wants live in-pilot product creation before the Pricing runtime exists** (RT-827 comment 13754, "Stage B"). (P-b) alone is not recommended: it solves the first price but not the first correction, and it adds price semantics to a catalog write that O-2 kept price-free on purpose.

### 4.3 Fragment for (P-b), only if chosen

Shown so the owner sees the size of (P-b). Not proposed as the default.

```yaml
# catalog/console-catalog.yaml 1.2.0-draft — ONLY IF PD-2 = (P-b). Additive.
CreateCatalogProductRequest:
  properties:
    initialPrice:
      description: >
        Optional tenant default price. Accepted only while the tenant's price
        authority is `legacy` (spec 044 §6.1). Written with the product in one
        transaction; audited in the same `catalog.product.create` row
        (new value only). Absent → the product has no price (O-2 behaviour).
      $ref: "#/components/schemas/Money"    # amount DecimalAmount (> 0, PD-3), currencyCode
responses (create, added codes):
  "409": pricing_authority_not_legacy    # once 044 exists; the freeze trigger also refuses
  "422": currency_not_allowed            # currencyCode is not the tenant's currency (PD-3)
# x-idempotency, x-audit-action, roles, rate-limit class: unchanged
```

Open points it would carry: whether `amount` may be `0` (the shared `DecimalAmount` allows it; a sale price of zero is a product decision, PD-3); where the tenant currency comes from (044 MC-10 treats it as a declared per-tenant input with no default, so it cannot be guessed).

### 4.4 Fragment for (P-c), only if chosen

```yaml
# catalog/console-catalog.yaml 1.2.0-draft — ONLY IF PD-2 = (P-c). Additive.
/api/v1/catalog/products/{productId}/default-price:
  put:
    operationId: consoleSetProductDefaultPrice
    x-audit-action: catalog.product.price.set
    # Interim (pre change sets, decision 400; replaced at 044 cutover).
    # roles: owner, tenant_admin (store_manager → 404, 042 §7 Q-B2)
    # precondition: expectedUpdatedAt = product summary.updatedAt → 409 stale_write
    requestBody:
      required: [expectedUpdatedAt, price]
      properties:
        expectedUpdatedAt: ExpectedUpdatedAt
        price: Money              # tenant currency only (PD-3)
    responses:
      "200": ConsoleCatalogProductDetail
      "400": validation_error
      "401": unauthenticated
      "403": origin_rejected
      "404": non-disclosing
      "409": stale_write | product_retired | pricing_authority_not_legacy
      "422": currency_not_allowed
      "429": rate_limited
      "500": system_failure
# rate-limit class: write
```

Clearing a price, and store override prices, stay out (an override price stays on the RT-738 rule: kept as is). If the owner wants them, they are separate decisions.

---

## 5. Relation to the Unknown-items create path

`tenantAdminCreateProductFromUnknownItem`, `POST /api/v1/catalog/unknown-items/{id}/create-product` (`unknown-items.yaml` lines 527–621), differs from the Console create on purpose:

| | Console create | Unknown-items create |
|---|---|---|
| Starts from | nothing | a pending unknown item |
| Effects | one product | product + alias binding + item `resolved`, atomic (FR-063) |
| Conflicts | `idempotency_key_conflict` | `alias_conflict`, `already_reconciled` |
| Runtime | `ConsoleCatalogWriteService` (raw `INSERT`, line 202) | `ReconciliationService` (raw `INSERT`, line 514; it deliberately does not call `TenantCatalogService.create`, lines 46–49, 507) |

Recommendation (PD-5): **keep them separate on the wire.** Do not route the Console create through the unknown-items path or the reverse. If PD-2 picks (P-b), the unknown-items create stays price-free (its body has no price and nothing asks for one); its result is still an unpriced product, so the same "set a price next" step applies.

A shared internal insert helper would remove the duplicate `INSERT INTO tenant_products` SQL, but it is a refactor that no issue asks for. Not proposed here.

**Observation only, out of scope:** the unknown-items contract describes a role failure as 403 (line 593), while its controller comment says `denyAs: 404` (`reconciliation.controller.ts` line 31). This record does not resolve it.

---

## 6. Store overrides at create

**No** (PD-6). The contract creates no override (line 296), the boards draw none, and `consoleUpsertStoreOverride` sets availability and tax per store afterwards. Store override **prices** are not writable by any option above.

## 7. ERPNext Item mapping timing

Backend-Core is the product authority (repo `CLAUDE.md` §5). Create calls nothing ERP-side (`console-catalog.yaml` lines 35–37, 161). The mapping comes later:

1. A new active product with no confirmed mapping appears in `listProductReconciliationBacklog` as `unmapped_dp2_product` (`product-reconciliation.yaml` lines 23–27, 92).
2. The tenant admin confirms the ERPNext Item with `tenantAdminSuggestErpnextItemMapping` / `tenantAdminConfirmErpnextItemMapping` (`erpnext-item-map.yaml`), which is identity only, with no price, UOM or store (lines 14–17).
3. The connector posts the frozen sale price with `ignore_pricing_rule=1` (spec 044 §2.3). No Backend-Core → ERPNext Item Price push exists, and none is proposed.

A sale of an unmapped product fails to the DLQ at posting (`erpnext-item-map.yaml` lines 10–11), so the Console should prompt for the mapping. That is a Console design point (not drawn on the boards), not a contract change.

## 8. Migration need

| PD-2 | Migration |
|---|---|
| (P-a) | None for RT-827. The Pricing tables are spec 041 / 042 / 044's own migrations. |
| (P-b) | **No new column**: `default_price` and `default_currency_code` exist. A first-price `price_history` INSERT (PD-7) needs no DDL; the writer is new behaviour (its header says every change writes a row, but no code does today, so seeded prices have no row). |
| (P-c) | No new price column. With PD-7 = yes, a **`[GATED]` migration is required**: the second write on a product must close the open interval, which `price_history_no_update` forbids and `UQ_idx_price_history_tenant_open` makes necessary (§4.1). Shape: a narrowly scoped close-interval path (for example a `SECURITY DEFINER` function that only sets `effective_to` on the open row). The alternative is PD-7 = no for (P-c). The 044 import (§4.5, MC-3) then finds an empty `price_history` and does nothing; it does not rebuild history from audit rows, so price changes recorded only in audit rows are left out at cutover. Whether that is acceptable, or history is written, or rebuilt separately, is the owner's call (PD-7). |
| (P-b), (P-c) | **Tenant currency (PD-3):** none exists (§4.1). A "tenant currency only" rule needs a `[GATED]` source (a column or a setting), or a rule taken from the tenant's existing product currencies. |

---

## 9. Open decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| **PD-1** | Reuse the `consoleCreateCatalogProduct` operation instead of a new create operation (unchanged unless PD-2 = (P-b)) | Reuse |
| **PD-2** | How a Console-created product gets its first price: (P-a) Pricing change sets only; (P-b) optional initial price on create (legacy authority); (P-c) interim legacy price write | (P-a) as the target; (P-c) only if live in-pilot product creation is needed before the Pricing runtime |
| **PD-3** | If (P-b) or (P-c): the price currency rule and whether `0` is allowed. No tenant currency exists today (§4.1), so "tenant currency" needs a `[GATED]` source (cf. 044 MC-10) | Tenant's declared currency (new `[GATED]` source, reusable by 044 MC-10); `> 0` |
| **PD-4** | If (P-c): accept a direct, audited, single-actor price write under `legacy` authority, without the 042 four-eyes approval | Accept only as interim, removed at cutover |
| **PD-5** | Keep the Unknown-items create separate on the wire | Separate |
| **PD-6** | No store overrides at create | No |
| **PD-7** | If (P-b) or (P-c): write a `price_history` row for each price write. For (P-c) this needs a `[GATED]` close-interval migration (§8) | Yes (the table's own rule), with that migration for (P-c) |
| **PD-8** | Implementation split (§10) | Per PD-2 |
| **PD-9** | Revisit D9 (hold create until a price write exists) once PD-2 is chosen | Keep D9 until the chosen price write is merged |

Also for the owner: RT-827's `Blocks` links point at RT-484 / RT-485, which are Done as Planning and do not deliver a price writer (comments 13754, 14055). Re-pointing them at the real Implementation issue is a Jira change this record does not make.

## 10. Proposed Implementation split

Not created; the owner decides.

**If PD-2 = (P-a):**

- No Backend-Core issue for create.
- The Pricing runtime chain needs Implementation issues that do not exist yet: 042 PR-04 (contract), PR-05 (tables), PR-10 (runtime), the 044 cutover, and a Console Pricing UI. That is RT-282's decomposition to file, not RT-827's.
- RT-827 stays the Console build, blocked by the 042 PR-10 issue **and** the 044 cutover for the pilot tenant (044 §6.1, MC-11), once those issues exist.

**If PD-2 = (P-c):**

1. *Backend-Core — interim legacy default-price write `consoleSetProductDefaultPrice` [GATED contract]* (Implementation, one PR: contract + rate-limit class + runtime + tests; with PD-7 = yes, also the `[GATED]` `price_history` close-interval migration and the tenant-currency source of PD-3). Blocks RT-827.
2. *Admin-Console — RT-827 product create*, unchanged scope, plus "set price" on the landing page (a design delta to frames 88 / state 14).
3. Spec 044's import must read rows written by issue 1; note it on the 044 cutover issue when it is filed.

**If PD-2 = (P-b):** as (P-c) item 1, but as an additive field on `consoleCreateCatalogProduct`; the board's price placeholder (PC-1) becomes the field. A price correction then still needs (P-c) or (P-a).

## 11. Not in this proposal

- Pricing domain design (Price Books, change sets, approval policy, cutover): specs 041 / 042 / 044.
- Store override prices.
- Categories, units, cost, images.
- The 403/404 wording of the unknown-items contract (§5).
- Any change to RT-827's status, links, Work Mode or Closeout Gate.
