---
name: Retail Tower Console
description: >-
  Admin Console design baseline, rebaselined to the Retail Tower UX/UI Constitution
  (UX-01…UX-13, Final Audit 2026-10-07). Target: light-first Mineral Daylight + Tower Teal,
  one shared semantic color system with POS, Arabic-first (Dubai) type voice, RTL by structure.
  The token block below records the CURRENT SHIPPED tokens (src/styles/tokens.css). Since
  RT-396 and RT-397 the colours, radii and type ARE the approved light target (RT-392).
  v3.0 (RT-969) adds the owner-approved Shell v3 "Daylight Commerce" frame.
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
| `PRODUCT.md` — Design Principle 6 ("dark by default … light alternate") and the dark-*default* note under Anti-references | **Superseded** by UX-02 light-first. The rest of PRODUCT.md (users, purpose, principles 1–5) stands. Reconciling PRODUCT.md is a separate docs change. |
| `design_handoff_retail_tower_console/` — screens, charts, theme, KPI coloring, dual-axis patterns, route map, chart palette | **Reference/prototype only** (Final Audit; UX-13 prototype disposition). Nothing in it is production authority unless a Constitution-backed issue adopts it. |
| `docs/design/_vision/`, `docs/design/rf1-auth-shell/`, `docs/design/rf6-audit-search/` mockups and their `tokens.css` | Historical slice references. They are not the target identity. |

## 2. Product character (UX-01, UX-09)

The Console is an **adaptive operational workbench**. It is not a scaled-up POS, a card
dashboard or a marketing surface. POS navigates tasks; the Admin Console navigates the system.
Every screen answers *where am I acting, and what is true* before anything else. Identity
comes through behavior: state handling, selection grammar, data geometry and surface
hierarchy. It does not come from ornament, logos or a second accent color.

Admin may use more **Responsive** motion than POS (UX-06). Expressive motion is rare and
never on operational truth. `prefers-reduced-motion` collapses durations to instant, but
focus, copy, status and border/icon feedback stay intact.

**Status at a glance (v3.0, owner decision 2026-10-30).** The Overview may show status at a
glance as **one KPI ledger strip** (a single section panel of label / value / delta cells,
divided by rules, never one card per value) **plus one pipeline strip** (POS → server →
ERPNext, each step with its count and its first problem). That is the only exception. Stat-card
grids, hero metrics and decorative charts stay out, on the Overview and everywhere else.

## 3. Color (UX-02, UX-13)

**Target direction: Mineral Daylight + Tower Teal, light-first.**

- **Theme.** The Admin Console defaults to **light**. An opt-in dark theme was approved on
  2026-10-11 (RT-392): the same thirteen roles with dark values, switched by the user from the
  top bar (values in `design/claude-design-system/README.md`). Shipped by RT-398: a "Dark mode"
  toggle (`.btn-secondary` + `aria-pressed`, constant label) sets `data-theme="dark"` on
  `<html>`; the choice is kept per user in browser storage (no Backend-Core preference contract
  exists), and an inline script in `index.html` restores it before first paint.
  No forced dark sidebar or dark shell to create personality. Components consume semantic
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
- **Shape (target):** 8px controls, 12px genuine contained objects, 16px independent overlays.
  Round the object, not the page. Pills only for true status, counts or tags, never ordinary
  buttons. *Shipped as `--radius-control` / `--radius-object` / `--radius-overlay` (RT-396).*
- **Borders and tone before shadows.** Work surfaces, sections, cards and panels are shadowless.
  Popovers, drawers and dialogs may use restrained elevation.
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

- **Buttons:** five variants: `.btn-primary` (Tower Teal fill), `.btn-secondary`,
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
    `aria-pressed` buttons in a group), both at the inline end on the text's last line and
    wrapping under it when narrow. `titleRef` makes the title a focus target; `titleId` lets a
    region be labelled by it. A back link sits above the header, not in it.
    `tests/unit/page-header.test.tsx` fails if a page inside the shell writes its own `<h1>`.
  - **Content container** and **section panel**: §5.

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
| Shell v3: sidebar with scope switcher, top bar with Ctrl K navigator and user menu, page header, content container | UX-04, UX-09 | **RT-969** (this version). Screens follow: Overview v2 (RT-970), detail template (RT-961), forms and sign-in (RT-971), control states (RT-959) |

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
- Add new gold, new navy-as-brand or dark-only surfaces; that deepens retired identity.
- Use a box-shadow as the only focus indicator, or `outline: none` without an outline
  replacement.
- Use success/warning/danger/info as a chart palette, or color alone for meaning.
- Put a table inside a card, or nest a panel or card inside a section panel.
- Build a stat-card grid or a hero metric; the Overview's one KPI ledger strip and pipeline
  strip (§2) are the only status-at-a-glance surfaces.
- Animate truth values (count-ups, rolling money), add bounce easing or page-load choreography.
- Copy design-handoff prototype themes, KPI coloring or dual-axis charts into production.
- Introduce a new package (including Tailwind or an icon or i18n library) without an
  authorizing Jira issue.
