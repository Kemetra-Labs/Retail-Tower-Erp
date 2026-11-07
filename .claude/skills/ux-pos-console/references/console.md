# Admin Console and Platform Console rules

Admin Console = **adaptive operational workbench**, not a scaled POS, a card dashboard or a marketing surface (UX-04.14, Admin DESIGN.md 2). Every screen answers *where am I acting, and what is true* first. Repo authority: Admin-Console `DESIGN.md` v2.0 (RT-265). Shipped tokens: `src/styles/tokens.css`. Controls are 36px (above the accessibility floor; denser than POS).

## Scope and navigation

- A persistent scope header (Tenant / Store) is shell-owned. **Scope change is a context transition**: never silently abandon dirty form work (save / discard / stay), reset filters that lose meaning, clear selection; deep links to an entity in another scope fail safely or offer an explicit scope transition (UX-09.8-.10, UX-10.14).
- Known gaps (do not claim shipped): complete All Stores -> authorized Store switching (RT-268/RT-354); dirty-context guard (RT-268); RF-* dev-gated nav entries are engineering affordances to remove (RT-270).
- Navigation is by durable operational domain (Products, Inventory, Sales, Stores...), shallow; tabs, drawers and local navigation absorb depth. Parent destination stays selected on child/detail/edit routes (UX-09.4, .14). Role-aware: hide what does not belong. Admin distribution is browser-only for the pilot; PWA deferred; phone-width workflows are not promised.
- Tenant role hierarchy: owner > tenant_admin > store_manager > store_staff; store scope always matters; tenant-wide administration requires all-store authority; a client may restrict what it shows but never grant more than the server contract (Authority Matrix, Rule A-B). Catalogue mutation: owner/tenant_admin tenant-wide; store_manager store-level overrides only (ratified 2026-10-06). `platform_admin` is outside tenant membership.

## Tables and lists (UX-10 plus shipped `DataTable`)

- Tables are **work surfaces**, full-bleed, never inside a card (UX-10.1, UX-04.16). **Semantic `<table>` by default; grid only with a real cell-navigation/keyboard model** (UX-10.2, .28).
- **Rows hold data, controls hold actions; selection != navigation** (UX-10.3-.4). With selection on, the row is neither click target nor tab stop: an explicit «Open» button sits right after the checkbox (RT-756). Tab order per row: checkbox, then open.
- Columns have jurisdiction: must-survive (primary identity, decision-critical numbers, operational status), contextual, metadata; drop low-priority columns before meaning (UX-10.5-.6). Pin context sparingly (UX-10.8). Numbers use tabular treatment, consistent precision per domain and direction isolation in RTL (UX-10.7). (A human-readable first column, end-aligned numerics and a visible active-filter indicator come from NN/G and Polaris, not the house rules: advisory G16/G17.)
- **Sort and filter the dataset, not the viewport** (UX-10.11): paged/server-backed lists sort at the query layer; use `sortRows` only for a complete in-memory set. Sortability is deliberate and the active sort is explicit (UX-10.12). Cheap local filters apply immediately; expensive queries use explicit Apply (UX-10.13). Filtered-empty != dataset-empty; offer reset (UX-10.15).
- **Continuation**: cursor/load-more, not infinite feed (UX-10.16). Count only what the contract knows; no totals or page numbers without them (UX-10.17, .21). **Keep proven rows when a continuation fails**, inline retry at the boundary (UX-10.18; RT-269 gap in Audit). **Never stitch rows from different snapshots**: reset and show a snapshot-changed notice (UX-10.19). Refresh preserves orientation (UX-10.20).
- **Selection and bulk** (UX-10.22-.26): selection creates a visible command context with count and scope; "this page" != "all matching"; offer "select all matching" only with an authoritative total and handler; changes to filter, sort, scope or query clear selection (`useRowSelection(scopeKey, ...)` puts tenant, store, filters and sort in the key); scope is stated before the consequence and before commit. Row actions must not compete visually with the batch bar.
- Inspect without losing place: bounded read-only detail opens in a **drawer**, preserving table position, filters and focus; complex editing gets a dedicated surface (UX-10.31, UX-05.27). Inline edit only for simple local fields with an explicit lightweight commit.
- Status is data, not decoration: healthy states quiet, emphasis tracks operational meaning (UX-10.29). Dense rows may abbreviate machine IDs with exact value and copy in detail (UX-10.30). Virtualize only on measured evidence (UX-10.32). Long Arabic names: identity column wraps/clamps to two lines while money and quantity stay fixed and aligned ("flex identity, anchor numbers").
- Target sizes inside tables: 36px floor; enlarge the hit area, not the row (RT-757).

## Forms, edits, destructive actions

- Field contracts and error ownership per `shared-principles.md` (UX-08). Immutable values render read-only and copyable. Server authority errors (store-code conflict) map back to the field; stale-version conflicts surface at the form level explaining the record changed.
- Buttons on `main`: `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-destructive`; one primary per context. `main` also has `.btn-danger-quiet` (starts a destructive action; `.btn-destructive` only in its confirm step), neutral hover and recessed-not-faded unavailable states. Check `origin/main` before using those names.
- **Friction follows consequence** (UX-05.2): reversible = direct + undo only if the domain can restore; destructive/irreversible/financial = explicit consequence-aware commitment naming action, scope and consequence, safe default focus. (Type-to-confirm for rare catastrophic actions is an external suggestion, not a house rule; see advisory G18.)
- Price and other consequential values: explicit commit, no save-on-blur (UX-05.26). Pricing governance: no Store Manager price authoring in V1; independent second approval before emergency price publication (ratified 2026-10-18).

## Operational states in Admin

Freshness is operational truth: disclose snapshot "as of" time, keep rows with a stale warning, show explicit no-snapshot and pending-request states, offer "request fresh snapshot" (Stock Discrepancies is the reference implementation, UX-07). `negativeItemCount=0` with `no_snapshot`/`no_warehouse_mapping` is **UNKNOWN, never "zero discrepancies"** (UX-13 stress test). Human message first with the exact copyable reference nearby («المرجع: req_…», LTR). ERP/sync failures belong to their layer and never rewrite a proven sale.

## Platform Console (`/platform`; planning, RT-777)

Rules in force before any `/platform` UI:
- **Two consoles only**; owner workspace is the role-gated group «مركز قيادة المالك». Gated by the dedicated `perm_owner_console` permission, granted by name, audited on every use, not implied by platform admin.
- **Support session** (RT-391/RT-414): purpose from a closed set (`customer_support` / `incident` / `onboarding`), optional ticket ref, 60-minute expiry with renewal capped at 8 h or auth-session expiry, read-only by default, tenant-scoped, visible to the tenant owner and admin. UI must **not offer any write inside a session** (a UI safeguard, not security). Tenant unknown/forbidden/deleted share one non-disclosing 404; a **suspended tenant opens read-only and refuses break-glass**.
- **Break-glass**: one action, ends when it runs or is cancelled; re-auth = password re-entry plus reason; no contract yet (screens stay design-only).
- An action with no service behind it ships `aria-disabled` with «تصميم فقط», or does not ship (DS-R17). Count bands and status marks are allowed; **data charts wait for UX-13**; each status word has one meaning; only the platform team resolves an unknown posting outcome; support views show ERP invoice existence and payment outcome as UNKNOWN unless evidence exists; per-sale diagnosis shows status, outcome, document ref and IDs without payload or customer PII.
- Screens 20-46 under `design/screens/` are a design record, not sign-off; check the contract levels (exists / pinned / served) before treating any as buildable.

## Admin token and shell facts

Light default; opt-in dark theme (top-bar toggle, per-user storage, no flash). Radius shipped 8/12/16. Fluent registry in `src/components/icons/`; the sidebar is labelled so no Filled glyphs. Focus outline from `src/styles/a11y.css`. Tower Gold, navy action and dark default are retired (RT-396): never reintroduce. Dubai weights 300/400/500/700 via `--weight-*`. Tokens: use `--color-*`, `--space-*`, `--radius-*`, `--text-*`, never raw hex. Migration debts are tracked separately (RT-399 locale: Arabic default and catalog are on `main`, Store timezone RT-401 still open; RT-267 forced colours, RT-268 scope switcher, RT-269 audit continuation, RT-270 dev nav); do not fold them into feature work.

## Not defined in the house rules (surface as open questions; do not invent)

Bulk-write contract (atomic vs per-row, sync vs job, idempotency, partial success); which price field an Admin bulk edit changes (tenant price vs store override); rounding mode for percentage price changes and min/max/zero-price guards; whether a routine (non-emergency) price change needs approval; reversibility of a bulk change; a staging list that survives filter changes (UX-10.24 clears selection, so the sanctioned route is filter once then "select all matching" only if the backend gives an authoritative total and handler); catalogue page-size limits; multi-store selection semantics beyond the scope header (RT-268/RT-354). A preview/diff surface, per-row result report, background job progress and import dry-run are **Advisory** (G1/G2/G3 in `advisory-candidates.md`): offer them as suggestions, labelled, never as house rules.

## Dashboards and reports

Admin overview shows decisions, not every metric (UX-13.33). See `data-viz.md`. The `design_handoff_retail_tower_console` charts are reference only.
