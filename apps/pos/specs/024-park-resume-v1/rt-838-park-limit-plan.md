# RT-838 — Park limit: no default limit, configurable later (Planning)

**Jira:** RT-838, Work Mode **Planning**, cross-repo (POS, Backend-Core, Admin-Console).
**Status:** Plan. **No code, migration, contract file or UI is authorised by this document.**
**Date:** 2026-11-22. **Baseline:** `origin/main` = `510706c4d`.
**Supersedes:** spec 024 K2 "at most 5 parked sales per terminal" (amended in `spec.md` §11).
**Relates:** RT-439 (spec 024), RT-440 (PK-2), RT-441 (S6 manager recovery), RT-445 (PK-3 UI), RT-446 (PK-V).

## 0. Authority and labels

The owner decision of 2026-10-23 (RT-446 lab verification session, recorded in RT-838):

> By default there is **no limit** on parked sales per terminal. A limit can be configured later from the Console, per terminal or per tenant. This supersedes K2.

Every statement below carries one label, so nothing is mistaken for a decision it is not:

| Label | Meaning |
|---|---|
| **DECIDED** | The owner said it (2026-10-23, or an earlier ratified rule that this plan leaves unchanged). |
| **RECOMMENDED** | This plan's proposal. The owner has not chosen. Listed as a question in §10. |
| **EVIDENCE** | A fact read from `origin/main@510706c4d`, with its path. |

In `spec.md` §11 the same split is written **Decided** (= DECIDED) and **DRAFT, pending owner confirmation** (= RECOMMENDED). The owner's words were "per terminal or per tenant", so the tenant-level choice in §6 is a recommendation, not a decision.

Planning pages and this document are not proof of shipped behaviour: GitHub `main` is. RT-446 S2 (the 6th park refused on packaged build `e33fca25`) was **PASS against spec 024 as written** and stays valid history.

## 1. Official-first short form

```
Official capability / docs + version: none applies. The park limit is a Retail Tower
  operational rule (POS cart behaviour plus a Backend-Core tenant setting), not an
  ERPNext/Frappe, Electron or SDK capability. Verified absence: nothing in those platforms
  stores or enforces a held-sale count.
Existing Retail Tower implementation (origin/main):
  - the delivery pattern for a Backend-Core setting that a POS caches:
    services/backend-core/packages/contracts/openapi/cash-variance-policy.openapi.yaml
    (device-bearer read, ETag / 304, no maximum cache age, Console publish by
    owner / tenant_admin), services/backend-core/apps/api/src/cash-variance-policy/,
    apps/pos/src/main/cash-variance-policy/{policy-client,policy-cache,policy-service}.ts,
    apps/admin-console/src/cash-policy/ and src/lib/cash-variance-policy-queries.ts;
  - a second, contract-only precedent: return-policy.openapi.yaml (tenant-only, RT-1544).
Decision: EXTEND (planned, for the later slices). Reuse the delivery pattern; build no new
  mechanism. This PR itself is docs-only and builds nothing.
Why: the pattern already solves the hard parts (online read, cache, offline, re-pair, audit).
Safety: ERPNext untouched; Backend-Core stays the contract boundary; the POS never calls
  ERPNext; the limit is local and works offline; the contract slice is [GATED].
```

## 2. What exists today (EVIDENCE)

| Where | Fact |
|---|---|
| `apps/pos/src/shared/cart/park-types.ts:11` | `PARK_LIMIT_PER_TERMINAL = 5`; `park_limit_reached` is in `CART_PARK_REFUSAL_REASONS`. |
| `apps/pos/src/main/cart/park/park-service.ts:55-60` | `hasRoom(deps, at, adding, leaving)` = `countParked(scope) - leaving + adding <= PARK_LIMIT_PER_TERMINAL`. The count is per `(tenant, branch, terminal)`, every operator, stale ones included. |
| `park-service.ts:117` | `park` refuses `park_limit_reached` (audited as `cart.park_refused`). |
| `apps/pos/src/main/cart/park/resume-flow.ts:60` | A `current_cart: 'park'` swap calls `hasRoom(open.length, 1)`: the selected sale leaves first, so a full terminal can still swap. |
| `apps/pos/src/shared/audit/payload-schemas.ts:139` | The audited refusal `reason` union includes `park_limit_reached`. |
| `apps/pos/src/renderer/v5/park/park-copy.ts:23` | `PARK_COPY.limit` hard-codes «5». `ParkDialog.tsx:54-176` shows it, disables the park button and focuses «عرض المبيعات المعلّقة». |
| `apps/pos/src/main/shift-cashup/shift-cashup-service.ts:225,648-650` | `requireNoParkedSales` refuses the shift close with `parked_sales_present` and a count, whoever parked. `src/main/operator/forced-close-handler.ts` also reports parked sales as `close_blocked`. |
| `apps/pos/src/renderer/v5/park/ParkedSalesScreen.tsx`, `park.css:236-243` | The list (`.v5-park-list`) is already a scroll container (`overflow-y: auto`, `min-block-size: 0`) inside the panel. `listParked` returns every row with no paging. The badge in `ParkControls.tsx` prints the raw count. Nothing has been drawn or verified at more than 5 rows. |
| `apps/pos/src/main/recovery/manager-recovery.ts`, `src/main/ipc/recovery.ts` | The RT-441 manager recovery code is on `main`. `manager-recovery.ts:311,650` lists carts with `parked_at IS NOT NULL AS parked` (seen in review; the cancel path itself was not traced); RT-441 is Done in Jira and its title says "held and parked carts". |
| Tests that pin the limit | `tests/integration/main/cart/cart-park.test.ts:191`, `cart-resume.test.ts:394`, `park-copy.test.ts:44`, `park-dialog.test.tsx:102`. |
| Backend-Core | No park setting exists. A Jira search (2026-11-22) for park + limit / console / setting found only the Done park issues (RT-158, 439-446, 471, 610, 672) and RT-838 itself. No issue to point to. |

## 3. POS: no limit by default

**DECIDED.** When no limit is configured, parking is unbounded: `hasRoom` is always true and `park_limit_reached` can no longer be returned.

**RECOMMENDED shape (S1, §9):**

- Replace the constant with a limit source on the park deps: `parkLimit: () => number | null`, default `() => null`. `hasRoom` returns true when it is `null`. The seam also gives tests a way to exercise the configured path before the sync exists (S4).
- Keep `park_limit_reached` in `CART_PARK_REFUSAL_REASONS` and in the audit `reason` union. The closed category stays stable, and the configured-limit refusal (§4) needs it. No bridge or audit schema change in S1.
- Delete `PARK_LIMIT_PER_TERMINAL`. `park_label`, stale marker, revalidation and the K3/K4 rules are unchanged.
- S1 leaves `park-copy.ts` and the dialog untouched. With the default `null` the refusal is unreachable in a shipped build, so the «5» copy is dead until S4 replaces it. This keeps S1 free of an owner copy approval.

## 4. POS: a configured limit

**RECOMMENDED**, and mostly the existing behaviour:

- Count rule unchanged: per terminal, all operators, stale included (K2). A limit of `N` refuses a park when the count is already `>= N`.
- **Refusal copy.** Today «وصل هذا الجهاز إلى الحد الأقصى: 5 مبيعات معلّقة. استأنف بيعًا معلّقًا أو اطلب من المدير إلغاءه.» Two options:
  - **A (recommended): no number.** «وصل هذا الجهاز إلى الحد الأقصى للمبيعات المعلّقة. استأنف بيعًا معلّقًا أو اطلب من المدير إلغاءه.» One string; no bridge change.
  - **B: keep the number.** The refusal gains an additive `limit` field (`{ kind: 'refused', reason: 'park_limit_reached', limit: N }`), shown in Western digits. It needs a bridge type change and an addendum to the RT-440 A4 bridge-security review. A number is not an owner, label or amount, so the "no refusal names an owner, a label or an amount" rule still holds. **B reverses owner decision OD-5** (PK3-Spec.html, approved 2026-10-17: «بلا "x من 5" وبلا حقل جديد», no "x of 5" and no new bridge field), so it needs the owner to overturn OD-5; this strengthens A.
  - Either way the copy is owner-approved text (RT-471 OD process), and the frozen PK3-ParkLimit references show «5» (§9).
- Dialog behaviour is unchanged (park disabled, «عرض المبيعات المعلّقة» focused). Note the existing wrinkle: the count includes other operators' sales that this cashier cannot see; the copy already points to the manager for that case.

## 5. Spec 024 §3.4, swap-when-full

**DECIDED:** with no limit, a `current_cart: 'park'` swap never refuses for room, and the "full terminal can still swap" rule has nothing to do. **RECOMMENDED** for a configured limit:

1. Keep the rule "the limit is counted after the selected sale leaves the parked set", so a terminal at its limit can still swap one for one.
2. **New edge case: the limit is lowered below the current count** (8 parked, new limit 5). Today's `hasRoom(open.length, 1)` would refuse even a swap that leaves the count at 8. Rule: **a swap that does not increase the parked count is always allowed** (one open sale parked, one parked sale resumed); with more than one open draft the swap raises the count, so `count - 1 + open drafts` must fit the limit (`cart-resume.test.ts:394` already covers two open drafts at the limit); new parks are refused until the count is back under the limit; existing parked sales are never discarded or hidden (K4: no automatic expiry). Resume (no current sale) is never limited.
3. `current_cart: 'keep'` is unchanged (`current_cart_active`).

## 6. Where a configured limit lives

The owner said "per terminal or per tenant". Options, with the same enforcement point (the terminal counts locally):

| Option | What | For | Against |
|---|---|---|---|
| **A (recommended): tenant-level value, applied to each terminal** | One value per tenant. The count it limits is still per terminal. | Simplest (owner policy 2026-10-20: simplest sufficient). Matches return-policy V1 (tenant only). One Console field. No inheritance rules. | A tenant cannot give one till a different limit. |
| B: tenant default + store override | The cash-variance-policy shape (revisions, store override, stricter-wins resolution owned by Backend-Core). | Per-store tuning; the machinery exists. | Heavy for a non-monetary setting; "stricter wins" must be re-derived (a lower number is stricter); two Console screens. |
| C: per device (terminal) | A field on the `devices` row, edited from the Console device page. | Exactly "per terminal". | New write path on `devices`, a bigger Console surface, harder to keep consistent after a terminal is replaced or re-paired. |

A per-terminal or per-store override can be added later without breaking A, as an additive field with the nearest scope winning. **RECOMMENDED: A.**

**Value rules (RECOMMENDED, owner to confirm):** absent or `null` = no limit (the default); otherwise a positive integer. `0` is **not** accepted: "parking off" is a different feature, not a limit. A maximum (suggest 50) keeps the list usable (§8). The owner can return a tenant to "no limit" by publishing `null`.

## 7. Backend-Core contract, Admin-Console, sync-down

**Backend-Core contract. `[GATED: contract]`, planned only; no `openapi/*.yaml` is touched here.**

- A new small contract file (name for S2; for example `pos-park-policy.openapi.yaml`), draft, with each operation `x-runtime-status: contract-only` until the runtime lands, as return-policy does.
  - `posGetParkPolicy`: device bearer; tenant from the device row, no parameter; `ETag` / `If-None-Match` → `304`; body `{ limit: integer | null, policySource: 'system' | 'tenant', policyRevisionId, serverTime }`. The never-set System default is `limit: null`, a Backend-Core constant.
  - `consoleGetTenantParkPolicy`, `consolePublishTenantParkPolicy` (and a revision list if S2 keeps the cash-variance revision model): `cookieAuth` session only, roles `owner` and `tenant_admin`, `expectedRevisionId` concurrency token, the RT-430 `Origin` check, an audit row per change (actor, old and new value, no PII).
- A separate small read is recommended over adding a field to `cash-variance-policy`: different meaning, different owner screen. If a third POS setting appears, generalise to one "POS settings" read then, not now.
- A Backend-Core table and runtime are `[GATED: migration]`; a POS cache table is a second `[GATED: migration]` (§9, S3 and S4).

**Admin-Console setting (S5).** A "Parked sales" setting beside the cash-variance policy (`apps/admin-console/src/cash-policy/` is the precedent): a "No limit" default state and a numeric field, owner / tenant_admin only. The UI states plainly that a change reaches a terminal at its next online sign-in or shift open (see the sync-down notes just below). Layout is **not decided here**; S5 draws it per the Admin Console table and form rules before building.

**Sync-down, offline, and the default when nothing has synced (RECOMMENDED):**

- **When the POS reads it:** the same moments as the cash-variance policy (after pairing, at each online sign-in, before an online shift open), so there is one scheduling site and no new polling. A new limit therefore applies from the next such moment. A periodic refresh is an alternative (Q8).
- **Enforcement is local:** the park checks its local count against the cached limit. Park and resume stay offline-capable, as spec 024 §4.2 requires.
- **Offline:** the last cached value applies, with **no maximum age**, as `policy-cache.ts` does for the variance policy.
- **Nothing synced yet:** **no limit.** This is deliberately the opposite of cash-variance's fail-closed `limit 0`. The owner's default is "no limit", and a missing cache must not silently re-impose one (and a limit of 0 would disable parking). A terminal that never synced behaves as today's unconfigured default.
- **Re-pair:** a cache row for another tenant or branch is never applied, and the next read replaces it (same as `policy-cache.ts`).
- **Rollout gate (as cash-variance D-6):** no POS release that applies the limit ships before the Backend-Core read is live.
- A failed or `304` read never clears a cached value; only a successful body that says `limit: null` does.

## 8. Shift close and scale

**Shift close: RECOMMENDED unchanged.** The close is still refused while any parked sale exists on the terminal, whoever parked it (`requireNoParkedSales`), with a count and nothing else; forced close still reports `close_blocked`. This was owner decision OP-2 (2026-10-12) and the "no limit" decision does not touch it.

What changes is its weight. With no limit, **the shift-close refusal is the only thing that bounds how many parked sales accumulate**, and clearing them is one manager cancel per sale (RT-441 path). That makes the manager recovery path more load-bearing, not less. A bulk-cancel is **not** proposed here; it is an open question (Q6).

**UI at scale (open question, not a design decision).** Unlimited parked sales means `ParkedSalesScreen` must keep the primary action reachable at 1024×768 with many rows (the list is already a scroll container in `park.css`, but it has never been drawn or verified beyond 5), the badge must stay legible at large counts, and `listParked` returns every row. House rules say compress space before meaning and show the empty, many and error states. The approved PK3 references draw at most 5 rows. Proposed: a separate slice (S1b) that draws and approves the list at, say, 20 and 100 parked sales before the screen is considered done (Q7).

## 9. Proposed slices (not created; owner authorisation required)

| Slice | Scope | Work Mode / gates | Depends on |
|---|---|---|---|
| **S1** POS: no default limit | `parkLimit` seam (default `null`), delete the constant, net-zero swap rule (§5.2). Tests: the 6th and 20th park succeed; with an injected limit of 5 the 6th is refused; swap at the limit, swap with count above a lowered limit, and a swap with two open drafts that would raise the count above the limit (refused); shift-close refusal still counts. No copy, no contract, no migration. | Implementation; POS only, none of the gated paths | none (Q3 for §5.2) |
| **S1b** POS: parked list at scale | Scroll, badge, empty / many states at 1024 and 1280; owner visual approval first. | Implementation after a reference | S1; Q7 |
| **S2** Backend-Core contract | The §7 contract draft, owner-approved. | Docs/contract, `[GATED: contract]` | Q1, Q2, Q5, Q8 |
| **S3** Backend-Core runtime | Migration, table, resolver, POS read, Console publish, audit. | Implementation, `[GATED: migration]` | S2 |
| **S4** POS read and cache | `policy-client` and `policy-cache` equivalents, a cache migration, wire `parkLimit` to it, the §4 copy (and bridge `limit` if option B), the RT-445 documentation updates (below). | Implementation, `[GATED: migration]` | S2 (contract on `main`); S1; Q4. Ship only after S3 is live |
| **S5** Admin-Console setting | The Console field, generated schema, tests, a drawn state set. | Implementation | S2; S3 for end-to-end; owner UX approval |
| **S6** PK-V packaged verification | **S6a** after S1: 6th/20th park accepted, restart and sign-out with many parked, shift-close refusal count, list at scale. **S6b** after S3+S4+S5: set a limit, terminal picks it up, offline, re-pair, lowered below count. | Verification | S6a: S1 (and S1b); S6b: S3, S4, S5 |

S1 and S2 can run in parallel. S4 and S5 can run in parallel once S2 is on `main`.

**RT-445 documentation to update (in S4, when the copy changes; frozen owner-approved references change only with the owner's say-so):**

- `apps/pos/docs/design/vnext/captures/RT-445/README.md` (the limit refusal note).
- `apps/pos/docs/design/vnext/visual-acceptance/PK3-Park-Resume/PK3-Spec.html` (the `park_limit_reached` row and the copy table) and the `PK3-ParkLimit-1024.html` / `PK3-ParkLimit-1280.html` references that draw «5».
- `apps/pos/docs/design/rt-1044-flow-v05-evaluation.md:105` ("up to 5, same operator").
- `apps/pos/docs/design/vnext/08-rt24-invariants.md:31` (I-13 row: "at most 5 parked per terminal").

## 10. Owner questions (recommended answer first)

1. **Where does the limit live?** Tenant value applied per terminal (A) / tenant + store override (B) / per device (C). §6.
2. **Value rules.** Positive integer only, `0` invalid, maximum 50, `null` = no limit?
3. **Limit lowered below the current count.** A net-zero swap is allowed, new parks refused, nothing discarded?
4. **Refusal copy.** Drop the number (A) or keep it with a bridge `limit` field (B)? §4.
5. **Never-synced default.** No limit (recommended, matches your decision), not fail-closed?
6. **Shift close.** Confirm unchanged. Do you want a bulk manager-cancel for many parked sales, as a later issue?
7. **List at scale.** Authorise S1b (draw the parked list at 20 and 100 sales) before no-limit reaches a pilot till?
8. **Propagation.** A change applies at the next online sign-in or shift open (recommended), or also on a periodic refresh?

## 11. Risks and not verified

- No code was run for this plan; every EVIDENCE row was read from the files at the cited paths.
- The manager-cancel path for parked carts (RT-441) was not traced end to end; only that the listing flags parked carts.
- A second page of the Jira search (more than 40 hits) was not read; the first page held no park-limit or Console-setting issue.
- The cash-variance and return-policy contracts were read for their delivery pattern only.
- The `parkLimit` dependency name and the contract file name are proposals for S1 and S2.
