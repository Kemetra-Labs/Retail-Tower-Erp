---
name: Retail Tower Console
description: >-
  Admin Console design baseline, rebaselined to the Retail Tower UX/UI Constitution
  (UX-01…UX-13, Final Audit 2026-10-07). Target: light-first Mineral Daylight + Tower Teal,
  one shared semantic color system with POS, Arabic-first (Dubai) type voice, RTL by structure.
  The token block below records the CURRENT SHIPPED tokens (src/styles/tokens.css). Since
  RT-396 and RT-397 the colours, radii and type ARE the approved light target (RT-392).
  v3.0 (RT-969) adds the owner-approved Shell v3 "Daylight Commerce" frame.
  v4.0 (owner decision 2026-10-30) adopts the "Ink & Receipt" look (canvas board v9) as the
  approved visual target (§12), shipping in slices; the slices already on main are listed in
  §10 and §12.8. v5.0 (owner decisions D7–D9, 2026-11-26, RT-1608) adopts «Console system v3»
  as the target (§13): seven areas with tabs, a light sidebar, an Ink top bar and area band, and
  a receipt figure strip; it ships in slices (§13.11). The token block below stays shipped truth.
status: current-shipped-tokens
# CURRENT SHIPPED TOKENS — a SUBSET of src/styles/tokens.css on main (colors, type, radius,
# spacing); tokens.css is authoritative and also holds the scrim, overlay shadow, motion and
# shell tokens. Light is the default (RT-396); the approved dark theme (RT-392) ships as a
# [data-theme="dark"] block with a top-bar switch (RT-398). The colors below are the light set.
colors:
  background: "#f7f9fa"
  surface: "#ffffff"
  surface-sunken: "#eef2f6"
  text: "#0f1d2e"
  text-muted: "#53647a" # also the control boundary (control-border)
  border: "#d8dfe7" # decorative dividers only
  primary: "#0f766e" # Tower Teal: intent (action, selection, focus)
  primary-emphasis: "#0b5b55"
  primary-soft: "#e6f4f1"
  success: "#15774d"
  warning: "#a35a00"
  danger: "#b3261e"
  info: "#1b6ca8"
  on-primary: "#ffffff" # alias of surface
  control-border: "#53647a" # alias of text-muted
  focus-ring: "#0f766e" # alias of primary
typography:
  fontFamily: "Dubai, Segoe UI, Tahoma, system-ui, sans-serif" # no font files served (RT-397)
  monoFamily: "ui-monospace, Consolas, monospace"
  display: "1.875rem" # rare
  screen-title: "1.5rem" # 24px, the page title (RT-969)
  section-title: "1rem"
  body: "0.875rem"
  control: "0.8125rem"
  meta: "0.75rem" # the 12px floor
  money-total: "1.25rem"
  numeric-row: "0.875rem"
  machine: "0.8125rem"
  kbd: "0.75rem"
  leading-body: 1.7
  leading-title: 1.35
  leading-tight: 1.2
  weight-regular: 400
  weight-medium: 500
  weight-strong: 700
rounded:
  sm: "4px"
  control: "8px"
  object: "12px"
  overlay: "16px"
  pill: "9999px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
  s6: "32px"
  s7: "48px"
  s8: "64px"
  s9: "96px"
---

# Design System: Retail Tower Console

> **Version 5.0 — "Console system v3" (owner decisions D7–D9, 2026-11-26, RT-1608).** The owner
> judged the Console engineering-oriented and adopted a redesign that is modern but keeps the
> Retail Tower identity:
> - seven areas with tabs, replacing the four menu groups;
> - a light sidebar, with Ink moving to the top bar and to a header band on every area;
> - the day's figures in one receipt strip, plus a sale-pipeline strip;
> - every area leading with what needs a decision and who can act;
> - truth rules for partial and unknown data.
>
> §13 is the rule set and §13.9 lists what it keeps, amends or replaces from §12. It is
> **adopted, not shipped**: `main` renders v4.0 until the §13.11 slices land, and the typeface
> stays open (§13.4).
>
> **Version 4.0 — "Ink & Receipt" visual direction (owner decision, 2026-10-30).** The same
> day the owner judged the v3.0 look (and its v4 canvas redraw) "too plain" and locked board
> **v9** «✓ المعتمد · نظرة عامة v9» on the design canvas
> <https://claude.ai/artifact/7LkLBupz4nTpvB4P4k4NW4> (boards v4–v8 there are history only).
> v4.0 keeps the v3.0 structure (sidebar with scope, top bar with Ctrl K, page header, section
> panels, templates) and replaces its **visual layer**: a dark Ink sidebar, receipt-style KPI
> cards, a sale-pipeline rail, Mint as the highlight of the teal family, soft elevation and a
> display face for headings and figures. §12 is the full rule set and lists what each earlier
> rule it amends. It is **approved, not shipped**: `main` still renders v3.0 until the
> migration slices in §10 land. §12.8 lists the decided items (1–3, each with a remaining step)
> and the open ones (4–6) a slice waits on.
>
> **Version 3.0 — Shell v3 "Daylight Commerce" (RT-969, 2026-10-30).** On 2026-10-30 the owner
> rejected the v2 Console look as "primitive, not a control panel" and approved direction
> **A + C pipeline strip** on the design canvas
> <https://claude.ai/artifact/NvG61RAVXHdy2gjFgX3sZK> (artboards «المختار · A + مسار C — نظرة
> عامة» and «المختار · المبيعات»): a Shopify/Stripe-like frame that keeps Tower Teal, Dubai and
> Arabic-first RTL. v3.0 makes that canvas the documented authority for the shell: the sidebar
> with the scope switcher in it, the 64px top bar with the Ctrl K navigator and the user menu,
> the shared page header, the content container and section panels (§2, §5, §6, §9). Screens
> adopt the canvas content per bounded slice (Overview v2, detail and form templates).
>
> **Version 2.0 — Constitution rebaseline (RT-265, 2026-10-10).** Supersedes v1.0 ("The Lit
> Command Desk": dark default, navy action, Tower Gold authority, Inter). v1.0 is retired as
> design intent and kept only in git history. Authority for future Admin UI is the
> Retail Tower UX/UI Constitution in Confluence (RETAIL space). This file explains how that
> authority applies to this repository. It does not restate every rule, and it does not claim
> that any target below is shipped.

## 1. Precedence

1. **The Constitution governs future Admin UI.** UX-01…UX-13 plus the
   [Final Audit & Implementation Gap Map](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/24510466)
   (2026-10-07) are the design authority. The most specific module owns its jurisdiction
   (UX-02 color, UX-03 type/icons, UX-04 layout, UX-09 navigation, UX-10 tables, UX-11
   accessibility/RTL, UX-12 copy/localization, UX-13 data visualization).
2. **Shipped tokens remain technical truth until a bounded slice changes them.** GitHub `main`
   (`src/styles/tokens.css` and component CSS) is what production renders today. A new surface
   consumes the existing role tokens (`--color-*`, `--space-*`, `--radius-*`, `--text-*`) and
   must not hardcode hex. It must not deepen deprecated identity either: no new gold usage,
   no new navy-as-brand usage, no new dark-only assumptions.
3. **Migration happens per bounded Jira slice**, never as one "implement the Constitution"
   change. Each slice re-verifies `main`, names the Constitution rules it implements, and
   supplies visual, accessibility and runtime evidence for the surface it touches.
4. **Brand yields to accessibility.** UX-02 brand and semantic colors yield to UX-11
   forced-colors and high-contrast requirements. Meaning never depends on a branded color.

### Superseded / reference-only in this repository

| Artifact | Status |
| --- | --- |
| `DESIGN.md` v1.0 (dark default, Tower Gold authority, navy action, Inter, English/LTR shell) | **Superseded** by this version. |
| `DESIGN.md` v2.0 shell (56px top bar holding language and theme, a recessed scope bar under it, a 240px nav-only sidebar, 30px page titles) | **Superseded** by the v3.0 shell (RT-969). |
| `DESIGN.md` v4.0 visual layer (§12: Ink sidebar with Mint signal line, hero receipt, glows, 20px radius, Readex Pro) | **Superseded as target** by v5.0 §13 (owner decision D9, 2026-11-26; §13.9 lists what is kept). Still the shipped look on `main` until the §13.11 slices land. |
| `DESIGN.md` v3.0 visual layer ("Daylight Commerce": light sidebar, one KPI ledger strip, shadowless panels, Dubai-only type) | **Superseded as target** by v4.0 §12 (owner decision 2026-10-30). Still the shipped look on `main` until the §10 v4.0 slices land. The v3.0 structure stays. |
| `PRODUCT.md` — Design Principle 6 ("dark by default … light alternate") and the dark-*default* note under Anti-references | **Superseded** by UX-02 light-first. The rest of PRODUCT.md (users, purpose, principles 1–5) stands. Reconciling PRODUCT.md is a separate docs change. |
| `design_handoff_retail_tower_console/` — screens, charts, theme, KPI coloring, dual-axis patterns, route map, chart palette | **Reference/prototype only** (Final Audit; UX-13 prototype disposition). Nothing in it is production authority unless a Constitution-backed issue adopts it. |
| `docs/design/_vision/`, `docs/design/rf1-auth-shell/`, `docs/design/rf6-audit-search/` mockups and their `tokens.css` | Historical slice references. They are not the target identity. |

## 2. Product character (UX-01, UX-09)

The Console is an **adaptive operational workbench**. It is not a scaled-up POS, a card
dashboard or a marketing surface. POS navigates tasks; the Admin Console navigates the system.
Every screen answers *where am I acting, and what is true* before anything else. Identity
comes through behavior: state handling, selection grammar, data geometry and surface
hierarchy. It does not come from ornament, logos or a second accent color.
*Amended by v4.0 (§12.1, D-V4/D-V9):* ornament is allowed, but only on the expressive surfaces
listed in §12.1.

Admin may use more **Responsive** motion than POS (UX-06). Expressive motion is rare and
never on operational truth. `prefers-reduced-motion` collapses durations to instant, but
focus, copy, status and border/icon feedback stay intact.

**Status at a glance (v3.0, owner decision 2026-10-30).** The Overview may show status at a
glance as **one KPI ledger strip** (a single section panel of label / value / delta cells,
divided by rules, never one card per value) **plus one pipeline strip** (POS → server →
ERPNext, each step with its count and its first problem). That is the only exception. Stat-card
grids, hero metrics and decorative charts stay out, on the Overview and everywhere else.

*Amended by v4.0 (§12.4):* the Overview shows one row of receipt KPI cards (one hero plus at
most three), the pipeline as a compact rail beside the greeting, one trend chart and one
composition chart. Every chart there answers a question with real data and has a table
equivalent; decorative charts stay out. Other screens keep the rule above.

## 3. Color (UX-02, UX-13)

**Target direction: Mineral Daylight + Tower Teal, light-first.**

- **Theme.** The Admin Console defaults to **light**. An opt-in dark theme was approved on
  2026-10-11 (RT-392): the same thirteen roles with dark values, switched by the user from the
  top bar (values in `design/claude-design-system/README.md`). Shipped by RT-398: a "Dark mode"
  toggle (`.btn-secondary` + `aria-pressed`, constant label) sets `data-theme="dark"` on
  `<html>`; the choice is kept per user in browser storage (no Backend-Core preference contract
  exists), and an inline script in `index.html` restores it before first paint.
  No forced dark sidebar or dark shell to create personality (*amended by v4.0 §12.1: the
  sidebar is the one Ink surface in both themes; content surfaces stay light-first*). Components consume semantic
  role tokens, so the dark theme (and any future high-contrast theme) remaps roles without
  changing what a component means.
- **Brand anchor.** Tower Teal `#0F766E` (the current POS teal) is the working primary anchor,
  shared with POS. POS and Admin use **one semantic color system and the same token
  families**, differing in expression density, not palette.
- **No secondary brand accent.** Tower Gold is retired, along with navy as the action and brand
  color. Do not introduce purple, coral, orange or another permanent accent; a future need
  must be demonstrated by Admin or data-visualization work.
- **Neutrals.** Low-chroma mineral neutrals with a subtle blue-green relationship to Tower
  Teal. Avoid both clinical cold gray and warm beige. *The values are the owner-approved
  RT-392 light table, shipped in `src/styles/tokens.css` by RT-396.*

### Color jurisdiction

| Role | Meaning | Notes |
| --- | --- | --- |
| Teal (intent) | Primary action, selection, focus/interaction language, active brand identity | Not decoration. Brand teal is **not** success green. |
| Blue | Information / pending | |
| Green | Proven success | Only for outcomes that are proven. |
| Amber | Caution / degraded | |
| Red | Danger / consequence / **UNKNOWN** | UNKNOWN is never softened into neutral. |

- **Priority:** critical truth → primary action → current context/selection → brand identity
  → decoration. When an important operational state exists, its semantic color beats brand
  color ("Brand Yields to Truth").
- **Meaning redundancy:** color never carries operational meaning alone. Text, an icon, a
  shape/border or another cue is always present (UX-02, UX-11).
- **Low saturation budget:** most pixels stay neutral, so saturated brand and status color
  keeps its meaning. No gradients on tables, forms, operational buttons or status surfaces.
- **Data color ≠ status color (UX-13):** chart categorical, sequential and diverging palettes
  are a separate token family, never reused success/warning/danger/info. Up/down is never
  automatically green/red.
- **Data-viz tokens (RT-822, owner-ratified 2026-10-23).** `src/styles/tokens.css` ships the
  `--color-viz-*` family in light and dark (the same values as
  `design/claude-design-system/colors_and_type.css`). Design-system rule 8 sets how charts use
  it.
  - **Categorical** `--color-viz-cat-1`…`--color-viz-cat-8`: indigo, olive, magenta, orange,
    cyan, crimson, violet, green. Assign in this order and never cycle. With more than eight series,
    the first seven keep slots 1–7 and the rest fold into one "Other" series in slot 8. Adjacent slots stay apart under protanopia and deuteranopia (OKLab ΔE ≥ 13.9) and
    for full colour vision (ΔE ≥ 21.5). For scatter plots and small multiples, where any two
    marks can sit side by side, use at most the first three slots. Every slot sits at least
    ΔE 10.5 from every status and intent colour. The nearest are olive, orange, cyan and
    crimson, which sit ΔE 10.5–11.4 from success/warning, warning, info and danger in light.
    Status keeps its icon and label.
  - **Sequential** `--color-viz-seq-1`…`--color-viz-seq-5`: one indigo hue, where 1 is the
    least. It runs from the surface outward: light to dark in the light theme and dark to light
    in the dark theme.
  - **Diverging** `--color-viz-div-neg-3`…`--color-viz-div-pos-3` around
    `--color-viz-div-mid`. Orange runs below the baseline and violet above it. The midpoint is
    the mineral border neutral. Neither side means good or bad.
  - **Contrast** (`.design-sync/contrast-pairs.mjs`, both themes, all three layers): every
    mark clears 3:1. The receding ends (`seq-1` and each arm's step 1) clear 2:1. The midpoint
    has no minimum.
  - **Forced colours:** marks draw in `CanvasText` and receding steps in `GrayText`. Identity,
    magnitude and sign then come from direct labels, the legend, texture and the table view,
    never colour alone. Charts own that work (VIZ-5).

### Visual signatures (grammar, not wallpaper)

- **Mineral Layering:** depth comes from canvas → surface → recessed → overlay tonal layers.
- **Signal Line:** a restrained **inline-start** indicator marking current context/selection in
  navigation, rows or workflow context. It uses logical positioning so it flips in RTL.
- **Pulse Dot:** a small state primitive for genuinely live states. It is static unless real
  activity is occurring, and motion respects reduced-motion.
- **Precision Ledger:** label/value alignment, tabular numerals, separators and anchored totals
  for money and operational relationships, instead of one card per value.
- **v4.0 signatures (§12.2):** the Receipt card, the Pipeline rail, the Tower grid, the Mint
  signal line, the Section index and data-bearing illustrations join these. They are grammar too: each has one job and is not used as decoration.

## 4. Typography and icons (UX-03)

- **One Arabic-first UI voice shared with POS: Dubai** (the incumbent). IBM Plex Sans Arabic is
  the long-term challenger and Noto Sans Arabic UI the density benchmark. **No speculative
  font migration:** a change of primary font needs rendered same-screen A/B evidence. The
  Admin Console moved to Dubai in RT-397. No font files are served: Dubai renders where it is
  installed, otherwise Segoe UI / Tahoma. Dubai has 300/400/500/700 only, so use the
  `--weight-*` roles; a 600 silently renders as Bold. No `letter-spacing`: tracking breaks
  Arabic letter joining.
- **Type has jurisdiction.** UI sans owns language. Tabular numerals own money, quantities and
  KPI values. **Monospace is only for machine data**: IDs, request refs, SKUs, codes and
  evidence strings. It is never used as a "technical" aesthetic.
- **Semantic type roles (target vocabulary):** `display` (rare), `screen-title`,
  `section-title`, `body`, `body-strong`, `control`, `meta`, `money-hero`, `money-total`,
  `numeric-row`, `machine`, `kbd`. Shipped as `--text-*` in `src/styles/tokens.css` (RT-397),
  equal to the approved values; `body-strong` and `money-hero` are not defined yet.
- **Screen title: 24px** (`--text-screen-title`, 1.5rem, the approved canvas value since
  RT-969). It is the page header's `<h1>` and nothing else at page level is that large.
  *Amended by v4.0 (§12.3):* the Overview greeting `<h1>` is 32px and KPI figures 30–34px,
  in the display face; every other screen title stays 24px.
- **Precision Ledger (RT-961).** In a detail ledger (`.field-row`) the value is what the row is
  for: body size, regular, text colour. The label is muted and never heavier than its value.
  Machine values keep mono. Money sits at the inline end (right in LTR, left in RTL) in tabular
  numerals, so decimals line up, in ledgers and in table columns (`data-table__cell--num`, header
  included). The figures a ledger arrives at read stronger (`field-row--result`), and its total
  is anchored under a 2px text-colour rule (`field-row--total`, `data-table__total`). A total is
  shown only as served, never summed in the Console. A row header (`<th scope="row">`) keeps the
  row divider.
- **Readability floor: 12px.** No operator-readable text below 12px (declared CSS sizes are checked by
  `tests/unit/tokens-identity.test.ts`). Arabic body keeps generous line-height (1.7).
  Hierarchy comes from placement, spacing, weight and alignment before size.
- **Icons: Fluent System Icons Regular**, through the **semantic icon registry** in
  `src/components/icons/` (RT-263 D-263-1…9, shipped by RT-696). The canonical name table is
  POS `docs/design/vnext/25-rt263-icon-registry-fluent-poc.md` §3; Admin carries the subset it
  renders, with the same names as POS (D-263-9).
  - **Names are meanings** (`store`, `inventory`, `back`, `status.warning`), never shapes,
    screens or vendor names. Product code writes `<Icon name="store" />`; only
    `registry.ts` maps a name to a Fluent asset.
  - **One grammar.** Fluent Regular is the only glyph source; no other family, no raw `<svg>`
    and no text glyph (`✕`, `✓`, `←`) stands in for an icon. Filled is only for the selected
    slim-rail nav entry (D-263-8); the Admin sidebar is labelled, so Admin declares none. The
    brand `TowerMark` stays outside the registry (D-263-7).
  - **Vendored, no dependency.** Path data is copied from `@fluentui/svg-icons` 1.1.344 into
    `fluent-paths.ts`, with the version in its `/*! @license MIT */` header; the MIT text sits
    beside it and in `NOTICE`. An update is a reviewed re-extraction, not a package bump
    (D-263-2/3).
  - **Sizes are the native grids:** `sm` 16, `md` 20 (default), `lg` 24. A glyph is never
    scaled between grids; a larger slot (the NoAccess lock) centres an `lg` glyph. Each name
    declares only the grids its call sites use (D-263-5).
  - **Icons reinforce and text decides.** The glyph is always `aria-hidden` and not focusable;
    the accessible name lives on the control or the adjacent text. The old `title` prop is
    retired (D-263-6). Destructive, financial and recovery actions stay text-visible; an
    icon-only control (the Drawer close) needs an `aria-label` on the control.
  - **Colour:** `fill="currentColor"`, so the control's token decides it. No
    `forced-color-adjust` on icons: under forced colours they take the system colours like text.
  - **RTL follows meaning; the registry owns it** (D-263-4). Each name is `never`, `mirror`
    (flipped in an RTL run: `back`, `signOut`) or `variant` (a separate Fluent RTL asset:
    `audit`). The nearest `dir` attribute decides, so an LTR-isolated run stays unmirrored.
    Never mirror object icons (store, lock, search, check).

## 5. Layout, density and shape (UX-04, UX-10)

- **Spacing:** the existing 4px-derived scale (4/8/12/16/24/32/48/64/96, `--space-1…9`) with
  semantic use for micro, component, region and page rhythm. No arbitrary values.
- **Density:** Comfortable / Operational / Compact, chosen by context and not a user setting
  yet. Dense inside a region, breathing room between regions. Under pressure, compress space
  before meaning and reflow before shrinking.
- **Data stretches; reading constrains.** Tables, grids and timelines take the available width
  of the content container. Reading and form surfaces use a constrained measure (about 60–65ch).
- **Content container (v3.0):** the routed page renders in one container at the inline start,
  `--shell-content-max` (1240px) wide at most, padded `--shell-content-pad-block` (28px) at the
  top, `--space-6` (32px) at the sides and `--space-7` (48px) at the bottom; at ≤600px the sides
  are `--space-4`. The page header comes first, then the regions.
- **Data regions sit in section panels (v3.0).** Surface grammar:
  - **Work Surface:** the canvas the content container sits on (`--color-background`).
  - **Section panel** (`.section-panel`, `__head`, `__title`, `__body`): the surface of one data
    region: `--color-surface`, a 1px `--color-border` edge, `--radius-object` (12px), no shadow.
    A **table may live inside a section panel under its header**, edge to edge (no inner
    padding, the header row tinted `--color-background`). A KPI ledger strip or a filter bar
    is a section panel too.
  - **Section:** heading, spacing and an optional divider inside a panel; not a container.
  - **Card:** only for a genuine independent, selectable or actionable object.
  - **No nesting:** never a panel or card inside a section panel, and never a table inside a
    card.
  - **Drawer:** attached, with real elevation.
  - **Dialog:** the strongest elevation.
- **Detail template (v3, RT-961)** (`src/components/DetailPanel.tsx`): the back link, the page
  header (title; the record's status as a `HeaderStatus` badge, named for assistive tech by its
  field, never repeated as a ledger row; the record's actions), then a failure banner where the
  data has one (What → Safety → Action → Evidence, §8), then the data regions. Each region is a `DetailPanel`, a
  section panel named by its `h2`. Ledger panels sit in a `DetailGrid`, two to a row once
  the content is wide enough (each at least 26rem) and stacked otherwise. A lone ledger keeps
  its half. A table sits straight under its panel header, full width, outside the grid. DOM
  order is reading order. It is used by sale, shift-close, device, catalog product and store
  detail.
- **Shape (target):** 8px controls, 12px genuine contained objects, 16px independent overlays.
  Round the object, not the page. Pills only for true status, counts or tags, never ordinary
  buttons. *Shipped as `--radius-control` / `--radius-object` / `--radius-overlay` (RT-396).*
  *Amended by v4.0 (§12.5):* panels and cards 20px, controls 10–12px, the top-bar search 14px;
  overlays keep the strongest elevation.
- **Borders and tone before shadows.** Work surfaces, sections, cards and panels are shadowless.
  Popovers, drawers and dialogs may use restrained elevation.
  *Amended by v4.0 (§12.5):* section panels and receipt cards take one soft resting elevation
  token and a 20px radius; the border stays, so edges survive forced colours.
- **One primary scroll owner** per workspace. A drawer may own its own scroll. Overflow belongs
  to the data surface, not the app shell.
- **Table grammar (UX-10):**
  - Semantic `<table>` by default. A grid model only when real cell navigation exists.
  - Rows hold data and controls hold actions. Selection is not navigation.
  - Column tiers (must-survive / contextual / metadata). Remove low-priority columns before
    meaning.
  - Numbers tabular, consistently precise and direction-isolated.
  - Sort and filter the **dataset**, never just the loaded viewport.
  - Scope changes reset filters that are no longer valid.
  - Filtered-empty and dataset-empty are different states.
  - Deliberate continuation (cursor/load-more). **Keep proven rows when a continuation fails**,
    with inline retry at the boundary.
  - Never stitch different snapshots together. Count only what the contract knows.
  - Bulk scope is explicit and countable.
  - Inspect in a drawer without losing place.
  - Virtualize only on measured evidence.

## 6. Navigation and scope (UX-09)

- **Location ≠ Scope ≠ State.** Product location, Tenant/Store scope and workflow state are
  separate axes. The shell owns persistent identity, scope and primary navigation; the
  screen owns the task.
- **Scope lives in the sidebar (v3.0).** The scope switcher sits under the brand at the top of
  the sidebar: the store (or «كل المتاجر») over its tenant, with a decorative initial tile. At
  ≤768px the sidebar's navigation moves to the menu drawer and the sidebar itself becomes the
  48px scope row under the top bar, so scope is never behind a menu (PRODUCT.md principle 1).
  The Ctrl K navigator also offers the stores in scope; both run the same guarded change.
- **Scope change is a context transition, not a filter click.** It must never silently discard
  unsaved form work; the user gets an explicit save / discard / stay path. Deep links never
  silently mutate scope.
- **Navigation has a capacity budget.** Actions and utilities are not destinations, and
  production navigation never advertises dead destinations. The current RF-* dev-gated
  entries are engineering affordances, not approved production UX.
- **Role-aware navigation:** destinations that don't belong to a role are normally hidden.

## 7. Accessibility, RTL and focus (UX-11)

- **Accessibility is operational reliability.** Every essential action is keyboard-operable.
  Use native HTML before ARIA.
- **Focus is a first-class state:** obvious, distinguishable from hover, selection and location,
  and never obscured by sticky regions or drawers. **The primary focus signal is an outline,
  not a box-shadow**, so it survives forced-colors. Focus returns to the invoker, or to the
  next meaningful owner when the invoker vanished.
- **Modal semantics require modal behavior:** `aria-modal="true"` means a Tab/Shift+Tab trap,
  a safe Escape, intentional initial focus, and focus restore on close.
- **Forced colors are an operating environment, not a brand theme.** Focus, selected, blocked,
  danger and status meaning must survive Windows contrast themes independently of brand color
  and shadow.
- **RTL is structure, not styling.** Declare `lang`/`dir` at the document, app or surface
  boundary. Use **logical properties by default** (`margin-inline-start`, `inset-inline-end`,
  `border-inline-start`, `text-align: start`). Isolate machine data (amounts, SKUs, emails,
  request IDs) with `dir="ltr"` or `<bdi>`. Visual order and Tab order tell the same story.
- **Targets:** above 768px the Admin Console may be denser than the POS 44px floor while staying
  above the accessibility floor. The current controls use 36px.
  - **Compact shell (≤768px, RT-785 D3, RT-825):** the menu button, the navigation drawer's
    entries, its language, theme, sign-out and close controls, the scope button and the
    scope-menu items, the navigator button and its options, the user button, and the primary
    action of a Tier 1 page are at least 44×44px.
  - Dense secondary controls keep the WCAG 2.2 AA floor of 24px: table sort headers (36px
    effective hit area), inline links inside table cells and badges.
  - Desktop density does not change.
- **Evidence follows the touched surface:** static checks, component tests, a keyboard-only
  walk, axe where applicable, forced-colors captures and reduced-motion validation.

## 8. Content and localization (UX-12)

- **Arabic is the primary authored product language. One locale at a time**: never duplicate
  "Arabic (English)" on controls. English is the second locale (owner decision 2026-10-11,
  RT-399), chosen with the top-bar switch (a quiet button named in the other language,
  «English» / «العربية») and remembered per user. Latin text otherwise appears only as
  machine/proper terminology (ERPNext, EGP, SKU, API, IDs).
- **Copy lives in the catalog** (`src/i18n/messages/{ar,en}/`): flat dotted keys, whole
  sentences with named params, CLDR plurals. The Arabic catalog is the key set; a missing
  English key is a compile error. Components read copy with `useT()`; state keeps message
  keys, never translated strings.
- **Terminology (UI ← internal):**

  | UI term | Internal / evidence term | Note |
  | --- | --- | --- |
  | «المؤسسة» | Tenant | |
  | «الكيان القانوني» | Legal Entity | |
  | «المتجر» | Store | Never «الفرع». Business-authored names like «فرع المعادي» are kept as authored. |
  | «الصنف» | Retail Item / `tenant_product` | |
  | «الكتالوج» | Catalog | |
  | «المستخدم» | operator (generic identity) | Unless a specific role is known. |

  Code names (`operator`, `tenant_product`, `projection`) never leak into normal copy. ERPNext
  Item is never presented as the product authority.
- **Copy grammar.**
  - Name the action, not the button type. Verbs keep a stable meaning: حفظ / إضافة / تأكيد /
    إلغاء / حذف / إزالة / تحديث.
  - Errors read What → Safety → Action → Evidence.
  - Never recommend a retry that can't resolve the state.
  - **Machine codes drive copy; they are not copy.** A missing translation never shows a raw
    key or backend English.
- **Numbers and money.** Western digits in Arabic UI (`ar-EG-u-nu-latn`). Money is
  `1,250.00 EGP`: grouped, two decimals, LTR-isolated. Arithmetic is unchanged. Use
  noun-first counters («الأصناف: 11»). Pluralize whole phrases via CLDR categories, never
  `{n} + noun`.
- **Time.** Human Arabic dates with Western digits and 24-hour time for operations, in the
  **Store's** business timezone. Audit and evidence keep exact timezone-explicit (UTC)
  timestamps. Relative time orients; absolute time proves.

## 9. Components — current shipped vocabulary

These classes exist on `main` and new work reuses them until a migration slice replaces them.
**Bold** items are the deprecated identity each slice must not extend.

- **Buttons:** five variants: `.btn-primary` (Ink fill on light, Mint on dark: the
  `--color-action-fill` pair, §12.6; shipped by RT-1038), `.btn-secondary`,
  `.btn-ghost` (cancel, close, back), `.btn-danger-quiet` (red edge and text on surface) and
  `.btn-destructive` (red fill). `.btn-danger-quiet` starts a destructive action;
  `.btn-destructive` appears only in its confirm step: a flow whose confirm is red opens with
  `.btn-danger-quiet`, placed last and set apart from the non-destructive actions beside it
  (device revoke and retire, store suspend). Cancel, close and back are always `.btn-ghost`,
  never primary or secondary. `tests/unit/button-grammar.test.ts` enforces both. One primary
  per context. Hover is
  neutral, never the selection wash. Unavailable is recessed, not faded. Press is Contact
  (80ms).
  - **Height** (RT-959): every desktop button, input and select is `--control-h` (36px); the
    compact shell's touch target is `--target-touch` (44px). No stylesheet spells either
    number (`tests/unit/control-height-tokens.test.ts`).
  - **Busy** (RT-959): a pending action is a `BusyButton` (`GatedButton` is one) with
    `busy`. It is `aria-busy` + `aria-disabled`, never native `disabled`, so focus stays on
    it. It ignores repeat clicks and Enter, keeps its variant colours (not recessed, not
    GrayText in forced colours) and shows the shared spinner before its label. The label
    still says what is happening ("Saving…"). Native `disabled` is only for an unavailable
    action, such as a running Retry-After.
- **Motion:** route changes stay instant (UX-06). The drawer has an enter and an exit. New
  banners, inline confirms and inline errors settle in on Signal (150ms); new table rows fade
  in. All of it is zero under reduced motion.
- **Badge** `.badge`. Each variant is a §3 color role, not a status name (RT-956):
  - no modifier is neutral: a recorded state that claims nothing, such as "active" on a
    store or a device. An enabled flag is not a proven outcome, so it is not green.
    Known gap: "active" on tenants, operators and stock locations is still
    `--success`. Align it in its own slice; do not copy it into new work.
  - `--success` (green) marks a proven outcome only.
  - `--warning` (amber) marks caution or a degraded state, such as suspended, revoked
    membership, a sync failure or a voided sale.
  - `--pending` (blue) marks information or work in progress.
  - `--danger` (red) marks a consequence and **every UNKNOWN or unrecognized state**,
    such as ERP posting `failed` or a code the Console does not know. Never amber or
    neutral.

  A value the server does not record yet is not UNKNOWN. It reads «غير مسجّل» / "Not
  recorded" in quiet text, not in a badge. Status badges always carry text, so status is
  never color alone, and forced colors keep the text and a `CanvasText` border.
- **Banner** `.rtc-alert--{danger,warning,success,info}`: persistent operational state, not a
  toast.
- **Inputs** `.input` and `.field`. Errors use `aria-invalid` plus inline text. A single-line
  input or select is exactly `--control-h`; a textarea grows. Disabled is recessed (sunken
  fill, quiet edge, muted text; GrayText in forced colours), never `opacity`. One checkbox
  size, 18px.
- **FilterBar** (`src/components/FilterBar.tsx`, RT-960): the one filter bar for every list.
  - It is a section panel above the list. The screen keeps its own draft, URL state and
    validation.
  - Fields (`FilterField`) sit on one grid of equal tracks, so columns line up. Extra
    fields join the same tracks. Notes go under the grid, never inside a cell.
  - One verb: «تطبيق» / "Apply" (`btn-primary`, rate-limit gated, can be busy), after a
    `btn-ghost` «مسح» / "Clear". No list filter sends a read on change. The one
    exception is a search that narrows a list already loaded on the client: the platform
    tenant directory narrows as you type and sends no read.
  - Optional «فلاتر إضافية» disclosure: its count is the applied hidden filters and is in
    its accessible name. The region is hidden, not unmounted. It opens when a hidden
    field has an error.
  - Chips for applied filters on every list with two or more filters. Removing one applies
    straight away; a required filter has no remove control. The remove target is 24px.
    Values are bidi-isolated (`isolate`, `ltr`).
  - A list with one select filter uses `SelectFilterBar`.
- **DataTable** (`src/components/DataTable.tsx`; usage rules in the notes below), **Drawer** (focus-trapped dialog), and
  **ListState** (loading / empty).
- **Shell v3** (`src/shell/`, RT-969; `ShellFrame.tsx` is shared by `AppShell` and
  `PlatformShell`):
  - **Sidebar** (`--shell-sidebar-w` 260px, inline start, full height, sticky): the brand
    lockup (`TowerMark` on a teal tile, the product word and tag), the scope switcher
    (`ScopeHeader`, tenant shell only), then the grouped navigation and sign-out. Its
    navigation scrolls on its own.
  - **Navigation model** (`nav-model.ts`): one role-filtered list of groups feeds the sidebar,
    the compact drawer and the navigator. The groups follow the canvas: daily operations with no
    heading, then «التكامل», then «الإدارة». The active entry takes the teal wash, the strong
    weight and the Signal Line. A **count pill** after an entry's label is allowed only where a
    query the shell already loads gives the number; never a request just for a count. None
    ships yet.
  - **Top bar** (`--shell-topbar-h` 64px): the compact menu button and mark (≤768px), the
    **Ctrl K navigator** button, and the **user menu**. Nothing without backing (notifications,
    system status) is rendered.
  - **Ctrl K navigator** (`Navigator.tsx`): a client-side command palette over the role's
    destinations and the stores in scope; no new contract (the stores are the scope menu's own
    query). Ctrl+K / ⌘K or the button opens a modal dialog holding a combobox and a grouped
    listbox (`aria-activedescendant`). Arrows move, Enter chooses, Escape closes, Tab stays,
    focus returns to the invoker. A page choice navigates (the unsaved-work blocker still
    guards it); a store choice runs `useScopeChange`, the switcher's guarded path. A shortcut
    pressed while another modal is open does nothing.
  - **User menu** (`UserMenu.tsx`): avatar, name and role on a disclosure button (not a
    `role="menu"`) whose panel holds the language (RT-399) and theme (RT-398) switches,
    unchanged. The user's stored language and theme are adopted when the shell mounts.
  - **Page header** (`src/components/PageHeader.tsx`), the first thing every routed page
    renders: `title` (the page's one `<h1>`, 24px), `subtitle` (one muted line: scope or what
    the page shows), `children` (status chips or a second note, under the subtitle),
    `actions` (at most one primary; destructive last) and `segmented` (a view switch,
    `aria-pressed` buttons in a group; the pressed segment is the action-fill pair, §12.6),
    both at the inline end on the text's last line and wrapping under it when narrow. `titleRef` makes the title a focus target; `titleId` lets a
    region be labelled by it. A back link sits above the header, not in it.
    `tests/unit/page-header.test.tsx` fails if a page inside the shell writes its own `<h1>`.
  - **Content container** and **section panel**: §5.
- **Form template** (`src/components/FormPage.tsx`, `FormField.tsx`, RT-971, canvas «نموذج»):
  every create/edit form uses these parts, so no form keeps its own layout classes
  (`tests/unit/form-template.test.tsx`).
  - `FormPage`: a back link above the `PageHeader`, the page's banners (`notices`), then the
    body. The body holds the form panel and an optional `FormAside` beside it ("what happens
    next"); the aside wraps under the panel when narrow. `after` holds page sections that are
    not part of the form, such as the store status control.
  - `FormPanel`: the `<form>` itself, so the unsaved-work guard still tracks it.
    - `panel` (a full page): one column, at most `--form-panel-max` (720px), with a 1px edge,
      the object radius and no shadow. `FormErrorSummary` sits at its top. The action bar at
      its foot (primary, then Cancel as `.btn-ghost`) sticks to the viewport bottom while the
      form is taller than the viewport.
    - `plain` (a drawer, or a form inside a section panel): the same parts with no surface of
      its own, since panels never nest. Drawer forms do not use the summary.
  - `FormSection`: a `<fieldset>` whose `<legend>` is the section title, with one or two
    columns. `disabled` locks every control in it.
  - `FormField`: label above the control, then the hint and the inline error.
    - The required mark is a danger-coloured `*` drawn by CSS with empty alt text, so it is
      not part of the label's text or name; the control carries `aria-required`.
    - The error is `aria-invalid` + `aria-describedby`. It is a live region only with
      `announceError`, for a form with no summary.
- **Public screens** (`src/auth/AuthLayout.tsx`, RT-971, canvas «تسجيل الدخول»): sign-in and
  accept-invitation.
  - A form panel at the inline start holds the brand lockup, the language switch
    (`LocaleSwitch`, no user), the centred form and the audit note.
  - The artwork panel at the inline end is `aria-hidden` and hidden below 900px. The whole
    frame is the night scene of §12.1, dark in both themes (*amended 2026-11-08*).
  - No card and no `box-shadow`. The only glow is the mint one allowed in §12.1 (the form
    side's radial glow and a `drop-shadow` on the branch line's centre shield).
  - Passwords use `PasswordInput`: no placeholder, and a «إظهار كلمة المرور» toggle
    (`aria-pressed`, `aria-controls`) with the registry's `reveal` / `conceal` glyphs.

**Notes on these components.**
- **Focus:** every focus stop draws the global outline (`src/styles/a11y.css`, RT-267) in
  `--color-focus-ring`. No box-shadow-only focus remains; new work keeps the outline.
- **Gold:** retired by RT-396 (the scope header, nav marker and icon, `TowerMark`,
  `.badge--gold` and the gold shadow ring). Do not reintroduce it.
- **DataTable sort and selection (RT-753, UX-10):** the table never reorders rows and
  never owns the sort order, the selection state or the count; the caller owns all three.
  - *Sort:* mark a column `sortable` and pass `sort` / `onSortChange`. Use
    `sortRows` (`src/components/tableSort.ts`) only for a complete in-memory set; a paged
    or server-backed list sorts at the query layer, never by reordering the visible page.
  - *Selection:* wire `useRowSelection(scopeKey, rowKeys)` to `DataTable`'s `selection`
    prop and `SelectionSummary`. Put the tenant, store, filters **and sort** in
    `scopeKey`, so changing any of them clears the selection. Memoise `rowKeys`.
  - Only rows currently listed count. The count names its scope ("selected on this
    page"). Offer "select all matching" only when the caller has an authoritative total
    and a handler; with no backend contract, leave `allMatching` out.
  - A checkbox toggles selection only; it never opens the row. With selection on the row is
    neither a click target nor a tab stop (RT-756): an explicit «Open» button in its own
    cell, right after the checkbox, calls `onRowActivate`. It is named from
    `selection.rowLabel` ("Open Alpha"), so the visible «Open» is inside the accessible name
    and the caller needs no extra label prop. Tab order per row: checkbox, then open.
    Without `selection` the whole row is still the target and nothing changes.
  - Target size (RT-757): the 36px floor applies inside tables. The whole selection cell
    (header and row) is the target and the checkbox keeps its 18px glyph; the sort button
    keeps its text-sized box and gains a 36px hit area (`::after`), so the header does not
    grow. New table controls follow the same pattern: enlarge the hit area, not the row.
  - Composed behaviour is pinned in `tests/unit/data-table-selection.test.tsx`, the open
    control in `tests/unit/data-table-row-open.test.tsx`. Known gap: RT-758 (dedicated sort
    glyph and a way back to server order).

## 10. Migration debts

Each debt is tracked separately. Do not fold them into feature work.

| Debt | Constitution rule | Ticket |
| --- | --- | --- |
| Arabic-first locale + RTL: `lang`/`dir`, logical CSS, message catalog, UX-12 terminology, formatters | UX-11, UX-12 | **RT-266** (planning) → **RT-399** (Arabic default + English second locale). Still open: Store time zone (RT-401), owner-approved Admin role labels (RT-266 Q4), `error.code`-first error copy (RT-266 §3.3) |
| Forced-colors support and outline-based focus baseline | UX-11 | **RT-267** |
| Complete Store scope switcher (All Stores → authorized Store) + dirty-context guard | UX-09 | **RT-268** (with RT-354 — scope menu cannot switch store) |
| Audit search keeps loaded rows when a later page fails + inline continuation retry | UX-10 | **RT-269** |
| Remove RF-* dev-gated entries from production navigation | UX-09 | **RT-270** |
| Semantic icon registry + Fluent System Icons fit / licensing / bundle PoC | UX-03 | **RT-263** |
| Light-first token migration: Mineral Daylight neutrals + Tower Teal roles; retire Tower Gold, navy action and the dark default | UX-02, UX-04 (radius 8/12/16) | **RT-396** |
| Opt-in dark theme: `[data-theme="dark"]` roles, top-bar switch, per-user persistence, no light flash | UX-02, UX-11 | **RT-398** |
| Admin type migration Inter → Dubai (with Arabic line-height and the 12px floor) | UX-03 | **RT-397** |
| Reconcile `PRODUCT.md` Principle 6 and the anti-reference note with light-first | UX-02 | **RT-966** (resolved) |
| Shell v3: sidebar with scope switcher, top bar with Ctrl K navigator and user menu, page header, content container | UX-04, UX-09 | **RT-969**. Screens follow: Overview v2 (RT-970), detail template (RT-961), forms and sign-in (RT-971), control states (RT-959) |
| v4.0 "Ink & Receipt": (a) Ink/Mint and elevation role tokens, light now, dark after §12.8.4; (b) Ink sidebar + Mint signal line; (c) receipt card + pipeline rail components; (d) Overview v4 (charts with table views); (e) display face; (f) list header bands and drawer headers (D-V9); (g) remaining screens per slice | UX-02, UX-03, UX-04, UX-13 | **Shipping in slices — no longer "approved, not shipped".** On `main`: (a) the Ink/Mint/action-fill role tokens, light and dark (§12.8.4 decided 2026-10-31; `--color-action-fill` shipped by RT-1037); (c) the receipt card + pipeline rail as the Overview's `ReceiptRow` + `SaleRail`; (d) Overview v4 (RT-993; §12.8.2 good directions recorded 2026-11-01 in `src/metrics/metricRegistry.ts`, §12.8.6 three widgets render «قريبًا» frames). Still to land: (b) Ink sidebar + Mint signal line; (e) display face, waiting on §12.8.3 (licence + A/B); (f) list header bands and drawer headers (D-V9); (g) remaining screens per slice. **Not filed yet.** One Jira issue per letter. |

## 11. Do's and Don'ts

**Do**
- Use role tokens, never raw hex, so the light-first token slice can remap roles in one place.
- Put each data region in one section panel, its table edge to edge under the panel header;
  reserve cards for genuine objects.
- Start every routed page with `PageHeader`.
- Give every state a non-color cue (text, icon, shape) and verify it in forced-colors.
- Use logical CSS properties in any line you write or rewrite.
- Isolate machine data (`dir="ltr"` / `<bdi>`) and keep it monospace.
- Keep operational state in persistent banners; respect `prefers-reduced-motion`.

**Don't**
- Add new gold, new navy-as-brand or dark-only surfaces; that deepens retired identity. (The
  v4.0 Ink sidebar is the one sanctioned dark surface, §12.1.)
- Use a box-shadow as the only focus indicator, or `outline: none` without an outline
  replacement.
- Use success/warning/danger/info as a chart palette, or color alone for meaning.
- Put a table inside a card, or nest a panel or card inside a section panel.
- Build a stat-card grid or a hero metric outside the Overview; the Overview's one receipt
  KPI row and pipeline rail (§12.4) are the only status-at-a-glance surfaces.
- Animate truth values (count-ups, rolling money), add bounce easing or page-load choreography.
- Copy design-handoff prototype themes, KPI coloring or dual-axis charts into production.
- Introduce a new package (including Tailwind or an icon or i18n library) without an
  authorizing Jira issue.

## 12. v4.0 "Ink & Receipt" (owner decision 2026-10-30, approved; shipping in slices — §10 and §12.8 name what is on `main`)

The reference is board v9 «✓ المعتمد · نظرة عامة v9» on the canvas
<https://claude.ai/artifact/7LkLBupz4nTpvB4P4k4NW4>. A versioned copy of the source of every current
board, with an index mapping each board to its Jira slice, is in
[`docs/design/v9/`](docs/design/v9/README.md). Where the canvas and this section differ,
this section wins; where a rule here is silent, §1–§11 still apply. Values below are the
**target tokens**: the slices already on `main` have landed them in `src/styles/tokens.css` as
roles (see §10), and components never spell the hex.

### 12.1 Color

| Target role | Light | Use |
| --- | --- | --- |
| `--color-ink` | `#0a2125` | Sidebar surface; the hero receipt card; the one "ink" button style; the selected segment on light surfaces (D-V3); tooltip fill; list header bands and drawer headers (D-V9); the ground of the public night frame (sign-in, accept invitation) is derived from it, see §12.1. |
| `--color-mint` | `#5fe0cf` | Highlight **on Ink only** (D-V2): the active nav signal line and icon, hero figures' accent, chart focus point, the selected segment on Ink, the `Ctrl K` key, and the primary fill on Ink (bands, drawer headers, dark theme). Never text **or fill** on a light surface (it measures 1.6:1 on white). In the dark theme it is also the primary fill and the selected segment, with Ink text, never text or a link colour (D-V10). |
| `--color-ink-muted` | `#a9c2c5` | Secondary text on Ink (≥ 4.5:1 on `--color-ink`). |
| `--color-canvas` | `#f2f5f6` | Page background (replaces `--color-background` as the work surface value). |

- **Tower Teal stays the intent color** on light surfaces (links, primary emphasis, chart
  series 1). Mint is the teal family's highlight for dark surfaces, not a second brand hue, so
  the "no secondary accent" rule holds.
- **The sidebar is Ink in both themes.** It is the one sanctioned dark surface; content
  surfaces stay light-first, and the dark theme remaps them as before.
- **The public screens are one night scene** (owner decision 2026-11-08, "board B"). It
  supersedes PW-5 (flat Ink panel, RT-972 comment 14943, RT-807) and PC-5 (light form side)
  **for sign-in and accept-invitation only**; every other form aside stays light.
  - The frame (`src/auth/AuthLayout.tsx`) is dark in both themes. It sets
    `data-theme="dark"` on its own wrapper, because the user's theme is not known before
    sign-in, so the dark roles and the mint primary button with Ink text apply with no new
    component styles.
  - The ground is the artwork's near-black, derived from `--color-ink` in `signin.css`
    (`--auth-night`); there is no new global token.
  - The artwork is a 506px, 9:16, `aria-hidden` panel, hidden below 900px. The artwork and
    the logo are real same-origin files imported with `?no-inline`: the Caddy CSP is
    `default-src 'self'`, so a `data:` image (which Vite inlines under 4 KB) is blocked.
  - The form side may carry a mint glow, a faint tower line drawing and a branch line
    (`aria-hidden`, decoration). Mint is a fill, glow and stroke, never text (D-V10).
  - The picture's own words (logo, English tagline) are baked in and are not localized.
  - Still no card and no box-shadow, and no pipeline or ERP wording on a public screen.
- **Expressive surfaces (D-V4 + D-V9).** Gradients, glows, textures and illustration appear
  **only** on: the hero receipt card, the Ink sidebar (Tower grid), the brand mark, chart area
  fills, hero bands on detail pages, the top band of entity cards (the store skyline), list
  page header bands and drawer headers (§12.6), and the public night frame (sign-in and
  accept-invitation, above). Still none on tables, forms, operational
  buttons, banners or status surfaces. Pure ornament (skyline, storefront, Tower grid) is
  `aria-hidden`, at most 55% opacity, and hidden on narrow screens.
- **Status colors are unchanged** (§3). Red, amber and green appear only on real states, and
  always with text.
- **Dark theme (D-V3, D-V10):** the primary fill and the selected segment are Mint with Ink
  text. The four Ink roles keep their light values; canvas and the resting shadow take the
  dark values in §12.8.4.

### 12.2 Signatures

- **Receipt card** (KPI cards and the payment summary only, D-V5): a section-panel surface split by a 2px dashed perforation with
  half-circle notches at both inline edges. Top part: label, figure, icon tile at the inline
  end. Bottom part: the delta chip and its comparison text. The notches are decorative
  (`aria-hidden`); the card is one `<article>` or list item with the label as its name.
- **Hero receipt**: the first KPI (net sales) on Ink with a Mint radial glow, the Tower grid,
  a figure in white and a 14–16 point sparkline. At most one per screen.
- **Pipeline rail**: POS → server → ERPNext as three nodes (status dot + name + one fact)
  joined by a dotted line, in a `role="group"` named «مسار البيع». Each node's fact is text,
  so the rail reads without color. It replaces the v3.0 pipeline strip on the Overview; the
  sync screen keeps the full pipeline.
- **Tower grid**: a faint 22–28px line grid (Mint at 5–6%) on Ink surfaces only.
- **Mint signal line**: the active nav entry gets a 4px Mint bar at the inline start with a
  soft glow, a Mint icon and a faint Mint wash. It replaces the teal wash in the sidebar.
- **Section index**: a small badge («01», «02», …) before each Overview panel title. Optional
  elsewhere; never on a screen with a single panel.
- **Data-bearing illustrations** (D-V5): fleet map, device dots, credential-life ring,
  business-day bar, live clock. Each has a text alternative or sits next to the same fact in
  text, colour never carries its meaning alone, and none renders without a backing source
  (§12.8.6).
- **Brand mark**: three ascending bars on a Mint-to-teal tile (tower and chart at once). It
  replaces the `TowerMark` glyph in the sidebar lockup once a slice draws the final asset.

### 12.3 Typography

- **Display face** for the Overview greeting, section titles, KPI and table figures, chart
  labels and the `Ctrl K` key: **Readex Pro** (400/500/600/700, owner decision 2026-10-30,
  self-hosted). Body and controls stay Dubai. Adoption waits on the A/B evidence in §12.8.
- Overview greeting `<h1>` 32px; hero figure 34px; KPI figures 30px; every other screen title
  stays 24px. Figures stay tabular and LTR-isolated.
- **Currency chip**: the currency code (`EGP`) as a small display-face chip after the figure
  in KPI cards and the donut center. Tables and ledgers keep `1,250.00 EGP` inline (§8).

### 12.4 Overview composition

From the top: greeting + pipeline rail; one slim alert banner (What → Safety → Action, ink
action button, red inline-start edge); one row of receipt cards (hero + up to three); a daily
trend chart (current vs previous period, hover tooltip with the difference) beside a category
donut whose legend is a real `<table>` (name, amount, share); the latest-sales table. A side
column holds quick actions (at most four, one color family, each with a one-line description),
stores today (rank, net, share bar, status text) and low stock sorted by severity (a level bar
per item, red only below the critical level). Each chart has `role="img"` with a summary
label and a "view as table" path; the trend chart's period is a segmented control.
Binding (D-V7, UX-13): each KPI names its scope, period, baseline and freshness; each chart
keeps gaps for missing buckets; the hero sparkline states its period (for example «آخر 14
يومًا»); the donut has at most five categories, in the `--color-viz-*` palette.

**Shipped on existing contracts (RT-993).** Each item uses only reads that already exist:

- **Greeting and rail.** The greeting is the page's `<h1>`, «مرحبًا، {name}», or «نظرة عامة»
  when the user has no display name. The pipeline rail sits under it. The POS node's status is
  `unknown`, because the contract records no connectivity. The screens behind the rail are
  links beside it.
- **Receipt row.** The hero is **received sales today so far**, not net sales; net sales and
  average basket need a contract (RT-975). Transactions, returns and voids follow. One shared
  line names the scope, the period, the date and the `asOf` time, and every card points to it.
  Each delta names its baseline, the previous business day in full.
- **Trend chart.** The question it answers is printed under its title. It shows the last 7 or
  14 business days, chosen with a segmented control, against the same days of the period
  before. Both periods come from one 30-day summary read.
- **Part-to-whole chart.** The board's category donut has no read, so the ring shows today's
  `erpPosting` buckets: posted, pending, failed and unknown. Together they make up today's
  received count. The legend is a real `<table>` with state, count and share.
- **Side column.** It holds quick actions, the attention list (RT-559), and «قريبًا» frames
  for stores today and low stock (§12.8.6).
- **Not shipped:** the alert banner (it needs a decided alert source) and the Readex Pro face
  (§12.8.3).

### 12.5 Surfaces, shape and elevation

- Section panels and receipt cards: `--color-surface`, 1px border, **20px radius**, one
  resting elevation token (a 1px hairline plus a 32px, −24px spread shadow at ≈25% Ink).
  Controls 10–12px, the top-bar search 14px.
- **Table rows as strips** (Overview and other read-only tables): rows separated by 6px gaps,
  each a sunken strip with a 12px radius. A row in a failure state carries a 3px red edge at
  the inline start plus its status pill. Selectable tables (§9 DataTable) keep the ruled rows.
- The top bar is translucent white with a backdrop blur over the canvas.

### 12.6 Components

- **Buttons:** primary actions on light surfaces become **ink** (`--color-ink` fill, white
  text, a short Ink shadow, −1px lift on hover). Teal stays for links, focus and the other
  selection states on light surfaces (selected rows, checked boxes and radios, chosen chips). `.btn-secondary` / `.btn-ghost` / danger variants and all §9 grammar
  (one primary, ghost cancel, danger-quiet → destructive, busy, 36px) are unchanged.
- **Segmented control and tab sets (D-V3, owner decision 2026-10-30):** on light surfaces the
  selected segment is Ink with white text; on Ink it is Mint with Ink text (D-V2). It keeps
  `aria-pressed`/`aria-selected` and a difference beyond colour (the filled shape against
  unfilled siblings, or weight), and maps to `Highlight`/`HighlightText` under forced colours.
  **Shipped for `.segmented` (RT-1039):** the pressed segment reads `--color-action-fill` with
  `--color-on-action-fill` (Ink with white on light, Mint with Ink on dark) on its recessed
  track, with the stronger weight; unpressed hover stays neutral; under forced colours every
  segment keeps a `ButtonText` boundary and the pressed one is `Highlight`/`HighlightText`.
  The device detail tabs (`DeviceTabs`) keep the Teal Signal Line until a board draws a
  filled tab set (the Devices board draws none; open decision, RT-1039).
- **Status pill:** keeps text; its marker becomes a small rotated square.
- **Avatars:** initials on Ink with Mint text, 8–14px radius by size.
- **Sidebar footer:** a system-status block and a support card are allowed only with a
  backing source (§9 top-bar rule): nothing renders without real data or a real destination.
- **List header band (D-V9):** one Ink band per list page holds the group label, the `h1`,
  a scope subtitle, the single primary (Mint fill, Ink text) and at most three facts the
  server serves for the whole set. A paged list shows scope and period, never a total.
  Filters, banners and state stay below it, and it never changes colour with state. At
  most 132px tall at 1280px; below 640px it becomes a plain light header. Ornament is
  `aria-hidden` at ≤55% opacity; under forced colours it maps to `Canvas`/`CanvasText`.
- **Drawer header (D-V9):** invite, edit and detail drawers may open with an Ink strip
  (title, scope line, close). The form body stays light.
- **Icon tiles:** one teal/Ink family (UX-03); an icon is coloured only when it carries
  status.

### 12.7 What v4.0 amends

| Earlier rule | Now |
| --- | --- |
| §2 / §11: one KPI ledger strip, no stat cards, no hero metric, no charts on the Overview | One receipt row with one hero, plus two charts with table equivalents, on the Overview only (§12.4). |
| §3: no forced dark sidebar | The sidebar is Ink in both themes (§12.1). |
| §2: identity not from ornament | Ornament only on the expressive surfaces in §12.1 (D-V4, D-V9). |
| §3: no gradients | Only on the expressive surfaces in §12.1. |
| §12.1 PW-5 (flat Ink public panel) and PC-5 (light form side) | The public screens are one dark night scene with artwork, a glow and a line drawing; other form asides stay light (§12.1, owner decision 2026-11-08). |
| §4: Dubai only; nothing at page level larger than 24px | Display face for headings and figures (pending §12.8); Overview greeting and KPI sizes (§12.3). |
| §5: panels shadowless; 8px controls, 12px objects | One resting elevation; panels and cards 20px, controls 10–12px, top-bar search 14px (§12.5). |
| §9 nav: teal wash + Signal Line | Mint signal line on Ink (§12.2). |
| §9 buttons: `.btn-primary` teal fill | Ink fill on light surfaces (§12.6). |
| §9 / UX-02: teal owns selection | The selected segment of a segmented control is Ink on light surfaces (tab sets: open, RT-1039); other selection stays Teal (D-V3, §12.6). |

### 12.8 Decisions and open items before implementation

Items 1–3 and 7 are owner decisions of 2026-10-30 (1–3 each with a remaining step); item 4 is
an owner decision of 2026-10-31 (D-V10); items 5–6 are open. Item 2's good directions were
recorded and item 6 was amended for three widgets by owner decision on 2026-11-01 (RT-993).

1. **Constitution amendments — decided: amend the Constitution.** §1 puts the UX
   Constitution above this file, so the rows of §12.7 that touch UX-02 (dark surface,
   gradients, ornament, primary-action fill), UX-03 (display face) and UX-04 (elevation,
   radius, Overview composition) are amended in Confluence (RETAIL), not excepted for the
   Console. **Approved and published 2026-10-30** as
   [Owner decisions 2026-10-30 — Admin-Console visual direction v4.0](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/62816260)
   (D-V1…D-V9, Confluence 62816260, under the Decisions register 5341185). D-V9, the list
   and drawer header bands, was approved and added the same day.
2. **Delta colour — decided: green/red by good direction.** A period delta is green when it
   moves the way the business wants and red when it moves against it, with the arrow, the
   signed value and the named baseline always shown. The colour follows each metric's
   declared good direction, not the arrow: returns, voids and stuck postings rising is
   **red**. A metric with no agreed good direction stays neutral. This **complies** with
   UX-13 ("Direction Is Mathematics. Judgment Is Domain Meaning") and needs no amendment;
   it does need each KPI's good direction recorded in its metric contract.
   **Recorded 2026-11-01** (owner decision, RT-993 comment 15088). Each entry in
   `src/metrics/metricRegistry.ts` has a `goodDirection` and names the buckets it judges.
   `deltaTone()` turns a movement into good, bad or neutral. A bucket outside the judged
   list stays neutral; for example, more posted sales never reads red.

   | Metric | Good direction | Buckets judged | Colour when they rise |
   | --- | --- | --- | --- |
   | `receivedSales` | up | amount and count | green |
   | `voids` | down | amount and count | red |
   | `returns` | down | amount and count | red |
   | `legacyRefunds` | down | amount and count | red |
   | `syncStatus` | down | `captured` (pending), `failedRetryable`, `failedNeedsRepair` | red |
   | `erpPosting` | down | `pending` (stuck), `failed`; not `posted` or `unknown` | red |
   | `shiftCloses` | down | `withVariance` | red |

   The signed value is the exact difference within one currency, or between two counts.
   Today so far is compared with the previous business day in full, so received sales can
   read red early in the day. Whether to keep it neutral while today is still "so far" is
   **open** and has been asked on RT-993.
3. **Display face — decided: Readex Pro, self-hosted.** No Google Fonts at runtime (the CSP
   allows `'self'` only). Adoption needs (a) a license-checked (OFL) Arabic + Latin subset
   served from the Console, and (b) same-screen A/B evidence against Dubai (§4). Dubai stays
   the body face.
4. **Dark-theme values — decided 2026-10-31 (RT-990; D-V10 in Confluence 62816260).** The
   sidebar is Ink in both themes (D-V1) and Mint is fixed (D-V2), so four roles repeat their
   light value; only canvas and the resting shadow are new. Restate all of them in the
   `[data-theme="dark"]` block (the token test resolves dark pairs inside that block).

   | Role | Light | Dark |
   | --- | --- | --- |
   | `--color-ink` | `#0a2125` | `#0a2125` |
   | `--color-mint` | `#5fe0cf` | `#5fe0cf` |
   | `--color-ink-muted` | `#a9c2c5` | `#a9c2c5` |
   | `--color-on-ink` | `#ffffff` | `#ffffff` |
   | `--color-canvas` | `#f2f5f6` | `#0e161f` (the approved dark `--color-background`) |
   | `--shadow-resting` | `0 1px 2px rgb(10 33 37 / 0.04), 0 12px 32px -24px rgb(10 33 37 / 0.25)` | `0 1px 2px rgb(14 22 31 / 0.6), 0 12px 32px -24px rgb(14 22 31 / 0.9)` |

   - **Mint in the dark theme (D-V10 amends D-V2):** a fill with Ink text, the primary action and
     the selected segment (D-V3), on dark panels and canvas; never text or a link colour (links
     stay Tower Teal). Light stays Ink fill with white text, so the slice adds a derived fill and
     on-fill role pair, `--color-action-fill` / `--color-on-action-fill` (light `ink`/`on-ink`,
     dark `mint`/`ink`; shipped by RT-1037); `--color-ink` itself never
     becomes Mint, as it is also the sidebar, band and hero surface.
   - **Ink separates by edge, not luminance, on dark** (accepted): Ink is 1.09:1 against the dark
     canvas and 1.03:1 against dark panels, so the sidebar, bands, hero and tooltip read through
     the 1px border, the Tower grid and the Mint glow. Under forced colours they map to
     `Canvas`/`CanvasText` (item 5).
   - **The resting shadow is a depth cue only.** It is an alpha of the dark background, so it is
     nearly invisible on the canvas; the 1px `--color-border` carries the panel edge.
   - **Contrast pairs** (`[foreground, background, minimum]`, role names without `--color-`),
     proposed as `V4_DARK_PAIRS` in `.design-sync/contrast-pairs.mjs`; the forbidden list
     (`mint` on `surface`) is light-only, because the Mint fill is sanctioned on dark:

     ```js
     export const V4_DARK_PAIRS = [
       ['ink-muted', 'ink', 4.5], ['on-ink', 'ink', 4.5], ['mint', 'ink', 3], ['ink', 'mint', 4.5],
       ['mint', 'canvas', 3], ['mint', 'surface', 3], ['mint', 'surface-sunken', 3],
       ['text', 'canvas', 4.5], ['text-muted', 'canvas', 4.5], ['control-border', 'canvas', 3],
       ['focus-ring', 'canvas', 3], ['primary-emphasis', 'canvas', 4.5],
       ...['success', 'warning', 'danger', 'info'].map((s) => [s, 'canvas', 4.5]),
     ];
     ```

     Measured, all passing: ink-muted on ink 8.92; on-ink on ink 16.70; mint on ink 10.38; ink
     on mint 10.38; mint on canvas 11.32, on surface 10.12, on surface-sunken 10.90; text on
     canvas 15.44; text-muted and control-border on canvas 8.21; focus-ring 7.49;
     primary-emphasis 9.95; success 8.88, warning 8.81, danger 8.02, info 8.05.
   - **Not adopted from the v9 «Sales dark» board:** its teal-tinted surface family (`#091719`,
     `#10242a`) and its control border `#2f5158` (1.86:1, under the 3:1 control boundary). The
     board stays the reference for Ink, Mint, the Mint-tinted nav wash and the Mint fill.
5. **Forced colours (required evidence, not an open decision):** receipt notches, the Tower
   grid and glows disappear; the perforation falls back to a `CanvasText` dashed rule; Ink
   surfaces, bands and the hero card map to `Canvas`/`CanvasText`.
6. **Data sources:** the sidebar system-status block, the support card, store "share of
   today", low-stock severity, the credential-life ring and the business-day bar each need a
   backing read; render none of them without it.
   **Amended 2026-11-01 for three widgets** (owner decision, RT-993 comment 15088): store
   "share of today", low-stock severity and the sidebar system status each render their frame
   with a clear «قريبًا» state (`overview.soon`, `shell.status.soon`; UX-12 message keys).
   They show no invented number or state, no link and no status colour. Each waits on a
   Backend-Core read:
   - store share: RT-1053, the runtime of the `consoleGetSalesByStore` contract, which
     serves a server-computed `share`;
   - low-stock severity: RT-1055 (contract first, because no reorder level exists yet);
   - system status: RT-1056 (contract first).

   The support card, the credential-life ring and the business-day bar still render nothing.
7. **Selected segment on light surfaces — decided: Ink.** D-V3 was amended in Confluence
   62816260 (version 3): Ink with white text on light surfaces, Mint on Ink; every other
   selection on light surfaces stays Teal (§12.6).

## 13. v5.0 "Console system v3" (owner decisions D7–D9, 2026-11-26; adopted target, shipping in slices)

On 2026-11-26 the owner adopted «Console system v3» as the Admin Console target (RT-1608; decisions
D7, D8 and D9 below). v5.0 is the documented authority for that target. **It is adopted, not
shipped:** `main` renders v4.0 (§12) until the v3 slices in §13.11 land. Each slice moves one
part. Until a slice lands, §12 remains the rule for the part it has not moved.

- **Source boards:** the canvas page «Console system (D7/D8)» on
  <https://claude.ai/artifact/UM38B46McW41STtVDrY5Pi> (private). A versioned copy of every board,
  with an index mapping each board to its slice, is in [`docs/design/v3/`](docs/design/v3/README.md).
- **Rules win over boards.** Where a board and this section differ, this section wins. The
  known differences are listed under the rule concerned, for example control borders in §13.2.
- **Governing decision page:** Confluence RETAIL 62816260 holds the v4.0 decisions
  (D-V1…D-V10). Its supersession section records, for each one, what v3 keeps, amends or
  replaces (§13.9).

### 13.1 Decisions

| ID | Decision (owner, 2026-11-26) | Record |
| --- | --- | --- |
| D7 | Reopen the visual direction: modernise toward the reference pack (Shopify App Home patterns, Linear's calm interface, Ramp approvals, Stripe search) **as behaviour references only**. No third-party identity, layout, asset or code is copied. | RT-1608 comment 19027 |
| D8 | Seven areas with tabs replace the four menu groups (supersedes D4). Alerts, Search and the organisation switch move to the top bar. No page is removed, and role gates are unchanged. | RT-1608 comment 19028 |
| D9 | Adopt Console system v3: the D8 navigation, the Understand → Decide → Act rhythm, the "Retail Tower Soft" look with the Ink band and receipt strip kept, and the truth rules in §13.7. | RT-1608 comment 19041 |

Earlier RT-1608 decisions still apply:
- **D1:** the non-technical merchant owner is the primary user.
- **D2:** the business-word glossary; ERPNext terms appear only behind «تفاصيل فنية».
- **D3:** one Overview whose content is ordered by role.

### 13.2 Colour roles (target)

Components consume roles only. `src/styles/tokens.css` stays the only place a value is
spelled (§1). Roles marked *new* do not exist on `main` yet; RT-1610 adds them.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| `--color-canvas` | `#f3f4f2` | `#0e1415` | Work surface. A warm neutral, replacing the cool `#f2f5f6`. |
| `--color-surface` | `#ffffff` | `#172021` | Panels, tables, drawers. |
| `--color-surface-sunken` | `#f7f8f6` | `#121a1b` | Table head, recessed tracks, inputs on panels. |
| `--color-text` | `#14201f` | `#e9efee` | Primary text. |
| `--color-text-muted` | `#56605e` | `#a5b3b1` | Secondary text. It is also `--color-control-border`, the control boundary. |
| `--color-border` | `#dfe3e0` | `#2a3738` | Decorative dividers only, never a control edge. |
| `--color-primary` | `#007560` | `#4cc7ac` | Tower teal intent: links, focus, selection, chart series 1. Darkened from `#0f766e` to pass 4.5:1 on the new canvas. |
| `--color-primary-soft` | `#e2f2ee` | `#12302b` | Applied-filter chip fill, current-context wash. |
| `--color-selection` *new* | `#eef6f4` | `#1b2c2a` | Selected table row, with a 3px inline-start bar in `--color-primary`. |
| `--color-side` *new* | `#e9ece9` | `#121a1b` | The light sidebar surface (replaces the Ink sidebar; switched by V3-4, not by tokens alone). |
| `--color-side-text` / `--color-side-muted` *new* | `#24302f` / `#55625f` | `#dfe7e6` / `#9fb0ae` | Sidebar labels and icons. The active item is a raised `--color-surface` pill with a `--color-primary` icon. |
| `--color-ink` | `#0a2125` | `#0a2125` | Top bar, area header band, primary action fill on light. Unchanged. |
| `--color-mint` | `#5fe0cf` | `#5fe0cf` | **On Ink only** in light (D-V2): brand tile, avatar, primary action on the band. The dark primary fill (D-V10). Never text or fill on a light surface. |
| `--color-ink-muted` / `--color-on-ink` | `#a9c2c5` / `#ffffff` | same | Secondary and primary text on Ink. |
| `--color-topbar-field` *new* | `#14353a` | `#14292c` | Search field and switchers on the Ink top bar, with `--color-topbar-line` `#2d4d52` / `#2a4246` and `--color-topbar-muted` `#b9cccf` / `#a5b3b1`. |
| `--color-attention` *new* | `#ff6b5e` | `#ff6b5e` | The alert-count badge on the Ink top bar only, with Ink text. Never a status colour elsewhere. |
| `--color-action-fill` / `--color-on-action-fill` | Ink / white | Mint / Ink | Unchanged from RT-1037. |
| `--color-success` / `-soft` | `#1f6f43` / `#e4f3ea` | `#6fd39a` / `#16301f` | Proven success only. |
| `--color-warning` / `-soft` | `#8f5300` / `#fff2dc` | `#f0b45c` / `#3a2a12` | Caution, degraded, "working with problems". |
| `--color-danger` / `-soft` | `#b3261e` / `#fcebe9` | `#ff8a80` / `#3a1d1b` | Failure and consequence. **No longer the UNKNOWN colour** (see the unknown style below). |
| `--color-info` | unchanged | unchanged | Pending, information. Its pairs carry over from §12 and are re-measured on the new canvas by RT-1610. |
| `--color-viz-*` | unchanged | unchanged | Charts keep the RT-822 data palette. Series 1 in the daily-sales chart is `--color-primary`, as in v4.0. |

- **Unknown style (*new*, replaces "danger also means UNKNOWN"):** a pill or mark with a 1px
  **dashed** `--color-text-muted` outline, a «؟» glyph and the word «غير معروف» in `--color-text`.
  It differs from danger (filled red) and from in-progress (filled `--color-surface-sunken`)
  in shape and text, not only colour. Under forced colours the outline is `CanvasText` dashed.
- **Control boundary:** inputs, filter chips and segmented tracks draw their edge with
  `--color-control-border` (≥ 3:1). *Known board difference:* the v3 boards draw these edges
  with `--color-border` (`#dfe3e0`, 1.30:1 on `--color-surface`). This rule wins over the boards.
- **Dark theme:** the dark values above are the boards' values, and RT-1610 must confirm them
  with the token test. Ink keeps separating by edge on dark (§12.8 item 4).

### 13.3 Signatures (what keeps it Retail Tower)

- **Ink area header band.** Every area opens with an Ink band holding:
  - the area name as the `h1`
  - a one-line summary in `--color-ink-muted`
  - at most one Mint primary (Ink text) and outlined secondaries
  - a faint Tower grid (Mint at about 5%, `aria-hidden`)

  It extends D-V9 from list pages to every area. It is at most 132px tall at 1280px and becomes a
  plain light header below 640px. It never changes colour with state.
- **Receipt figure strip.** The day's figures sit on one `--color-surface` card split by a 2px
  dashed perforation, with half-circle notches in `--color-canvas` at both inline edges
  (`aria-hidden`). Above the perforation are the figures. Below it is one context line naming
  the scope, the period, the date, an absolute "as of" time and the comparison baseline. This
  replaces the v4.0 hero receipt and separate receipt cards (§12.2).
- **Pipeline strip.** «أجهزة البيع ← الخادم ← المحاسبة» as three nodes. Each node has a
  status dot and a **text fact** (for example «مسجّلة: 410 من 412»), joined by dotted rules in a
  `role="group"` named «مسار البيع». A note line under the nodes holds the shipped POS note
  (`overview.pipeline.posNote`) and the absolute as-of time. It continues the RT-992 rail.
- **Brand mark:** three ascending bars on a Mint tile, on the Ink top bar.
- **Not kept from v4.0:** the Ink sidebar with the Mint signal line, the Mint radial glow, the
  hero receipt, section index badges and the 20px radius.

### 13.4 Typography (target; face open)

- **Scale (px):**
  - 24/600: page title (`h1` in the band)
  - 17/600: section title
  - 15: navigation and decision headings
  - 14: body and table text (Arabic tables move up from 13.5)
  - 13: secondary text, meta, chart labels

  The Arabic floor is **13px** (raised from 12). Figures are tabular and LTR-isolated. Money is
  written «1,250.00 EGP» (UX-12).
- **Face: open.** The v3 boards use Google-hosted stand-ins: IBM Plex Sans Arabic for
  everything, and Noto Kufi Arabic for the page title only. §12.8 item 3 (Readex Pro display,
  Dubai body) is **not** re-decided here. RT-994 is re-scoped by V3-3 to choose between IBM Plex
  Sans Arabic and Dubai. Any chosen face is self-hosted: the Caddy CSP allows `'self'` only, so
  there are no Google Fonts at runtime.

### 13.5 Shell and navigation

- **Top bar (Ink, 52px):**
  - the brand mark
  - the organisation name as a menu (`aria-haspopup="menu"`, replaces `/tenants` in the menu)
  - search with `Ctrl K`, which finds receipts, items and stores
  - the store switcher
  - the alerts bell with a **visible count**
  - the account menu
- **Sidebar (light, 236px):** seven areas with icons, in this order:
  1. الرئيسية
  2. المبيعات
  3. الأصناف
  4. المخزون
  5. التقارير
  6. المحاسبة
  7. الإعدادات

  The parent area stays selected on child routes (UX-09.14). Role gates are unchanged: an area
  or tab the role cannot read is not rendered.
- **Tabs:** each area's pages are tabs under the band: underline tabs, the active tab in
  weight 600 with a 2px `--color-action-fill` underline (Ink in light, Mint in dark), real links
  with `aria-current="page"`. Tab labels are proposed copy: each needs UX-12 review and a message
  key.
- **Route mapping:** every route on today's menu or `Ctrl K` has an area and a tab. The mapping
  is board `S12-Route-map` in `docs/design/v3/` and is the input for V3-4. Every old URL
  redirects to its new place, and a moved page shows a one-time «انتقلت هذه الصفحة إلى …»
  notice.
  - Placements marked INVENTED on the board need the owner's confirmation: offers and vouchers,
    payer accounts, and the organisation switch.
  - `/posting-health` is marked *needs verification*.
- **Route mapping table** (normative; the same list is drawn on board `S12-Route-map`):

  | Route | Today (group · label) | Area | Tab | Read gate | Note |
  | --- | --- | --- | --- | --- | --- |
  | `/` | اليومية · نظرة عامة | الرئيسية | — | `always` |  |
  | `/alerts` | اليومية · التنبيهات | الشريط العلوي | جرس التنبيهات → صفحة التنبيهات | `always` |  |
  | `/search` | اليومية · بحث | الشريط العلوي | البحث + Ctrl K | `always` |  |
  | `/sales` | اليومية · المبيعات | المبيعات | كل المبيعات | `canReadSales` |  |
  | `/sales-daily` | Ctrl K فقط | المبيعات | اليومية (وأيضًا في التقارير) | `canReadSales` |  |
  | `/sales-by-store` | Ctrl K فقط | المبيعات | حسب المتجر (وأيضًا في التقارير) | `canReadSales` |  |
  | `/shift-closes` | اليومية · إقفالات الورديات | المبيعات | إقفالات الورديات | `canReadShiftCloses` |  |
  | `/offers` | الإدارة · العروض | المبيعات | العروض والقسائم | `canReadOffers` | INVENTED placement |
  | `/vouchers` | الإدارة · القسائم | المبيعات | العروض والقسائم | `canReadVouchers` | INVENTED placement |
  | `/payer-accounts` | الإدارة · حسابات جهات الدفع | المبيعات | جهات الدفع | `canReadPayers` | INVENTED placement |
  | `/reports` | اليومية · التقارير | التقارير | — | `canOpenAnyReport` |  |
  | `/catalog/products` | المخزون والأصناف · الأصناف | الأصناف | الأصناف | `canReadCatalog` |  |
  | `/catalog/import` | المخزون والأصناف · استيراد | الأصناف | استيراد | `canImportCatalog` |  |
  | `/catalog/brands` | المخزون والأصناف · العلامات التجارية | الأصناف | العلامات التجارية | `canReadBrands` |  |
  | `/unknown-items` | المخزون والأصناف · أصناف غير معروفة | الأصناف | أصناف غير معروفة | `canReadUnknownItems` |  |
  | `(new) /inventory overview` | — | المخزون | نظرة عامة | `canReadInventory` | CONCEPT: new workspace tab |
  | `/inventory` | المخزون والأصناف · حركات المخزون | المخزون | الحركات | `canReadInventory` |  |
  | `/inventory/transfers` | من داخل المخزون | المخزون | التحويلات | `canReadInventory` |  |
  | `/inventory/redistribution` | المخزون والأصناف · إعادة التوزيع | المخزون | إعادة التوزيع | `canReadRedistribution` |  |
  | `/tracking` | المخزون والأصناف · الحجز والاستدعاء | المخزون | الحجز والاستدعاء | `tracking gate` |  |
  | `/stock-discrepancies` | المخزون والأصناف · فروقات المخزون | المخزون | الفروقات | `canReadStockDiscrepancies` |  |
  | `/erp-connection` | التكامل · الاتصال والمزامنة | المحاسبة | حالة الربط | `canReadErpStatus` |  |
  | `/sales-needing-repair` | التكامل · مبيعات تحتاج إلى إصلاح | المحاسبة | مبيعات لم تصل للمحاسبة | `canUseSaleSyncOps` | label per D2 |
  | `/quarantined-sales` | التكامل · مبيعات تعذّر إرسالها | المحاسبة | لم تصل من الجهاز | `canUseSaleSyncOps` | label per D2 |
  | `/product-reconciliation` | التكامل · مطابقة المنتجات | المحاسبة | مطابقة المنتجات | `canUseProductReconciliation` |  |
  | `/posting-health` | مسار بلا عنصر قائمة | المحاسبة | صحة التسجيل | `?` | NEEDS VERIFICATION: tenant-facing? |
  | `/audit` | التكامل · سجل التدقيق | الإعدادات | سجل التدقيق | `always` | moved out of Integration |
  | `/stores` | الإدارة · المتاجر | الإعدادات | المتاجر | `always` | store roles = RT-1289 S2 |
  | `/operators` | الإدارة · المستخدمون | الإعدادات | المستخدمون | `always` | store roles = RT-1289 S2 |
  | `/devices` | اليومية · الأجهزة | الإعدادات | الأجهزة | `canReadDevices` | moved out of Daily |
  | `/devices/pairing-codes` | Ctrl K فقط | الإعدادات | الأجهزة › رموز الربط | `canReadDevices` |  |
  | `/devices/download-pos` | Ctrl K فقط | الإعدادات | الأجهزة › تنزيل تطبيق البيع | `canReadDevices` |  |
  | `/settings` | الإدارة · الإعدادات | الإعدادات | إعدادات المؤسسة (الهوية، سياسة النقد، خطة الذكاء، البيع المتتبَّع) | `canOpenSettings` |  |
  | `/tenants` | الإدارة · المؤسسات | الشريط العلوي | مبدّل المؤسسة (اسم المؤسسة) | `always` | INVENTED placement |
  | `/platform/*` | Platform Console | خارج هذا الهيكل | — | `platform_admin` | unchanged, RT-1589 |
- **Platform Console** (`/platform`) is outside this shell and is unchanged (RT-1589).

### 13.6 Page rhythm and patterns

- **Rhythm in every area: Understand → Decide → Act.**
  - Understand: a sentence and a few figures.
  - Decide: what needs the user, why, and who can act.
  - Act: one button, with the same label everywhere, that opens an existing screen.
  - Technical detail sits behind «تفاصيل فنية» for authorised roles (D2).
- **Decision card:** one list item with:
  - a status mark (a dot, or the dashed «؟» for unknown)
  - the head (what happened)
  - "why it matters"
  - «من يستطيع: …» (always present; a role that cannot act sees who can)
  - one button

  Only the first card in a region carries the primary fill. Each fix has one label everywhere
  (for example «أصلِح البيعتين»).
- **Work table:**
  - Full width and never inside a card (UX-10.1, UX-04.16).
  - The record identifier (for example the receipt number) is the keyboard target and opens
    the side drawer. The drawer keeps the list place.
  - A visible sort indicator with `aria-sort`.
  - The selected row has `--color-selection` and a 3px inline-start bar.
  - Money is end-aligned and tabular. One status pill per row.
- **Side drawer:** opens from the record identifier and keeps the list place: the list stays
  mounted, its scroll position and selection are kept, and the opened row is the selected row.
  - **Size:** 340–480px at the inline end; full width below 640px.
  - **Address:** the drawer has its own deep-link URL (the record route), so reload and share
    open the same record over its list.
  - **Order inside:** status in words, then content, then actions (one primary), then
    «تفاصيل فنية» for authorised roles.
  - **Behaviour:** it is a dialog with a focus trap. Focus moves to its heading on open, and
    Esc or the close button returns focus to the identifier that opened it (UX-11.8, UX-11.9).
- **Filters:** a search field, applied filters as solid `--color-primary-soft` chips with a
  chevron, and one dashed «+ مرشح» chip to add a filter.
- **States:** each panel loads and fails on its own.
  - Loading keeps the layout.
  - Empty says what was checked and when.
  - Stale shows the age and keeps the data.
  - Partial is labelled «جزئي».
  - Unknown uses the unknown style.
  - Error reads What → Safety → Action.
  - Permission shows who can act.
  - Approval states consequence, reversibility and audit before the button.
- **Home (D3, D9):** the order is:
  1. the pipeline strip
  2. «يحتاج قرارك»
  3. the receipt strip (received sales, transactions, returns, voids)
  4. the daily trend chart, with a matching legend, a hatched "today, incomplete" bar and
     «اعرض كجدول»
  5. latest sales

  A side column holds the owner's shortcuts, low stock (with the shipped caveat) and
  «من غيّر ماذا» with the audit link. The AI panel appears only when its rollout flag is on
  (RT-1541).
- **Reports:** a list grouped as today, with «يجيب عن:» per report, one headline figure and an
  as-of time for each available report, and «مقترح، غير متاح بعد» for proposed ones, which are
  not links.
- **Accounting:** a status sentence first (amber «يعمل، مع مشكلتين» while any sale is missing;
  green only when all are recorded), then the figures, the decision cards, the shipped
  repair-list caveat, and «تفاصيل فنية».

### 13.7 Truth rules

1. A total that can be incomplete says so: it is either labelled «جزئي» or carries the shipped
   «المستلَم فقط…» caveat. It is never compared as if complete.
2. Comparisons use **only the previous full business day** (`overview.kpi.compareNote`) until
   a contract serves another baseline. "Same hour yesterday" is not shown.
3. A card renders only when its backing read exists. Without the per-store read (C3), Home
   shows «حالة كل متجر على حدة غير متاحة بعد» instead of per-store cards.
4. Unknown is never zero and never danger-coloured: it uses the unknown style (§13.2).
5. Green appears only after the fact is proven (UX-05.16).
6. Shipped caveats carry over word for word, among them `overview.lowStock` «المستلَم فقط…»
   and the repair-list note «ظهور البيع … لا يعني …».
7. Every time on a decision surface is absolute first («حتى 9:12 م»), with relative time
   secondary.

### 13.8 Contrast (measured 2026-11-26; WCAG relative luminance)

Every small-text pair below is ≥ 4.5:1. Non-text marks (control border, focus, chart marks)
are ≥ 3:1. RT-1610 adds these pairs to `.design-sync/contrast-pairs.mjs`, next to the v4.0
pairs.

| Foreground | Background | Light | Dark |
| --- | --- | --- | --- |
| `text` | `canvas` / `surface` / `surface-sunken` | 15.15 / 16.72 / 15.69 | 15.98 / 14.27 / 15.17 |
| `text-muted` | `surface` / `canvas` / `surface-sunken` | 6.50 / 5.89 / 6.10 | 7.65 / 8.57 / 8.14 |
| `side-text` / `side-muted` | `side` | 11.46 / 5.35 | 14.05 / 7.82 |
| `primary` | `surface` / `canvas` / `selection` / `primary-soft` | 5.66 / 5.13 / 5.15 / 4.89 | 7.96 / 8.92 / 6.99 / 6.79 |
| `text` | `primary-soft` / `selection` | 14.46 / 15.22 | 12.17 / 12.53 |
| `success` | `success-soft` / `surface` | 5.36 / 6.15 | 7.76 / 9.06 |
| `warning` | `warning-soft` / `surface` | 5.58 / 6.17 | 7.49 / 9.00 |
| `danger` | `danger-soft` / `surface` | 5.66 / 6.54 | 6.71 / 7.27 |
| `on-ink` / `ink-muted` | `ink` | 16.70 / 8.92 | same |
| `on-ink` | `topbar-field` (typed search text) | 13.12 | 15.18 |
| `ink` | `mint` | 10.38 | 10.38 (dark action fill) |
| `topbar-muted` | `topbar-field` | 7.88 | 7.00 |
| `ink` | `attention` | 5.98 | 5.98 |

### 13.9 What v5.0 keeps, amends or replaces from v4.0

| v4.0 rule (§12, Confluence D-V#) | v5.0 |
| --- | --- |
| D-V1 Ink sidebar in both themes | **Replaced:** light sidebar (`--color-side`); Ink moves to the top bar and area bands. |
| D-V2 Mint on Ink only | **Kept** (light), with the D-V10 dark fill. |
| D-V3 Ink primary fill; Ink selected segment on light | **Kept.** |
| D-V4 expressive surfaces | **Amended:** the Tower grid only on Ink bands. No glows, no hero gradient. |
| D-V5 receipt card, data illustrations | **Amended:** one receipt strip per area replaces the hero and the separate receipt cards. The pipeline rail becomes the pipeline strip. |
| D-V6 elevation, 20px radius | **Replaced:** 12px panels, 9px controls, one light resting shadow. |
| D-V7 Overview composition | **Replaced** by the Home order in §13.6. |
| D-V8 Readex Pro display face | **Open** again (§13.4, V3-3). |
| D-V9 list and drawer bands | **Extended** to every area header. |
| D-V10 dark values | **Amended:** new dark neutrals (§13.2), the Mint dark fill kept. |
| §12.2 section index badges | **Dropped.** |
| §12.8 item 2 (delta colour by good direction) | **Kept** for deltas that are shown. Home figures show the baseline value instead of a coloured delta while today is "so far". |
| §12.8 item 6 (render nothing without a backing read) | **Kept** and generalised as truth rule 3. |

### 13.9b What v5.0 amends in the earlier sections and the Constitution

§1 places the UX Constitution above this file. The rows below change rules that the Constitution
backs, so they are Constitution amendments in the same way as §12.7 and §12.8 item 1. Each
must be **recorded as an owner decision** before the slice that implements it merges (§13.10
item 1). D9 adopted the v3 design, but the Constitution-level wording is not recorded yet.

| Earlier rule | v5.0 | Constitution rule |
| --- | --- | --- |
| §3 colour table and §9 status vocabulary: red marks danger **and every UNKNOWN**, never neutral. | UNKNOWN gets its own unknown style: a dashed outline, «؟» and the word «غير معروف». It is distinct from danger, from in-progress and from zero. Red stays for failure and consequence. A code the Console does not recognise is still shown as UNKNOWN, never as success. | UX-02 «Truth colours» |
| §6: scope lives in the sidebar; the ≤768px scope row. | The organisation and the store scope move to the top bar as menus. The top bar is visible at every width, so scope is never behind a menu (PRODUCT.md principle 1 kept). Scope change is still a guarded context transition. | UX-09 «Scope» |
| §4 and frontmatter `meta`: 12px readability floor. | Arabic text floor 13px. `tests/unit/tokens-identity.test.ts` keeps enforcing 12px until RT-1610 or V3-3 raises it. | UX-03 / UX-11 |
| §5 shape: 8px controls, 12px objects. | 9px controls, 12px panels and cards, overlays unchanged. | UX-04 «Radius rhythm» |
| §12.4 / D-V7 Overview composition (Constitution amendment of 2026-10-30) | The Home order in §13.6. | UX-04 (as amended by 62816260) |

### 13.10 Open items

0. **Record the §13.9b Constitution amendments** (UX-02 unknown style, UX-09 scope in the top
   bar, UX-03 13px floor, UX-04 radius) as owner decisions on Confluence 62816260, with pointers
   from the UX pages. This must happen before the first slice that implements them merges.

1. Typeface: IBM Plex Sans Arabic or Dubai, self-hosted (V3-3, RT-994).
2. The decision-queue source and ordering rule (which alerts become decisions, in what order).
3. The per-store read (C3, Backend-Core): until it exists, no per-store cards.
4. Global receipt search in `Ctrl K` needs a search contract.
5. What «أصلِح البيعتين» does: does linking an unmapped item re-post the sales automatically?
6. The stale threshold for Home, and the inventory overview contracts (excess, expiry: RT-1430).
7. INVENTED menu placements, whether `/posting-health` is tenant-facing, and which areas store
   roles see (RT-1289 S2).
8. Arabic tab labels and new copy need UX-12 review and message keys.
9. Phone: Admin phone workflows are not promised (UX-09). The boards show a read-only glance only.

### 13.11 Slices

| # | Slice | Jira |
| --- | --- | --- |
| V3-1 | This section, the v3 board sources, and the supersession record on 62816260 (Docs) | RT-1609 |
| V3-2 | v3 role tokens, light and dark | RT-1610 |
| V3-3 | Typeface A/B, self-hosted | re-scope RT-994 |
| V3-4 | Shell: top bar, light sidebar with 7 areas, area band, tabs, redirects | not created |
| V3-5 | Home v3 on existing reads | not created (amends RT-1406 F4, RT-975) |
| V3-6 | D2 glossary copy pass | not created (after RT-965) |
| V3-7 | Accounting area | not created |
| V3-8 | Reports list | not created |
| V3-9 | Sales list + side drawer | not created |
| V3-10 | Usability baseline, today vs v3 (Verification) | not created |
