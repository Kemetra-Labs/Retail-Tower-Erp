# Plan 047 — Receipt details owned by the store record (decision record)

| | |
|---|---|
| **Jira** | RT-1317 (parent RT-5). Split out of RT-1316 (owner pairing UX discussion, 2026-11-10) |
| **Work Mode** | Planning. This file and [`contract-proposed-diff.md`](contract-proposed-diff.md) are the deliverable. No code, OpenAPI, migration, package or CI change |
| **Canonical copy** | Confluence RETAIL: [decision record, page 72450053](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/72450053) and [contract draft, page 73334785](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/73334785). This file mirrors decision record v5, plus the review fixes of this PR (§4 item 3, §5, §6, OD-9), which are newer than the Confluence copy |
| **Baseline** | `Kemetra-Labs/Retail-Tower-Erp` `origin/main` @ `134fbb70f` (2026-11-10). Re-checked at `9a7a69bda`: the two newer commits touch none of the cited contracts or migrations |
| **Status** | **Owner decisions OD-1 to OD-8 recorded (2026-11-10). Fiscal Q3, Q5, Q6 and Q7 recorded. OPEN: Fiscal Q1, Q2 and Q4 (until verified under RT-296), and OD-9 (tenants with more than one tax id, §6).** No implementation issue exists yet; each needs an owner go-ahead |

## 1. Problem, as found on main

- The Console issue form asks for the store name on receipts, the address and the tax registration id
  every time (`apps/admin-console/src/devices/IssueFields.tsx:174-201`, the "binding" fieldset).
- `consoleIssuePairingCode` requires `branchName`, `branchAddress` and `taxRegistrationId`
  (`devices.openapi.yaml` 1.7.0-draft, `PairingCodeIssueRequest`). Its description says Backend-Core holds
  no store address or tax registration.
- The values are copied onto the `pairing_codes` row (migration `0024`, NOT NULL, non-blank).
  `posPairTerminal` returns them from that row (`pairing.service.ts` `bindingOf(code)`), and the till pins
  them in its single-row `terminal_assignment` table (`apps/pos/src/main/pairing/store.ts`). Nothing updates
  them after pairing.
- Backend-Core has no column for them: `stores` has `id, tenant_id, code, name, is_active, timezone` and
  soft delete; `tenants` has `slug, name, status, default_currency_code`. There is no Legal Entity table.

Result: two tills in one store can print different names, addresses or tax ids; the admin re-types the
same data per till; a correction never reaches tills that are already paired.

**Already true and kept (verified on main):** each sale carries its own snapshot. The POS `sales` table has
NOT NULL `branch_name`, `branch_address`, `tenant_tax_registration_id` (POS migration `0020`), read from
`terminal_assignment` at finalize (`finalize-dispatch.ts`) and stored by `finalize-transaction.ts`. The capture body sends them
(`capture-payload.ts`), and Backend-Core stores them as `sales.receipt_branch_name`,
`receipt_branch_address`, `receipt_tax_registration_id` (migration `0047`). The receipt is derived from the
sale row (`receipts-payload.ts` `deriveReceiptPayload(row: SaleRow)`) and the history slip from the sale's
own header (`sale-history-slip.ts`). Reprints and history never read the current details.

## 2. Authority rules relied on

- Root `CLAUDE.md` §4: POS and Admin Console never call ERPNext; Backend-Core is the contract boundary; the
  Connector is the only ERPNext adapter.
- Root `CLAUDE.md` §5: ERPNext must not silently override Retail Tower store data; POS consumes only what
  Backend-Core resolves.
- [Organization & Store Management Product Architecture](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/23625729)
  (owner-approved 2026-10-07):
  - 162: a Tenant need not be one legal company.
  - 163: a Legal Entity is a separate legal and accounting identity.
  - 164 and 172: a Brand is not a Legal Entity.
  - 165: a Store is a selling unit.
  - 168: store names are mutable and a rename does not rewrite history.
  - 170: Legal Entity assignment is effective-dated.
  - 171 and 233: the Legal Entity maps to the ERP Company explicitly.
  - 208 and 210: the store operational address is separate from the legal registered address and can change.
  - 266 to 270: the server validates, audits and detects conflicts.
- [Fiscal & Tax Product Architecture](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/24084489),
  decisions 1248 (Egypt values belong to the Country Pack), 1252 (ETA enrollment is Legal-Entity-specific),
  1259 (offline regulatory revocation gap) and 1270 (Fiscal Ready is scoped per Legal Entity).

## 3. Ownership decision

| Field (wire name today) | Owner (decided) | Why |
|---|---|---|
| Store name on receipts (`branch_name`) | **Store: reuse `stores.name`** (OD-1, option 1a) | The Store is the selling unit (165); the name is already edited on the Console Stores screen. A rename affects future receipts only (168). Rejected: 1b, a separate `receipt_name` override. |
| Address (`branch_address`) | **Store: new `stores.address`** (OD-2) | Decision 208: the store operational address lives on the Store, separate from the Legal Entity registered address. Past receipts keep theirs through the per-sale snapshot. |
| Tax registration id (`tenant_tax_registration_id`) | **Legal Entity, minimal (OD-3, option 3A)** | The tax id identifies the taxpayer, a legal entity: not a tenant (162) and not a store (165). One `legal_entities` row per tenant in V1, with `stores.legal_entity_id` pointing to it, edited in the Console as "Business details". Rejected: 3B, a tenant column (against 162); 3C, a store column (wrong owner, and it brings back drift). |

**ERPNext boundary.** ERPNext `Company.tax_id` and branch data are never read to fill receipts, and the
Connector never writes these fields back. Today the Connector posts with the site default Company (RT-378,
`compatibility_glue.py`). A later readiness warning compares the Legal Entity tax id with the mapped ERP
Company `tax_id` (Fiscal Q7). It is a warning, never an override.

## 4. Propagation

1. **One resolved "receipt profile" per store.** Backend-Core resolves `{store_name, address,
   tax_registration_id}` from the store and its Legal Entity. Its version is the SHA-256 of the canonical
   resolved values, so any source change changes it (the tenant-branding precedent, spec 039).
2. **Pair time.** `posPairTerminal` keeps its response shape and takes the three values from the resolved
   profile at consume time, not from the code. Only when the store profile is incomplete does the consume
   fall back to the code's own snapshot. Only codes issued before the cutover, or by the owner-run
   bootstrap CLI, can reach that fallback.
3. **Precondition.** Issuing a code requires a complete profile; otherwise
   `409 store_receipt_details_incomplete` lists what is missing. Once set, the profile fields cannot be
   cleared. A profile is complete only when the store is linked to a Legal Entity that has a tax id, the
   address is set, and `stores.name` fits the receipt wire limits (not blank, at most 256 characters, as
   the pair, refresh and capture bodies require). Today `stores.name` has no such bound: the DTO, contract
   and DB only require one character. So a too-long or blank name makes the profile incomplete
   (`missing: store_name`) instead of breaking capture later. Slice 1 may also tighten `StoreCreate` and
   `StoreUpdate` `name` to 1..256 non-blank; that is a breaking request change (oasdiff entry), and the M-B
   report lists existing names outside the bound. Only an owner or tenant admin can fix an incomplete
   profile (`updateStore` and the Legal Entity API are theirs), while a store manager can issue codes. The
   Console tells a store manager who hits the 409 to ask an admin.
4. **Refresh for paired tills (OD-4).** A new device read, `posGetStoreReceiptProfile`, uses ETag and
   If-None-Match (304 when unchanged). The till calls it at start and hourly, like the branding read-down,
   and updates the three `terminal_assignment` columns in place. That is safe because the sealed device
   token binds only `tenant_id`, `branch_id`, `terminal_id` and `paired_at` (`token-binding.ts`). On any
   failure the till keeps its last copy.
5. **Snapshot rule.** A sale prints and stores the details its till held at finalize. An edit never
   rewrites a local or captured sale, a reprint or a history slip. Backend-Core does not validate a
   captured snapshot against the current profile, because offline sales legitimately carry older details.
6. **Speed.** An online till picks up an edit within about an hour; an offline till does so when it
   reconnects. A build without the refresh client keeps its pair-time details until it is updated or
   re-paired (OD-6). The Console store screen says so.
7. **New stores and tenants.** Tenant creation creates the tenant's Legal Entity. `createStore` links the
   new store to it on the server; clients never send `legal_entity_id` in V1.
8. **Code-row write in stage 1.** The per-code columns stay NOT NULL until M-C. The server writes the
   store's resolved profile into them at issue time, never the deprecated request values.
9. **Tax-id change during a shift (Fiscal Q3).** A tax-id change is refused while any shift is open at a
   store of that Legal Entity (`409 legal_entity_store_has_open_shift`, the decision 214 pattern). Only
   shifts the server knows about count: a shift opened on a till that has not synced is not seen, as with
   the time zone.

## 5. Compatibility posture

| Client | After the change |
|---|---|
| Paired POS builds on main today (no refresh client) | Work unchanged, with no wire change. They keep their pair-time details until updated or re-paired (OD-6). |
| POS builds with the refresh client | Converge within about an hour when online. |
| Admin Console builds that still send the three issue fields | Stage 1: the fields are accepted, deprecated and ignored, and an incomplete store gets a 409. Stage 3 removes them after the Console stops sending them (OD-5, the RT-1181 to RT-1184 pattern). |
| Owner-run bootstrap CLI (`packages/db/src/cli/bootstrap-pairing-code.ts`) | A third writer of the code columns. Until it changes, its codes carry typed values, used only when the store profile is incomplete. Slice 2 switches it to the store profile; slice 5 covers it for M-C. |
| Owner-run pilot bootstrap CLI (`packages/db/src/cli/bootstrap-pilot.ts`) | Inserts `tenants` and `stores` with raw SQL, so it bypasses §4 item 7. Slice 2 makes it create the tenant's Legal Entity and link its stores; until then a re-run of M-B links them. |
| ERPNext-Connector | Unaffected. |

## 6. Migration and backfill outline

Migration numbers are placeholders; the next free one on `main` comes after `0090`.

- **M-A, DDL only, additive.**
  - `CREATE TABLE legal_entities`: `id`, `tenant_id` FK, `legal_name` NOT NULL, `tax_registration_id` NULL
    (non-blank, at most 64), timestamps, `UNIQUE (tenant_id, id)` (the composite-FK target) and, in V1,
    `UNIQUE (tenant_id)`, so the backfill and tenant creation cannot make two entities for one tenant. A
    multi-entity release drops that constraint.
  - ENABLE and FORCE RLS, with tenant SELECT/INSERT/UPDATE policies on the empty-GUC CASE guard and no
    DELETE policy.
  - A grant-registry entry and a `docs/operations/sql/*-domain-grants.sql` deploy step.
  - `stores` gains `address TEXT NULL` (non-blank, at most 512) and `legal_entity_id UUID NULL`, with a
    composite FK `(tenant_id, legal_entity_id)` to `legal_entities (tenant_id, id)`.
  - The existing `stores_tenant_isolation` policy covers the new columns. A pre-existing gap, out of scope:
    it uses a bare `::uuid` cast with no empty-GUC guard.
- **M-B, backfill: a separate file, idempotent, re-run after deploy.**
  - It uses the FORCE RLS per-tenant GUC loop from `landing-gated-changes`. That loop is required because
    the `pairing_codes` policies have no platform-admin bypass.
  - Create one Legal Entity per tenant, named `tenants.name` (`INSERT ... ON CONFLICT (tenant_id) DO
    NOTHING`).
  - Link every store of the tenant: `UPDATE stores SET legal_entity_id = <the tenant's entity> WHERE
    legal_entity_id IS NULL`. This also links stores an old API or the pilot CLI created during rollout.
  - `tax_registration_id`: computed over **all pairing codes of the tenant** (every store, every status).
    Set only when they hold exactly one distinct trimmed value.
  - `stores.address`: computed **per store** over that store's codes. Set only when they hold exactly one
    distinct trimmed value.
  - Never overwrite a non-null value.
- **Conflicts (OD-7).** When codes disagree, the value is left unset and listed in a read-only report:
  each distinct value, the newest code date and what the captured sales printed. An admin confirms the
  details in the Console; until then the store cannot issue codes, and its paired tills keep their copy.
  The report also lists store names that are blank or longer than 256 characters (§4 item 3).
- **Tenants with more than one tax id (OPEN, OD-9).** If a tenant's codes hold several tax ids because
  its stores belong to different taxpayers (decision 162 allows that), "an admin picks one" would make
  some stores print the wrong tax id. V1 has one Legal Entity per tenant, so such a tenant is out of V1
  scope. Proposed: its stores stay blocked from new codes, and their paired tills keep their snapshot,
  until multi-entity support exists or the owner splits the tenant. This needs an owner decision (OD-9).
  Lab and pilot data have not been checked for such tenants.
- **M-C, later (stage 3).** The three `pairing_codes` columns become nullable and are no longer written.
  They stay as the audit of old codes.
- **POS local migration.** `terminal_assignment.receipt_profile_etag TEXT NULL`.
- **Rollback.**
  - M-A down drops the FK, the two columns and the table. Details entered after the change are lost, but
    nothing that existed before is lost: through the expand phase the codes keep their own values.
  - Roll the API back before running the down migration.
  - M-C waits until rollback is no longer expected.

## 7. Fiscal check (RT-4), answers recorded 2026-11-10

| # | Question | Answer |
|---|---|---|
| Q1 | One ETA registration number per company, or also a branch-level identifier? (Decision 1169 allows a branch binding; 1163 and 1196 leave Egypt routing open.) | **OPEN.** Verify under RT-296. No branch identifier is added until then; one would be a separate store field and does not change OD-3. |
| Q2 | Must the issuer name and address on an ETA e-receipt match the ETA-registered branch data? | **OPEN.** Verify under RT-296. Free-text entry stays the plan until then. |
| Q3 | Block a tax-id change during open shifts? | **Decided: block** (§4 item 9). |
| Q4 | May an unregistered Legal Entity print receipts without a Tax ID line? | **OPEN.** Verify under RT-296. The tax id stays required until then. |
| Q5 | Where is the format validated? | **Decided: the Country Pack** (decision 1248). Core stays permissive, 1 to 64 characters. |
| Q6 | Do frozen fiscal facts carry their own issuer identity? | **Decided: defer to RT-294.** `sales.receipt_*` stays the printed-receipt record. |
| Q7 | Warn when the tax id differs from the ERPNext Company `tax_id`? | **Decided: yes, a readiness warning**, as a later follow-up. ERPNext never overrides. |

## 8. Owner decisions (recorded 2026-11-10, answered in a Claude Code session)

| ID | Decision |
|---|---|
| OD-1 | Reuse `stores.name` as the receipt store name (1a). |
| OD-2 | Add `stores.address`. |
| OD-3 | A minimal Legal Entity owns the tax registration id (3A). |
| OD-4 | Paired tills refresh at start and hourly (ETag/304). |
| OD-5 | Retire the issue-code fields in stages. |
| OD-6 | Already-paired builds without the refresh client keep their pair-time details until updated or re-paired. |
| OD-7 | When backfill values conflict, an admin confirms them. |
| OD-8 | Yes to a follow-up so Devices can show tills holding stale receipt details (it touches the RT-1312 heartbeat). |
| OD-9 | **OPEN** (raised by the PR review). A tenant whose pairing codes hold more than one tax id: proposed out of V1 scope, stores blocked from new codes, paired tills keep their snapshot (§6). |

## 9. Proposed implementation slices (not created; each needs an owner go-ahead)

1. Backend-Core contract: stores, legal entities, the receipt-profile read, and the `devices` stage-1
   change. `[GATED: contract]`; consumers are repinned in follow-up PRs.
2. Backend-Core M-A, M-B, the runtime (tenant and store creation link the Legal Entity), the conflict
   report, and both bootstrap CLIs (`bootstrap-pairing-code.ts`, `bootstrap-pilot.ts`). `[GATED: migration]`
3. Admin Console: the store address, "Business details", and removing the binding fieldset from the issue
   form, after the RT-1316 Console work.
4. POS: the refresh client and the `terminal_assignment` ETag column.
5. Contract stage 3 and M-C.

Follow-ups also agreed: the OD-8 stale-till indicator and the Q7 readiness warning.

## 10. Acceptance criteria status

| RT-1317 AC | Status |
|---|---|
| 1. Owner of each field, with reasons | Decided (OD-1 to OD-3). |
| 2. OpenAPI contract draft | [`contract-proposed-diff.md`](contract-proposed-diff.md). Not applied to any live contract. |
| 3. Migration, RLS and rollback outline | §6. |
| 4. Fiscal & Tax position | Partly recorded: Q3, Q5, Q6 and Q7. **Q1, Q2 and Q4 are open** (RT-296). |
| 5. Owner approval before implementation | OD-1 to OD-8 approved; OD-9 open. Creating implementation issues needs an owner go-ahead. |
