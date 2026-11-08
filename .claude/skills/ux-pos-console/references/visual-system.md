# Visual system: colour, type, icons, space, motion

Both repos record **shipped tokens** in their own files (POS `src/renderer/styles/tailwind.css`, Admin `src/styles/tokens.css`). The CSS is the source of values; if a doc differs, the CSS wins. Always say whether a value is **shipped** or **target**.

## Colour (UX-02)

Direction: **Mineral Daylight + Tower Teal**, light-first, one semantic system shared by POS and Admin (UX-02.1, .4). Tower Teal stays the shipped Admin colour for focus, links and selection (`apps/admin-console/src/styles/tokens.css`). The Console "Ink & Receipt" look (owner decision 2026-10-30) is the approved target and is partly shipped: the Ink primary fill, the resting elevation token, receipt cards and the Overview charts are on `main`; check the CSS for the rest (see `authority-and-amendments.md`).

| Role | Value (shipped) | Meaning |
|---|---|---|
| primary (Tower Teal) | `#0F766E`; emphasis `#0B5B55`; soft `#E6F4F1` | Intent only: primary action, selection, focus (UX-02.5). Not decoration, **not success green** |
| success | `#15774D` | Proven outcomes only |
| warning | `#A35A00` | Degraded but operable (offline selling, stale catalogue, printer failed after a completed sale) |
| danger | `#B3261E` | Destructive, blocking, **UNKNOWN** |
| info | `#1B6CA8` | Pending, "recorded but not yet proven downstream" |
| background / surface / sunken | `#F7F9FA` / `#FFFFFF` / `#EEF2F6` | Mineral layering |
| text / muted | `#0F1D2E` / `#53647A` | Muted: 12px and up, never money or errors |

Rules:
- **Brand yields to truth**: critical truth -> primary action -> context/selection -> brand identity -> decoration (UX-02.6, .8).
- **Meaning redundancy**: colour never carries meaning alone; add text, icon or shape (UX-02.9, UX-11.27).
- **Pending is not success**: SETTLED while FINALIZING, FINALIZED but not POSTED use info, not green (POS DESIGN.md).
- **No gradients** on POS, tables, forms, operational buttons or status surfaces (UX-02.13). **No secondary brand accent** (UX-02.23). Borders before shadows; on POS, one shadow, for overlays (UX-02.11, UX-04.32). Admin v4 also gives section panels and receipt cards one resting elevation (`--shadow-resting`, Admin DESIGN.md §12.5).
- **Commit-Teal rule (POS)**: filled teal on at most one control per region plus selected washes.
- Signatures are grammar, not wallpaper (UX-02.14-.19): Mineral Layering, **Signal Line** (2px inline-start bar for current context/selection, logical position), **Pulse Dot** (static unless real activity), **Precision Ledger** (aligned label/value rows, tabular numerals, anchored totals instead of a card per value).
- Theme: POS light only (dark kept in CSS but not offered, OD-4); Admin light default with an opt-in dark theme shipped by RT-398. Future themes remap semantic roles, never component meaning (UX-02.21).
- Data colour is a separate token family (UX-13.12). Never use status colours as chart series.
- **Color Under Pressure gate** (UX-02.25): validate at 1024x768, long carts, long Arabic names, offline/sync banners, payment UNKNOWN, disabled/selected/focused controls, dense tables, bright shop light, forced colours and colour-vision constraints, not from a clean mockup.
- Forced colours: brand and shadow yield to Windows contrast semantics (UX-11.26). Focus is a 2px outline (offset 2px) in primary, never box-shadow only. In forced colours use `Highlight`/`HighlightText` for selection and a 3px `ButtonText` border on primary.

## Typography (UX-03)

- One Arabic-first UI voice for both apps: **Dubai** (incumbent). Challenger IBM Plex Sans Arabic; control Noto Sans Arabic UI. **No speculative font migration**: needs rendered same-screen A/B (RT-262).
- Dubai ships weights 300/400/500/700 only; a `600` renders Bold. No `letter-spacing` (breaks Arabic joining). Arabic line-height at least 1.5 (Admin uses 1.7); never italics or all-caps.
- **Type jurisdiction** (UX-03.8): UI sans owns language; tabular numerals own prices, quantities, KPIs; **monospace owns machine IDs/codes/evidence only** (UX-03.11).
- **Money type (shipped)**: POS amounts and quantities use the UI sans (Dubai) with tabular lining numerals via `--font-family-money` (owner decision 2026-10-22 on RT-262, variant B; applied by RT-814). Monospace stays for IDs, SKUs, codes, PIN and reference fields. The printed receipt and receipt-slip preview keep their own typography (RT-476).
- **12px floor** for anything a cashier must read; 11px only for keyboard-hint chips (UX-03.14).
- Money stays the strongest numeric hierarchy on cashier surfaces (UX-03.9). Hierarchy by placement, spacing, weight and alignment before size (UX-03.13).
- Role vocabulary (target; POS ships `--type-*` aliases, Admin `--text-*`): `display` (rare, Admin), `screen-title`, `section-title`, `body`, `body-strong`, `control`, `meta`, `money-hero`, `money-total`, `numeric-row`, `machine`, `kbd`. POS sizes: amount-hero 44/36px at 1024, amount-total 30/24px, screen title 20, section 16, body 14, meta 12.

## Icons (UX-03, RT-263)

- **Fluent System Icons, one family**, vendored per repo into a semantic registry (no npm dependency; MIT notice). Never mix Lucide/Phosphor/bespoke (UX-03.17).
- Product code names icons by **meaning** (`icon.sale`, `store`, `back`), never by shape or vendor name; only the registry maps name to glyph.
- Sizes are native grids 16 / 20 (default) / 24; never scale between grids.
- Glyph is `aria-hidden` and not focusable; the accessible name sits on the control or adjacent text. **Icons reinforce, text decides**: financial, destructive and recovery actions always show text (UX-03.19); icon-only only for universal non-financial actions (close dialog, clear search, keypad backspace).
- Regular by default; **Filled only on the selected item of the POS slim rail**. Colour `currentColor`; no category palettes or decorative coloured tiles.
- RTL follows meaning; the registry owns mirroring per name (`never` / `mirror` / `variant`). Mirror back/forward/undo; never mirror scanner, printer, card, store, trash, search, lock, clock, check. Brand marks stay outside the registry.
- Custom glyphs only for a proven gap; the cash drawer is a candidate, not a requirement (UX-03.50).

## Spacing, density, shape (UX-04)

- 4px-derived scale 4/8/12/16/24/32/48/64/96 used semantically (UX-04.1).
- **Dense inside, breathing between; compress space before meaning; reflow before shrink** (UX-04.3-.5). Pressure order: **critical truth -> primary action -> current context** (UX-04.34).
- POS (Direction B): cart-first command bar, persistent money column (about 280px at 1024, 320px at 1280), a slim ~76px rail (icon + short 12px label) on every `/app` screen (owner decision 2026-10-21, POS DESIGN.md; entry screens are outside the frame, `router.tsx`). Money, commit and scanner state never scroll away; the cart is the primary scroll surface (UX-04.7-.10). POS touch floor **44px**, even compact; commit button 56px; cart row at most 60px at 1280 and 52px at 1024.
- POS ships two density profiles (compact/comfortable) following the workspace container width (compact at 1120px or less, and under 768px viewport height). Mapping to UX-04's three modes is open (Q-1). Density switches only between transactions, never mid-sale (I-14).
- Admin: adaptive workbench; **tables are full-bleed work surfaces, not inside cards**; details side-by-side when wide, drawer at medium, dedicated surface when narrow; overflow belongs to the data surface, not the app shell (UX-04.14-.19). Reading/form surfaces use a constrained measure (about 60-65ch). Admin controls are 36px (denser than POS, above the accessibility floor).
- Surface grammar (UX-04.20-.25): Work Surface (flat), Section (heading/spacing), Panel (tone or divider), Card (only a genuine independent/selectable/actionable object; every card earns containment), Drawer (attached, real elevation), Dialog (strongest elevation).
- Shape: target radius 8 (controls) / 12 (contained objects) / 16 (overlays). **Admin has shipped it; POS still ships 10/14/16** until its own slice. Admin v4 (DESIGN.md §12.5) adds `--radius-panel` 20px (panels, receipt cards) and `--radius-field` 10px / `--radius-field-lg` 12px (controls) beside those roles; components move to them slice by slice. Round the object, not the page; pills only for status/counts/tags (UX-04.26-.29).
- One primary scroll owner per workspace; nested incidental scroll chains prohibited (UX-04.33).

## Motion (UX-06)

- Roles: **Contact 80ms** (press), **Signal 150ms** (local acknowledgement, scan-row flash), **Continuity 220ms** (dialogs, drawers); easing `cubic-bezier(.2,.7,.25,1)`; no arbitrary durations (UX-06.5-.9).
- Tiers: POS predominantly Functional; Admin may use more Responsive; Expressive only for rare, safe, non-operational moments (UX-06.27-.29).
- **Truth doesn't perform** (UX-06.13): money, totals, tax, refund, stock never roll, count up, bounce or morph. `MoneyRoll` is gone; do not reintroduce.
- Errors clarify, they don't scold: no shaking (UX-06.15). Payment UNKNOWN is near-static (UX-06.16). **Live does not mean animated** (UX-06.17); continuous motion only for real activity (UX-06.18); no ambient motion (UX-06.19).
- Do not animate whole-workspace route changes; large table sort/filter re-layout is direct (UX-06.12, .24). Skeletons describe geometry, avoid flicker on fast loads (UX-06.21-.22).
- Reduced motion: durations effectively zero, but focus, copy, status and border/icon feedback remain (UX-06.25-.26, UX-11.28).
