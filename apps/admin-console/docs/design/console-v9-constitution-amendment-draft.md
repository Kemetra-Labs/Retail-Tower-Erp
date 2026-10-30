# Owner decisions 2026-10-30: Admin Console visual direction v4.0 «Ink & Receipt» — amendments to UX-02, UX-03, UX-04

> **Approved by the owner and published 2026-10-30** (synced with version 2) as Confluence page
> [62816260](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/62816260) under the
> Decisions register (5341185). **The Confluence page governs**; this file is the working
> copy it was drafted from and may be deleted before merge.

## Status and scope

- **Scope: Admin Console and Platform Console only.** POS is not affected by any decision
  here; POS keeps UX-02/03/04 as written and its own amendments.
- **Layer:** an owner decision that amends specific Constitution rules, within the scope above
  only (newest dated owner decision wins within its stated scope).
- **What it authorizes:** design direction and the bounded implementation slices listed in
  Admin-Console `DESIGN.md` v4.0 §10. It is not implementation proof; GitHub `main` stays
  technical truth.
- **Reference artifact:** design canvas <https://claude.ai/artifact/7LkLBupz4nTpvB4P4k4NW4>,
  board «✓ المعتمد · نظرة عامة v9» plus the Sales, Catalog, Integration, Stores and Devices,
  Users and Shifts rows drawn in the same style. The D-V9 band is shown on the board «مقترح D-V9
  · المستخدمون بشريط Ink في الرأس». Boards v4–v8 are history.
- **Supersedes:** the 2026-10-30 Shell v3 "Daylight Commerce" **visual layer** (Admin
  `DESIGN.md` v3.0). The v3.0 structure (sidebar with scope, top bar with Ctrl K, page header,
  section panels, detail/form templates) stays.

## Context

On 2026-10-30 the owner judged the v3.0 Console look too plain and not distinctive, compared
nine canvas iterations, and locked v9. v9 keeps Tower Teal, Dubai body text, Arabic-first RTL
and every truth/state rule, and changes the visual layer: an Ink sidebar, receipt-style KPI
cards, a sale-pipeline rail, Mint as the teal family's highlight on dark surfaces, soft
elevation, a display face, and data-bearing illustrations. Several of those conflict with
UX-02, UX-03 and UX-04 as written on 2026-10-07; this page amends exactly those rules.

## Decisions

### D-V1 — Ink sidebar (amends UX-02 «Theme and future extension»)

- **Amends:** "Dark theme: deferred; no forced dark sidebar or dark shell solely to create
  personality."
- **Decision:** the Admin sidebar is an Ink surface (`#0a2125`) in both light and dark themes.
  It is the one sanctioned dark surface. Content surfaces stay light-first; the opt-in dark
  theme (RT-392/RT-398) remaps them as before.
- **Conditions:** sidebar text meets 4.5:1 on Ink (secondary text `#a9c2c5` measures 8.9:1);
  focus, selection and location stay distinguishable under forced colours.

### D-V2 — Mint as the teal family's highlight on Ink (clarifies UX-02 «No secondary brand accent yet»)

- **Clarifies:** "do not add a permanent purple/coral/orange brand accent."
- **Decision:** Mint `#5fe0cf` is Tower Teal's highlight for dark surfaces, not a second
  brand hue. It is used **only on Ink**: the active-navigation signal line and icon, the hero
  figure's accent, the chart focus point, the selected segment and the `Ctrl K` key.
- **Conditions:** never as text or fill on a light surface (it measures 1.6:1 on white).

### D-V3 — Primary action fill (amends UX-02 «Teal Means Intent»)

- **Amends:** "Tower Teal owns primary action, selection, focus/interaction language and
  active brand identity."
- **Decision:** on light surfaces the primary action is filled with Ink; Tower Teal keeps
  focus, selection on light surfaces, links and brand identity. In the dark theme the primary
  fill is Mint on Ink.
- **Unchanged:** one primary per context; ghost cancel; danger-quiet → destructive grammar;
  busy and disabled rules (Admin `DESIGN.md` §9).

### D-V4 — Expressive surfaces and ornament (amends UX-02 «Operational gradients» and «Identity through behavior, not ornament»)

- **Amends:** "gradients are prohibited on … tables, forms, operational buttons and status
  surfaces. Tonal gradients may be explored later only in safe expressive surfaces" and
  "should be recognizable … rather than relying on logos, decorative motifs or a second
  accent color."
- **Decision:** these are the safe expressive surfaces, and the only places gradients,
  glows, textures and illustration may appear:
  - the hero receipt card;
  - the Ink sidebar (the Tower grid);
  - the brand mark;
  - chart area fills;
  - hero bands on detail pages;
  - the top band of entity cards (the store skyline).
- **Conditions:**
  - Pure ornament (skyline, storefront, Tower grid) is `aria-hidden`, at most 55% opacity,
    and hidden on narrow screens where it competes with content.
  - Gradients stay prohibited on tables, forms, operational buttons, banners and status
    surfaces.

### D-V5 — New visual signatures (extends UX-02 «Retail Tower visual signatures»)

- **Decision:** add these to the signature set. Each keeps the existing rule "signature is
  grammar, not wallpaper":

  | Signature | Its job |
  | --- | --- |
  | **Receipt card** | KPI cards and the payment summary only. |
  | **Pipeline rail** | POS → server → ERPNext, each node with a text fact. |
  | **Tower grid** | Ink surfaces only. |
  | **Mint signal line** | Replaces the teal wash in the Ink sidebar; still inline-start, logical positioning. |
  | **Section index** | «01», «02»… on multi-panel pages. |
  | **Data-bearing illustrations** | Fleet map, device dots, credential-life ring, business-day bar, live clock. |

- **Condition:** every data-bearing illustration has a text alternative or sits next to the
  same fact in text; colour never carries its meaning alone.

### D-V6 — Elevation and radius (amends UX-04 «Shadow budget» and «Target radius rhythm», Admin only)

- **Amends:** "work surfaces, sections, cards and panels are shadowless by default" and
  "8px controls, 12px contained objects, 16px overlays."
- **Decision (Admin):**
  - Section panels and cards take one resting-elevation token and a 20px radius.
  - Controls are 10–12px; the top-bar search is 14px.
  - Overlays keep the strongest elevation.
  - The 1px border stays, so edges survive forced colours.
- **Unchanged:** "Round the Object, Not the Page", "Pills are semantic", one primary scroll
  owner.

### D-V7 — Overview composition (amends UX-04 «Adaptive Operational Workbench … rather than a … card dashboard» for the Overview, and the Admin v3.0 "one KPI ledger strip" rule)

- **Decision:** the Overview may show:
  - one row of receipt KPI cards (one hero plus at most three);
  - the pipeline rail;
  - one trend chart and one part-to-whole chart.

  Every other screen keeps the workbench rule: no stat-card grids, no hero metrics.
- **Conditions (UX-13, unchanged and binding):**
  - Each KPI names its scope, period, baseline and freshness.
  - Each chart answers a stated question, has a table/inspect path, and keeps gaps for
    missing buckets.
  - The hero sparkline states its period (for example «آخر 14 يومًا»).
  - The donut stays at five categories or fewer, using the `--color-viz-*` palette.

### D-V8 — Display face (amends UX-03, Admin only)

- **Decision:** add a display-face role for the Overview greeting, section titles, KPI and
  table figures, chart labels and the `Ctrl K` key: **Readex Pro** (400/500/600/700). Dubai
  stays the body and control face.
- **Conditions:** adoption needs:
  - an OFL licence check;
  - a self-hosted Arabic + Latin subset (the Console CSP allows `'self'` only; no Google
    Fonts at runtime);
  - same-screen A/B evidence against Dubai (UX-03 "no speculative migration").

  Until then, Dubai renders everywhere.

### D-V9 — Ink header bands on list pages and drawers (extends D-V4)

> Owner-approved 2026-10-30 after comparing the mock board «مقترح D-V9 · المستخدمون بشريط
> Ink في الرأس» with the light-header Users board. Added to Confluence 62816260 (version 2).

- **Extends:** D-V4's list of safe expressive surfaces, which allows hero bands on detail
  pages only.
- **Decision:** two more surfaces may use Ink with the Tower grid:
  1. **The list-page header band.** One per list page (Sales, Catalog, ERPNext sync,
     Stores, Devices, Users, Shifts, and later Inventory, Audit and Reports).
  2. **The drawer header.** The top strip of an invite, edit or detail drawer. The
     drawer's form body stays a light surface.
- **What a list band may hold, and nothing else:**
  - the navigation-group label (for example «الإدارة»), the page title and a one-line
    subtitle that names the scope (the tenant);
  - the page's single primary action;
  - at most one row of up to three facts, each one a fact the server serves for the
    **whole** set. A full, unpaged list such as Users or Stores may show its counts. A
    paged list (Sales, Shifts) has no total, so it shows its scope and period instead,
    never "loaded so far" dressed up as a total.
- **What stays out of the band:** filters (the shared FilterBar stays on the light
  surface below it), banners, errors and any state. The band never changes colour with
  the page's state: Brand Yields to Truth (UX-02). No KPI receipt cards and no charts go
  in the band; D-V7's workbench rule for non-Overview screens still holds.
- **Conditions:**
  - **Contrast:** the title is white on Ink and the secondary text is `#a9c2c5` on Ink
    (8.9:1). Mint is used for accents only, as D-V2 requires.
  - **Primary action on Ink:** a Mint fill with Ink text, the same as the dark-theme
    primary in D-V3. There is still one primary per context.
  - **Size:** at most 132px tall at 1280px wide. Below 640px it collapses to a plain
    light header and the ornament is hidden.
  - **Ornament:** the Tower grid and line drawings are `aria-hidden` and at most 55%
    opacity. A band shows no data-bearing illustration unless that data has a source.
  - **Forced colours:** the band maps to `Canvas`/`CanvasText`, keeps a 1px border, and
    the ornament disappears.
  - **Motion:** the band has no animation.
  - **Headings:** the page `h1` stays inside the band, so the heading order and the
    landmarks do not change.
- **Why:** the owner wants list pages to feel as finished as the Overview and the detail
  pages. Without this, Stores, Users and Shifts look a level below their own detail pages.
- **Evidence for the slice that adopts it:** everything under "Evidence required" below,
  plus captures at 1280×800 and 390 wide, with and without a banner under the band, and
  with a long Arabic tenant name.

## Confirmed without amendment

- **Delta colour (UX-13 «Direction Is Mathematics. Judgment Is Domain Meaning»).** The owner's
  choice (green when a metric moves the way the business wants, red against it, neutral with
  no agreed direction) *is* the UX-13 rule. It needs each KPI's good direction in its metric
  contract; returns, voids and stuck postings rising read red. Every delta names its baseline.
- **Icon tiles (UX-03 «No decorative icon tiles by default», «Icons do not introduce
  independent category palettes»).** KPI and quick-action icon tiles use one teal/Ink family;
  an icon is coloured only when it carries status meaning.
- **Semantic truth colours (UX-02).** Blue = information/pending, green = proven success,
  amber = caution, red = danger/consequence/UNKNOWN; meaning redundancy; Brand Yields to
  Truth.
- **Data colour ≠ status colour (UX-13).** Charts use the `--color-viz-*` family.
- **UX-05 … UX-12.** Interaction, motion (no animated truth; reduced motion), states,
  forms, navigation, tables, accessibility/RTL and copy are unchanged.

## Evidence required before each v4.0 slice merges

UX-02's acceptance gate "Color Under Pressure" applies to every slice. The slice must show:

1. Contrast pairs for every new role in light and dark (`.design-sync/contrast-pairs.mjs`).
2. Forced-colours captures. Notches, the Tower grid and glows disappear; the perforation
   falls back to a `CanvasText` dashed rule; Ink surfaces map to `Canvas`/`CanvasText`.
3. 1280×800 and phone-width captures with long Arabic names, banners and dense tables.
4. Reduced-motion check: the connector pulse stops.
5. For D-V8 only: the A/B comparison and licence note.

## Still open (not decided here)

- Dark-theme values for the new roles (a proposal exists on the Sales dark board).
- The data source for each new data-bearing element that has none yet:
  - store "share of today";
  - low-stock severity;
  - sidebar system status;
  - credential-life ring;
  - business-day bar.

  Each renders nothing until it has one.
- Whether POS should later adopt any of this (out of scope; POS keeps its Constitution).

## Approval

- [x] Owner approves D-V1 … D-V8 as written (2026-10-30)
- [x] Page published under Decisions (5341185): 62816260
- [x] Linked from UX-02 (v2), UX-03 (v4), UX-04 (v2) by a warning panel at the top of each
- [ ] Admin `DESIGN.md` v4.0 merged with a link to this page
- [x] Owner approves D-V9 (list and drawer header bands) (2026-10-30); added to 62816260
      (version 2) and to `DESIGN.md` §12.6
