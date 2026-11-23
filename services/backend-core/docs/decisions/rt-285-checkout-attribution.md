# RT-285 — Checkout attribution, seller code and commission: decision package

| | |
|---|---|
| **Jira** | RT-285 (parent Epic RT-2, W2 Sales Capture + ERP Posting; fix version Post-Pilot). Related: RT-284 / AD-POL-001 (policy engine), RT-740 / RT-28 (manual discount), RT-6 (W6 returns, refunds, shifts), RT-1197 (workforce and payroll, post-pilot). |
| **Work Mode** | Planning ("Planning only — no implementation authorized"). Docs only: no contract file, code, migration, CI or Jira issue is created by this record. |
| **Status** | **Proposed.** Every recommendation below needs an owner decision. Commission *policy* (rates, dimensions, payout) stays with the owner. The drafted follow-ups in §8 are drafts; the owner creates them. |
| **Authority for this run** | Owner chat delegation of 2026-11-23 (choose recommended actions; planning tickets under the same authorization; PRs authorized). Recorded on RT-285. |
| **Baseline** | `Kemetra-Labs/Retail-Tower-Erp` `origin/main` = `b0a2e18e7` (RT-1559, #831). `pos-sales/sales.yaml` is `1.28.0-draft`. ERPNext pin v16 (16.51.0, `integrations/erpnext-connector/docs/decisions/version-pin-upgrade-policy.md`). |
| **Policy source** | Confluence RETAIL page 23134209, "Policy, Permissions, Sales Attribution, Promotions & Commission Decisions", v6, §6–10, read together with §12, §20 and §22. AD-POL-001 (page 38207489) for capability tiers. |

Paths are relative to the repository root and refer to the baseline above.

---

## 0. Summary

**Today Retail Tower records one person per sale, and calls that person "seller" in one place.** A sale stores `sales.created_by` (the admitted cashier on the device path, `operatorUserId`) and `sales.device_id`. There is no seller, no seller code, no line-level attribution, no payment receiver and no commission anywhere in Backend-Core, POS, Admin Console or the Connector. The one existing use of the word is `credit-sale-reversal.checks.ts`, which sets `sellerUserId: row.created_by` (line 174) and refuses an approver equal to it (line 285). In policy terms that is the **Transaction Operator**, not the Seller.

| Topic | Recommendation | Owner question |
|---|---|---|
| Who a Seller is | **Reuse** `users` + `memberships`: a Seller is a tenant member (store staff or above). Add a tenant-unique Seller Code to the membership. No separate employee master in V1 | OQ-1 |
| Attribution model | Five separate facts (§6): Transaction Operator (exists, `created_by`), **Seller per line** (new), **Payment Receiver per tender** (new, defaults to operator), Approver (exists per action), Drawer Custodian (W6). Never one field | OQ-2 |
| Checkout modes (§7) | V1 ships **Hybrid** (seller defaults to the operator; only differences need input) as the system default, with **Dedicated Cashier** as the second permitted mode. Chain default + Store mode through the AD-POL-001 policy entries | OQ-3 |
| Seller requirement | A policy entry (`checkout.seller.required`), default **off**. Scanning is never blocked; when on, finalization is blocked until every line has a seller | OQ-3 |
| Seller code at the till | Typed or scanned code, validated against a **trusted cached staff set** shipped by extending the existing device roster read. Unknown or out-of-scope codes fail closed. Attribution only, never authentication | OQ-4 |
| Existing "seller" in credit reversal | Stays bound to the operator (`created_by`); the four-eyes rule is about who rang the sale. Rename the internal field to `operatorUserId` when the Seller lands | OQ-5 |
| Commission: where computed | **Backend-Core** owns line-level attribution facts and an append-only commission accrual / adjustment ledger (operational facts, not GL). **ERPNext** receives only accounting effects, through the Connector, when a period's payout is approved. ERPNext Sales Team is an optional, later projection | OQ-6 |
| Commission policy | Owner-defined. The engine supports percent-of-line-net by product / category / store with effective dating; rates themselves are not set here | OQ-7 |
| Manual-discount attribution gap (§9) | Today a manual discount's kind, reason and approver are hashed but **not stored**. Draft a follow-up in the RT-740 lineage; RT-285 does not widen to fix it | OQ-8 |
| Drawer custodian and handover | Out of RT-285 scope: depends on W6 (RT-6). Record the dependency only | OQ-9 |

---

## 1. Context

RT-285 was created by the 2026-10-07 Jira ↔ Confluence reconciliation to turn Policy §6–10 into a decision package and bounded follow-ups. The policy page itself (§12) states that no implementation slice is authorized by it and that the baseline must be reconciled with existing authority, shift and POS contracts first. This record does that reconciliation against `origin/main`.

Architecture invariants applied throughout (repo `CLAUDE.md` §4–5, Policy §22):

- `POS / Admin-Console → Backend-Core → ERPNext-Connector → ERPNext`.
- Backend-Core owns retail operational logic, including seller attribution (Policy §22 names it explicitly).
- ERPNext is the accounting engine; no duplicated accounting engine in Retail Tower.
- The Connector is the only ERPNext adapter.

## 2. The policy as read (§6–10, with §20)

Short quotes are marked; the rest is summary.

**§6 Checkout, drawer and actor attribution.**

- Drawer Custodian, Transaction Operator, Seller, Payment Receiver and Approver are distinct facts that "must not be collapsed into one user field".
- The custodian owns cash reconciliation for the custody period. Handover is a formal, recorded event; responsibility "never changes implicitly".
- Another authorized operator may sell on an open drawer without becoming custodian; operators may quick-switch without closing the drawer.
- Attribution is editable while the cart is open; after finalization, corrections are separate audited events, not history rewrites.
- Returns reduce the original seller's performance; the return operator and approver are recorded separately.

**§7 Configurable checkout modes.**

- Chain default, Store may choose another permitted mode.
- Dedicated Cashier: seller captured separately; the cashier owns checkout, payment and drawer.
- Hybrid: seller "defaults to the current operator; only differences require extra input".
- `payment_received_by` defaults to the Transaction Operator; an explicit action captures another receiver.
- Whether Seller is required is store policy. Scanning must not be blocked; if required, finalization is blocked until complete.

**§8 Seller and line-level attribution.**

- A primary seller is inherited by new lines; an optional Multiple Sellers mode exposes seller per line, with bulk reassignment.
- Same SKU, different sellers: split into separate logical lines.
- V1 credential: a "tenant-unique Employee/Seller Code"; QR or badge later.
- "Attribution is not authentication": a code never authorizes refunds, approvals or drawer access.
- Offline: accept only a known active employee in the trusted cached staff set; unknown or out-of-scope codes fail closed.
- The code is unique per tenant and survives store moves; store assignments decide where it is valid.
- Reporting preserves employee, store and role at transaction time.

**§9 Sales performance, discounts and returns.**

- Each line keeps Gross, Discount and Net; performance aggregates by line seller.
- Automatic promotions are not the seller's discretionary discount. Manual discounts keep requester, actor and approver.
- Cart-level discounts are allocated to lines by the pricing engine first; no blind seller-level percentage split.

**§10 Commission baseline.**

- Business-configurable, may vary by product, category or other approved dimensions, on the same line-level attribution.
- Accrued at sale time; a return creates a reversal or adjustment, never a rewrite.
- Period cycle: accrue, apply returns and corrections, close, review summary, then approved payout or payroll integration.
- Managing commission policy is a distinct, scoped capability with sensitivity-based approval.
- Policy changes are effective-dated and "not retroactive by default"; historical corrections use an audited adjustment workflow.

**§20 (interaction).** Commission is based on line-level net after promotion allocation; returns create reversal or adjustment. ERPNext "is not promotion authority" and receives finalized facts through Backend-Core and the Connector.

## 3. Current state on `origin/main` (Official First inventory)

### 3.1 Backend-Core: who is on a sale today

| Fact | Where it lives | Notes |
|---|---|---|
| Transaction Operator | `sales.created_by UUID NOT NULL` (`services/backend-core/packages/db/drizzle/0012_sales.sql`, `sales` table) | On the device path the server sets it from `CaptureSaleRequest.operatorUserId` after checking a `cashier_admissions` window (`packages/contracts/openapi/pos-sales/sales.yaml`, `operatorUserId`, around line 2768). On the envelope path it is the envelope principal. Body-supplied actor fields are otherwise never accepted (`sales.yaml` header) |
| Terminal | `sales.device_id` (`0033_sale_tenders.sql`, RT-77) | Null for sales before RT-77 |
| Receipt operator name | `sales.receipt_operator_display_name` (`0047_sale_history_capture.sql`) | A printed snapshot, not an identity |
| Lines | `sale_lines` (`0012_sales.sql`, extended by `0047`, `0089`) | `unit_price`, `quantity`, `line_amount` (net), `tax_amount`, `tenant_product_ref`, `line_seq`, tracking columns. **No seller column** |
| Promotion facts per line | `sale_line_promotions` (`0101_offer_engine.sql`, line 804) | `offer_id`, `offer_version`, `pack_revision`, `discount_amount`: the automatic-promotion part of §9 is already frozen per line |
| Manual discount per line | `CaptureSaleLineDiscount` (`sales.yaml` line 3110) | Kind, value, reason, `authoritySource`, `approverRole`, `approverUserId` are **validated and hashed but not stored** (the schema description says so). Only net `line_amount` is kept. This is a §9 gap |
| Tenders | `sale_tenders` (`0033_sale_tenders.sql`, `0041`, `0099`) | `method`, `amount`, `reference`, `redemption_id`. **No receiver column** |
| Returns | `sale_returns.created_by`, `sale_return_lines`, `sale_return_promotion_clawbacks` (`0032`, `0101`) | The return operator is recorded; return lines reference the original lines, so a later reversal can find the original line seller |
| Void approver | `RecordVoidRequest.approval` / `VoidApproval.approverUserId` (`sales.yaml` around line 3404), `0046_sale_void_approval.sql` | Approver per action already exists |
| "Seller" today | `apps/api/src/catalog/sales/credit-sale-reversal.checks.ts` lines 126, 174, 269, 285; `credit-sale-reversal.service.ts` line 167 | `sellerUserId = sales.created_by`; the approver of a credit reversal may not be that user |
| Drawer | `shifts.opening_cashier_user_id`, `opening_device_id` (`0002_shifts.sql`) | No custodian-transfer or handover record; `pos-shifts.openapi.yaml` has open, cash movement, close, force-close, stuck only. The sale row has no `shift_id` |
| People | `users`, `memberships` (`0000_initial.sql` line 151: `role_id`, `store_access_kind`, revoke/delete timestamps), `store_access`; `console-people.openapi.yaml` (`listPeopleNames`, 1.0.0-draft) | **No employee or seller code column anywhere** in the migrations |
| Staff roster to the till | `posListCashierAdmissionRoster` (`pos-cashier-admissions.openapi.yaml` line 370, device auth, "the cashiers of the device's store"); `posOperatorRoster` (`pos-operators.openapi.yaml` line 181, operator-identity) | The reusable channel for a trusted cached staff set (§8 offline). Today it carries cashiers only |
| Commission | none | `git grep -i commission` finds no Backend-Core, POS, Console or Connector code |

### 3.2 POS

- The capture payload sends `operatorUserId` from the cashier admission; cashiers sign in with a locally verified PIN (`pos-cashier-admissions.openapi.yaml` header).
- `attribution_operator_id` in `apps/pos/src/main/cart/cart-bridge.ts` and `cart_action_outbox` is the **manager attribution for an approval** (RT-183, RT-443), not seller attribution.
- Operator takeover exists (`posOperatorTakeoverConfirm`), which is the §6 quick operator switch at the operator level; there is no drawer-custody transfer.
- No seller selection, seller code entry or per-line seller in `apps/pos/src`.

### 3.3 Admin Console

- `apps/admin-console/src/people/`, `operators/`, `shift-closes/`, `sales/`, `sales-by-store/`, `reports/` exist. None shows a seller, seller code or commission. The shift-close views already label an approver as "attribution only" (`shift-closes/ShiftCloseList.tsx` line 14).

### 3.4 ERPNext-Connector

- No mapping of `sales_team`, Sales Person, Sales Partner or commission (`git grep` in `integrations/erpnext-connector` finds only DocType `owner` metadata).
- Each Retail Tower sale posts as **exactly one submitted Sales Invoice that carries its own payments** (`services/backend-core/specs/011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-record.md`, around lines 45–52). The record's "Superseded for POS sale settlement" note replaced the earlier target of a Sales Invoice plus a separate Payment Entry. This matters: a per-sale Sales Team projection is representable, because there is no consolidation.

### 3.5 ERPNext v16 official capabilities (docs.frappe.io, checked 2026-11-23)

- **Sales Person** is a tree master with a stored Commission Rate per person (docs: "Sales Person").
- **Sales Team** is a child table on Quotation, Sales Order, Delivery Note and Sales Invoice. Each row has a Sales Person, a contribution percentage of the document **net total**, a contribution amount, the commission rate (fetched from the person) and incentives (docs: "Add Sales Persons to Sales Transactions", "Calculate Incentive For Sales Team").
- ERPNext computes incentive as contribution to net total × the person's rate ÷ 100. The incentive field is a transaction-level recorded value for reports; the docs describe no automatic GL posting of incentives.
- **Sales Partner** commission is for external partners, settled through a Supplier (docs: "Sales Partner Commission"). Not relevant to staff.
- Payout through Frappe HR (Additional Salary, payroll) is **not verified** here; RT-1197 owns workforce and payroll planning.

**Fit against §8–10.** ERPNext represents attribution per invoice (percent of net total), not per line, and one rate per person, not per product or category. It has no effective-dated commission policy, no return-driven reversal ledger and no period close for incentives. §9 explicitly rejects a seller-level percentage split as the basis. So ERPNext Sales Team **cannot be the source of truth** for Retail Tower commission. It can receive a derived projection.

## 4. Options and recommendations

### T1 — Who is a Seller (identity)

| Option | Description | Assessment |
|---|---|---|
| **S-a (recommended)** | A Seller is a tenant **member** (`users` + `memberships`). Add `seller_code` to the membership, unique per tenant among non-deleted memberships; store validity comes from existing `store_access` | REUSE + EXTEND. One identity for login, PIN and attribution; satisfies "retained when the employee changes stores" because memberships are tenant-level. Needs a `[GATED: migration]` and a `[GATED: contract]` |
| S-b | A separate `staff` / employee master without login, linked optionally to a user | BUILD. Second people model, competing source of truth with memberships, more Console surface. Only justified if non-login sellers are common |
| S-c | Use ERPNext Sales Person / Employee as the master | Violates Policy §22 (ERPNext is not authority for seller attribution) and needs the POS to depend on ERP data |

Recommendation: **S-a.** A non-login seller is still a member with a store-staff role and no provider identity, which the cashier path already supports (cashiers hold no provider JWT).

### T2 — Attribution model (which facts, where)

| Fact | Recommendation | Storage (proposal for the gated follow-up) |
|---|---|---|
| Transaction Operator | Keep `sales.created_by` as is | none |
| Seller per line | New, required per line when present; inherited from a sale-level primary seller on the till | `sale_lines.seller_user_id` (nullable for pre-feature sales) plus a frozen `seller_store_id` and a frozen role/scope snapshot at transaction time (Policy §8: employee, store and role at sale time); `CaptureSaleLine.sellerUserId` (optional, additive). The snapshot's exact shape is an open point for F-1 |
| Payment Receiver per tender | New, defaults to the operator; explicit "different receiver" only | `sale_tenders.received_by_user_id` (nullable = operator); `CaptureSaleTender.receivedByUserId` (optional, additive) |
| Approver | Keep per action (void, credit reversal, discount) | existing |
| Drawer Custodian | W6 (RT-6), not RT-285 | none here |
| Post-finalization correction | Append-only `sale_line_attribution_corrections` (old seller, new seller, reason, actor, approver, time); reports read the latest correction | new table, `[GATED: migration]` |
| Policy version | Sales freeze the `policy_version` they ran under once AD-POL-001 PE-BC2 exists (AD-POL-001 P-E) | dependency |

Rejected: a single `sales.seller_user_id` (cannot express Multiple Sellers or same-SKU splits), and reusing `created_by` as seller (collapses two §6 facts).

The server validates each `sellerUserId` the same way it validates `operatorUserId` today: same tenant, membership active at `occurredAt` (with the existing clock tolerance), store access to the sale's store. A refused seller is a 4xx with nothing recorded, so the till must not finalize with an unvalidated offline code it could not have trusted (see T3).

### T3 — Seller code capture at the till

| Option | Description | Assessment |
|---|---|---|
| **C-a (recommended)** | Extend the device-authenticated roster read (`posListCashierAdmissionRoster`, or a sibling `posListSellerRoster` with the same auth) to return the store's eligible sellers: `userId`, `sellerCode`, display name, active window. The till caches it (DPAPI-sealed, as other offline sets), resolves a typed or scanned code locally and sends only `sellerUserId` | REUSE the existing channel and offline machinery; EXTEND its payload. Unknown or out-of-scope code fails closed (§8). Staleness follows an AD-POL-001 policy entry, `standard` tier, `deny_if_stale` recommended with 72 h ceiling |
| C-b | Live lookup per code | Fails offline; §8 requires an offline path |
| C-c | Free-text code sent to the server and resolved there | Lets the till finalize with an unknown code, then the sale is refused or quarantined at sync. Rejected |

UX rules for the POS follow-up (`ux-pos-console`, Arabic-first RTL): seller entry never blocks scanning; a primary-seller chip on the cart header; per-line seller only in Multiple Sellers mode; bulk reassign of selected lines; a same-SKU add with a different seller creates a new line; the finalize button shows the missing-seller count when the store requires a seller. The screens themselves need a design brief before implementation (owner-approved UX Constitution applies); this record does not design them.

"Attribution is not authentication": the seller code never unlocks a session, approves an action or opens a drawer. It is not a PIN and must not be stored or logged as a secret, but it is personal data in logs: log `userId`, not the code.

### T4 — Checkout modes and the requirement switch

Recommendation: implement modes as **policy entries** under AD-POL-001 rather than a bespoke setting table: `checkout.attribution.mode` ∈ {`hybrid`, `dedicated_cashier`} (tenant default, store override, `within_bounds`), `checkout.seller.required` (boolean, default false), `checkout.seller.multiple_enabled` (boolean). Until PE-BC2 exists, a narrow interim store like AD-CASH-001's is acceptable only with an owner decision (OQ-3); otherwise the POS follow-up ships Hybrid with seller optional as a fixed default.

### T5 — Commission computation: where it lives

| Option | Description | Assessment |
|---|---|---|
| **K-a (recommended)** | **Backend-Core** commission module: effective-dated commission rules (percent of line net by product, category, store; owner-configurable), an append-only **accrual ledger** written when a sale is captured (one row per attributed line), **reversal rows** when a return line is recorded (proportional to the returned net, using the original rule version), **adjustment rows** for audited corrections, and **periods** (open → closed → approved). Approved period totals are sent through the Connector as an accounting document | Backend-Core owns operational facts (Policy §22). The ledger is an operational sub-ledger of *amounts owed to staff*, not a GL: no accounts, no double entry, no tax. ERPNext keeps the accounting effect. Meets §10 accrual, reversal, cycle and effective dating, which ERPNext does not |
| K-b | ERPNext Sales Team only: map sellers to Sales Persons and let ERPNext compute incentives | Cannot express line-level attribution, per-product rates, effective dating, return reversal or period close. Makes ERPNext a commercial authority, against §22 |
| K-c | K-a plus a per-sale **Sales Team projection** on the posted Sales Invoice (contribution % = seller's share of the invoice line net, incentives = the Backend-Core accrued amount) | Optional, later. Possible because posting is 1:1 per sale. Gives ERPNext-native salesperson reports without making ERPNext the authority. Adds Connector mapping (Sales Person per seller) and a reconciliation duty |

**Accounting boundary (no duplicated accounting engine).** Accrual rows are not journal entries. When a period is approved, the Connector posts the accounting effect in ERPNext. The document (Journal Entry for a commission expense and payable, or a Frappe HR Additional Salary) is decided in the Connector follow-up after an official-docs check, and RT-1197 decides payroll. Until then, approved periods are a report and an export only.

**Commission-policy authority.** `commission.policy.configure` and `commission.period.approve` are separate capabilities (AD-POL-001 Q11 pattern, configure ≠ approve). Recommended tier: `sensitive` with `approval_required` governance for policy changes; they are Console-only actions, so the offline mode is moot (online by nature).

### T6 — Performance facts (§9)

- Gross per line is derivable today as `unit_price × quantity`; net is `line_amount`; automatic-promotion discount is `sale_line_promotions.discount_amount`. Manual discount is derivable only as a residual, with no kind, reason or approver. §9 needs the manual discount stored with its actor and approver, and kept apart from promotions. That is the drafted follow-up F-7, in the RT-740 lineage.
- Cart-level discounts: the offer engine already allocates to lines (`sale_line_promotions` per line); seller aggregation reads line facts. No seller-level split.

## 5. Owner questions (with recommended answers)

| # | Question | Recommended answer |
|---|---|---|
| OQ-1 | Is a Seller always a tenant member (login or PIN-only), with the Seller Code on the membership? | **Yes (S-a).** No separate employee master in V1 |
| OQ-2 | Record seller per line and receiver per tender as new facts, leaving `created_by` as the Transaction Operator? | **Yes.** |
| OQ-3 | Which modes ship first, and is seller required by default? | **Hybrid (system default) and Dedicated Cashier; seller optional by default.** Modes as AD-POL-001 policy entries; if PE-BC2 is not ready, ship a fixed Hybrid/optional default rather than an interim settings table |
| OQ-4 | Offline seller-code validation through an extended device roster, `deny_if_stale` with a 72 h ceiling? | **Yes.** Unknown or out-of-scope codes fail closed |
| OQ-5 | Does the credit-reversal four-eyes rule (`approver ≠ sellerUserId`) stay bound to the operator? | **Yes.** Rename the internal field to `operatorUserId`; optionally also forbid approver = line seller later, as its own decision |
| OQ-6 | Commission computed and ledgered in Backend-Core, with ERPNext receiving only approved accounting effects? | **Yes (K-a).** Sales Team projection (K-c) deferred until a reporting need is stated |
| OQ-7 | Which commission dimensions in V1? | **Percent of line net by product category, with a tenant default and a store override.** Product-level and tiered/target schemes later. Rates are the owner's to set |
| OQ-8 | Store the manual discount's kind, reason, requester and approver on the sale line? | **Yes, as its own issue in the RT-740 lineage** (F-7); RT-285 only records the gap |
| OQ-9 | Drawer custodian and formal handover: who owns them? | **W6 (RT-6)**; RT-285 records the dependency only |
| OQ-10 | Are attribution and commission pilot scope? | **No.** RT-285 is fix version Post-Pilot; keep every follow-up Post-Pilot unless the owner promotes one |

## 6. Risks

- **Naming collision.** "Seller" already means the operator in credit-reversal code. Without OQ-5 and a pinning test, adding a real seller can silently change a four-eyes rule.
- **Contract growth on a hot path.** `captureSale` is idempotent and hashed. An absent optional field leaves the hash unchanged, and `operatorUserId` is deliberately excluded from the hash (`sales.yaml`, around line 524). F-1 must decide whether `sellerUserId` and `receivedByUserId` are hashed, with `operatorUserId` as the precedent for excluding them. Old tills must keep working (additive only; oasdiff green).
- **Offline trust.** A stale staff set can attribute to someone who left. `deny_if_stale` plus server revalidation at sync limits the damage; a refused seller at sync must have a defined quarantine path (re-use `sale-quarantine.yaml` kinds or add one, decided in F-1).
- **Commission correctness is money.** Reversal on partial returns with net that does not divide evenly (the 2.99 / 3 case in `sales.yaml`) needs exact-decimal rules and tests before any payout.
- **Policy-engine dependency.** Modes and capability tiers assume AD-POL-001 PE-BC1/PE-BC2. If they slip, the POS work must ship with fixed defaults, not a competing settings store.
- **Personal data.** Seller codes and per-employee performance are personal data; Console reads need role scoping and the AI manager surfaces must not expose individual commission without a decision.
- **Scope creep into payroll.** Payout belongs to RT-1197; the Connector follow-up must not design payroll.

## 7. Dependencies

- AD-POL-001 PE-BC1 / PE-BC2 (capability catalogue, policy entries, `policy_version`) for modes, the requirement switch and commission capabilities.
- RT-6 (W6) for drawer custodian and handover.
- RT-740 lineage for stored manual-discount attribution (F-7) before commission excludes or includes manual discounts by rule.
- RT-1197 for payroll payout.

## 8. Drafted follow-ups (NOT created in Jira)

Shaped to the OS §4A contract: one Work Mode, one product directory, bounded scope, explicit exclusions, acceptance criteria, dependencies, gated surfaces and the Official-first short form. All are **Post-Pilot** unless the owner promotes them. Order: F-1 → F-2 → (F-3, F-4) → F-5 → F-6 → F-8; F-7 is independent.

### F-1 — Backend-Core: seller per line and receiver per tender, contract and migration `[GATED: contract] [GATED: migration]`

- **Work Mode:** Implementation. **Product dir:** `services/backend-core/`.
- **Scope:** `memberships.seller_code` (tenant-unique among non-deleted rows, format and length decided in the contract); `sale_lines.seller_user_id`, `seller_store_id` and a frozen role/scope snapshot at transaction time (Policy §8; F-1 decides its exact shape); `sale_tenders.received_by_user_id`; optional additive `CaptureSaleLine.sellerUserId` and tender `receivedByUserId` in `pos-sales/sales.yaml`; server validation (tenant, membership active at `occurredAt`, store access); `readSale` / history return the new facts; rename `sellerUserId` to `operatorUserId` in `credit-sale-reversal.*` with a test pinning the four-eyes rule to `created_by`.
- **Exclusions:** no POS or Console change; no commission; no correction events (F-2); no Connector change.
- **Acceptance:** oasdiff additive only; migration round-trip and RLS tests; a sale without the new fields behaves exactly as today; a seller from another tenant, a revoked member or a member without store access is refused with nothing recorded; Jest db-integration tests cover each refusal.
- **Dependencies:** OQ-1, OQ-2, OQ-5 decided.
- **Official-first:** ERPNext Sales Person reviewed (§3.5), not authority per Policy §22. Existing: `users`, `memberships`, `operatorUserId` validation. Decision: EXTEND.

### F-2 — Backend-Core: post-finalization attribution corrections `[GATED: contract] [GATED: migration]`

- **Work Mode:** Implementation. **Product dir:** `services/backend-core/`.
- **Scope:** append-only correction events per sale line (old seller, new seller, reason code, actor, approver), a Console write endpoint behind a capability, an audit event; reads resolve the effective seller.
- **Exclusions:** no change to the original sale row; no commission recalculation (F-5 consumes the events).
- **Acceptance:** a correction never updates `sale_lines`; requester ≠ approver; tenant isolation tests.
- **Dependencies:** F-1; AD-POL-001 capability or a role fallback decided by the owner.
- **Official-first:** no native equivalent; follows the existing immutable-fact pattern (`sale_responsibilities` INSERT-only). Decision: EXTEND.

### F-3 — Backend-Core: seller roster for the till `[GATED: contract]`

- **Work Mode:** Implementation. **Product dir:** `services/backend-core/`.
- **Scope:** extend `posListCashierAdmissionRoster` or add a device-authenticated sibling returning the store's eligible sellers (`userId`, `sellerCode`, display name, validity), ETag/304, minimum disclosure.
- **Exclusions:** no PIN or credential data; no policy bundle.
- **Acceptance:** device-scoped only; cross-tenant and cross-store negative tests; revoked members disappear on the next fetch.
- **Dependencies:** F-1.
- **Official-first:** reuses the existing device roster channel. Decision: EXTEND.

### F-4 — POS: seller capture at checkout (Hybrid, optional seller)

- **Work Mode:** Implementation (after a UX brief). **Product dir:** `apps/pos/`.
- **Scope:** cache the seller roster (sealed), resolve codes locally, primary seller with line inheritance, Multiple Sellers mode, same-SKU split, payment-receiver override, send `sellerUserId` / `receivedByUserId`; scanning never blocked; fail closed on unknown or stale codes.
- **Exclusions:** no seller authentication; no commission display; no drawer custody.
- **Acceptance:** Vitest coverage of resolution, staleness and fail-closed paths; outbox payload carries the new fields; the renderer cannot assert a seller id the main process did not resolve (RT-183 pattern); a packaged-till check is named as `coverage-evidence` if needed.
- **Dependencies:** F-1, F-3, owner-approved UX brief (`ux-pos-console`).
- **Official-first:** no ERPNext POS reuse (reference only, repo `CLAUDE.md` §4). Decision: EXTEND.

### F-5 — Backend-Core: commission rules, accrual ledger and periods `[GATED: contract] [GATED: migration]`

- **Work Mode:** Implementation. **Product dir:** `services/backend-core/`.
- **Scope:** effective-dated rules (percent of line net by category, tenant default, store override); accrual on capture; reversal on return lines using the original rule version; adjustments from F-2 corrections; periods open → closed → approved; Console reads and writes behind `commission.policy.configure` and `commission.period.approve`.
- **Exclusions:** no ERPNext posting (F-6); no payroll; no target or tiered schemes.
- **Acceptance:** exact-decimal tests including partial returns of uneven nets; rule changes never alter past accruals; requester ≠ approver on period approval; idempotent accrual on capture retry.
- **Dependencies:** F-1, F-2, OQ-6, OQ-7 and the owner's commission policy.
- **Official-first:** ERPNext Sales Team incentives reviewed (§3.5): invoice-level, one rate per person, no reversal ledger. Frappe HR incentive and Additional Salary features were not reviewed here and are deferred to RT-1197; they are NEEDS VERIFICATION before the BUILD is approved. Existing: none. Decision: BUILD (justification §3.5 and T5; owner approval required).

### F-6 — ERPNext-Connector: commission accounting effect (and optional Sales Team projection)

- **Work Mode:** Planning first, then Implementation. **Product dir:** `integrations/erpnext-connector/`.
- **Scope:** choose the ERPNext document for an approved period (Journal Entry vs Frappe HR Additional Salary) from official v16 docs; optionally map sellers to Sales Persons and post a per-invoice Sales Team projection.
- **Exclusions:** no commission computation in the Connector or ERPNext; no payroll design (RT-1197).
- **Acceptance:** decision record with official doc links and versions; idempotent posting with a posting log; ERPNext never recomputes amounts.
- **Dependencies:** F-5; RT-1197 for payroll.
- **Official-first:** to be completed in the Planning step. Decision: NEEDS VERIFICATION.

### F-7 — Backend-Core: store manual-discount attribution on the sale line `[GATED: migration]`

- **Work Mode:** Implementation. **Product dir:** `services/backend-core/`. Lineage RT-740 / RT-28, not RT-285 scope.
- **Scope:** persist the already-validated `CaptureSaleLineDiscount` fields (kind, value, amount, reason code, authority source, approver role and user) and return them in `readSale` and history.
- **Exclusions:** no new discount rule; no POS change.
- **Acceptance:** existing payload hash unchanged; round-trip tests; old sales read as "not recorded".
- **Dependencies:** OQ-8.
- **Official-first:** Not applicable — no new capability (stores an existing contract field). Decision: EXTEND.

### F-8 — Verification: attribution and commission end to end

- **Work Mode:** Verification. **Product dirs:** `apps/pos/`, `services/backend-core/`, `apps/admin-console/` (read-only checks).
- **Scope:** packaged till sells with Hybrid and Multiple Sellers, offline with a cached roster, a stale roster, an unknown code; sync; Console shows seller and receiver; a partial return reverses commission; a correction adjusts it.
- **Exclusions:** no fixes; defects become new issues.
- **Acceptance:** evidence per scenario on the lab tenant.
- **Dependencies:** F-1 to F-5 merged.
- **Official-first:** Not applicable — no new capability.

An Admin Console follow-up (seller code management on the people screen, commission rules and period review) is expected after F-1 and F-5; it is not drafted here because its UX brief and the AD-POL-001 PE-AC1 template picker decide its shape.

## 9. What this record does not do

- It does not set commission rates, payout schedules or payroll treatment.
- It does not change any contract, migration, code, CI or Jira status.
- It does not decide drawer custody or handover (W6).
- It does not claim any of the proposed behaviour exists on `main`.
