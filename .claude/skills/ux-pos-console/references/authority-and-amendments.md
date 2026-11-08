# Authority, precedence and amendments

## Truth sources (Decisions register, Confluence 5341185)

- **GitHub `main`** = technical truth. Do not claim implementation from Jira, Confluence, a branch or an agent report.
- **Jira** = active work (Work Mode, status, blockers). **Confluence** = durable knowledge, not a work queue.
- Repo design docs apply the rules to each repo: POS `docs/DESIGN.md` + `docs/design/vnext/`, Admin-Console `DESIGN.md` v2.0 + `docs/design/`.

## Precedence (highest first; Rebaseline 23134234, POS DESIGN.md)

1. RT-24 and later approved domain/behaviour contracts (financial, transaction, scanner, recovery, auth, workflow semantics).
2. UX-01..UX-13 + Final Audit (24510466). The most specific module owns its jurisdiction.
3. VNext Constitution Rebaseline (23134234): which parts of the freeze the Constitution changes.
4. RT-159 freeze package (POS `docs/design/vnext/15-vnext-freeze-package.md`) where not amended.
5. Visual Acceptance Pack (visual/state reference only; Constitution overrides its colour, type, motion, copy, components).
6. Implementation references (shadcn/ui, MUI/MUI X): patterns only, no dependency.
7. Older references and prototypes: history only.

Where an owner decision is newer than older text, the owner decision wins (POS DESIGN.md). That is the basis of the amendments table below. **Design choice of this skill:** treat an explicit amendment in a dated owner-decision page as overriding the page it amends, within its stated scope only.

## Status vocabulary (use these words)

| Word | Meaning |
|---|---|
| Governing | Owner-approved rule; applies to new work |
| Shipped | Verified behaviour on `main` |
| Approved, not shipped | Decided; lands only in its bounded slice (for example VN-S2) |
| Target | Constitution direction not yet in code (for example radius 8/12/16 on POS) |
| Open | Not decided; do not resolve by design |
| Advisory | From `advisory-candidates.md`; not governing |
| Superseded | Kept for history only |
| Merged, packaged verification pending | On `main` but not yet "Shipped" in this vocabulary: per the 2026-10-20 owner page RT-242, RT-243, RT-244, RT-440, RT-445, RT-530 and RT-542 stay **In Review** until packaged verification is recorded (open: RT-754 Sale -> Checkout, RT-446 park/resume, RT-505 S10-V). This covers Undo, Sale layout B and the void screen. Say "merged, verification pending", not "shipped" |

## Amendments layer (dated; newest wins within scope)

| Date | Source | Effect |
|---|---|---|
| 2026-10-07 | Rebaseline table | Money mono target superseded by UX-03/12 (but see 2026-10-07 owner decision below); `UndoNotice` 8 s is presentation, not correctness (RT-245 owns eligibility); routine Undo writes `cart_action_outbox` lineage only, no central audit category; M-P1 "complete or cancel payment" amended by tender truth (external card: terminal check/void first); dialogs need a real Tab trap; Visual Pack no longer outranks the Constitution; rolling money prohibited |
| 2026-10-07 | Owner decision (POS DESIGN.md) | UX-03 wins over the Rebaseline wording on money type: shipped POS money stays monospace tabular until the RT-262 same-screen A/B proves the sans treatment |
| 2026-10-08 | UX-12 two-locale target | POS Arabic-first default plus a separate English locale later; one locale at a time; not in RT-241 scope |
| 2026-10-11/12 | RT-392/RT-398, RT-399 (Admin DESIGN.md) | Admin: light default plus an **opt-in dark theme** (top-bar toggle); English second locale. POS dark stays deferred (OD-4, UX-02) |
| 2026-10-12 | RT-312 display policy | Pilot 1920x1080 @100%; width <1024 and height <600 blocked; never auto-zoom; native menu bar removed |
| 2026-10-15 | RT-495 | Void needs a manager credential; cash drawer optional (no "drawer not opened" notice; supersedes freeze M-C4) |
| 2026-10-16 | RT-536 D1-D8 | Cashier gets reprint-last-receipt and «المبيعات» history; Park/Resume pilot-mandatory; shift cash-up on (main refuses cash without an open shift since RT-998); **pilot is cash only** (card and RT-250 post-pilot); returns manager-only; empty Audit/Settings hidden from manager nav |
| 2026-10-16 | RT-534 OD1-8 | Store-wide sales history: max 31 inclusive days, cursor 50 default / 100 max, voided = marked sale record only, audit every detail open and reprint |
| 2026-10-18 | Ratification 43712513 | RT-313 1024x600 warning copy direction; RT-399 Arabic-first/English-second and money rules; no Store Manager price authoring in V1; second approval before emergency price publication |
| 2026-10-18 | RT-263 D-263-1..9 | Fluent System Icons, vendored per repo, semantic registry, Filled only on selected slim-rail item |
| 2026-10-20 | D-K1 | F-key map deferred; wave 1 keyless; bench-test scanner prefix/suffix first |
| 2026-10-20 | D-U1 | Undo decision closed: already **merged** (RT-242 W1-B PR4, POS #621, `cart.undoLast`). RT-242 stays In Review until packaged verification is recorded |
| 2026-10-20 | RT-414/RT-392 | Break-glass = password re-entry + reason; suspended tenant read-only, break-glass refused; `perm_owner_console` dedicated audited permission; design-system sync = tokens + CSS vocabulary only; Platform Console design review (RT-777) before any `/platform` UI |
| 2026-10-21 | Owner decision (POS DESIGN.md, on `main`) | Slim ~76px rail (icon + short 12px label) on every POS screen in the app frame (`/app` under `V5AppLayout`; sign-in, pairing and Ready sit outside it, see RT-1042 entry screens); RT-242's labelled off-sale panel is superseded. The shared `.v5-btn` button system (POS) and the Admin button variants (`.btn-danger-quiet`) are on `main` too |
| 2026-10-22 | RT-262 owner decision (POS DESIGN.md), shipped by RT-814 | Money type variant B: UI sans (Dubai) with tabular lining numerals via `--font-family-money`; monospace only for IDs, codes and evidence. Supersedes the 2026-10-07 mono decision. Printed receipt and receipt-slip preview excluded (RT-476) |

## Still open: do not resolve by design

Lazy cart creation; the F-key map (D-K1); OD-3 validation of grouped money against real Egyptian pharmacy receipts (printed receipts only); density mapping of POS's two profiles to UX-04's three modes (Q-1); exact mineral-neutral values; font migration (Dubai vs challenger, RT-262 A/B); Store time zone (RT-279); recorded pilot display model; exact English locale tag; card-decline contract (D-P1) and card flows (post-pilot); offline cashier/manager approval implementation (RT-113/RT-114); void credential wording (see below); sale number display (D-N1); catalog/store/device role matrices still marked "needs decision" in the Authority Matrix; a fiscal-status UI (owned by Fiscal & Tax, no UX defined).

**Known doc tension to surface, not settle:** RT-495 decision 1 says voiding a sale needs the store/shift manager *password*; the shipped RT-530 screen and the RT-654 references draw a *manager-PIN* confirm dialog under a separately approved four-eyes rule (RT-530 comments 11988, 12006). Ask which governs before writing void copy or fields.

## Later owner decisions

- **2026-10-30, Admin Console "Ink & Receipt" (canvas board v9): approved, partly shipped.** `apps/admin-console/DESIGN.md` v4.0 §12 records it as the visual target. `src/styles/tokens.css` is the shipped truth: the Ink roles and primary fill, `--shadow-resting`, receipt cards and the Overview (RT-993) are on `main`; the rest lands through its Jira slices. Call a part shipped only when the component, style and route code on `main` render it; a token in `tokens.css` alone does not prove use.
- **2026-11-08, Admin Console public "night frame" (sign-in board B): owner-approved, in PR.** `apps/admin-console/DESIGN.md` §12.1 records it. It supersedes **PW-5** (flat Ink public panel) and **PC-5** (light form side) for sign-in and accept-invitation only: the frame is dark in both themes (`data-theme="dark"` on its own wrapper), carries the artwork, a mint glow and a faint tower drawing, and never shows pipeline or ERP wording. Mint is still never text (D-V10). Other form asides stay light. Do not cite PW-5 as current for the public screens; do not reuse this look on any other screen. Open: the tagline «كل الفروع تحت عينك» uses «الفروع» where UX-12 says store = «المتجر» (owner wording, not yet reconciled).

## Non-authoritative material

`design_handoff_retail_tower_console/` (charts, KPI colouring, dual-axis, route map), Admin `DESIGN.md` v1.0 (dark default, gold, navy, Inter), POS v3.5 system (`docs/design/pos-v3.5/`), Visual Pack Iteration-1 / exploration folders, and Khepri v2 design system (non-governing) are reference only. Do not build from them.
