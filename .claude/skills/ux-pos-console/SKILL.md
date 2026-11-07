---
name: ux-pos-console
description: Retail Tower UX/UI rules for the POS (Electron cashier app, Arabic-first RTL) and the Admin Console / Platform Console. Use whenever the user designs, reviews, specifies, critiques or implements any screen, component, flow, copy, token, table, form, state, shortcut or accessibility behaviour for Retail Tower POS or Admin Console, even if they only say "cashier screen", "checkout", "scanner", "payment UNKNOWN", "shift close", "lock screen", "stores table", "audit page", "Platform Console", "Arabic copy", "RTL", "UX-05", "RT-24", "Direction B" or "Constitution". Applies the owner-approved UX Constitution (UX-01..13), its dated owner-decision amendments, and the POS/Admin-Console repo design docs, and refuses to invent behaviour the owner has not approved.
---

# Retail Tower UX: POS and Admin Console

One skill for two surfaces. They share one design DNA (colour system, type voice, truth discipline, Arabic/RTL grammar) but different compositions: **POS navigates tasks, Admin Console navigates the system** (UX-09.1).

This skill is a distilled working layer. **Confluence (RETAIL space) and the repos remain the source of truth.** Every rule here carries its ID (for example `UX-05.21`) so reviews can cite it and so you can re-check the page. Planning pages are *not* proof of shipped behaviour: GitHub `main` is the technical truth.

## Step 0: orient before answering

1. **Which surface?** POS cashier / POS manager screens / Admin Console (tenant) / Platform Console (`/platform`). If unclear, ask once.
2. **Which job?** Design a screen, review existing UI or a PR, write a spec/slice, or write Arabic copy. See "Output shapes" below.
3. **Load the references that apply** (table below). Always read `references/authority-and-amendments.md` first: it holds the precedence order and the dated owner decisions that override older pages.
4. **Check freshness.** `references/source-map.md` records page IDs and last-modified dates. If the user says "latest", the work touches a payment/session/auth rule, or a page changed after the recorded date, re-read that page (use `contentFormat: "html"`; the markdown export silently drops rule bodies).

## Non-negotiables (RT-24 core rules, I-1..I-17)

These come from the behaviour authority and beat every visual preference:

1. **Never silently lose a valid cart.**
2. **Never claim a payment state that is not proven.** Success styling and wording only after the fact is persisted or proven (UX-01.19, UX-05.16).
3. **Never turn a recovery action into a second sale or second payment.**

Hard stops. Do not do these, and say so when asked:

- Invent keyboard shortcuts or F-keys on POS (D-K1: POS wave 1 is keyless; only Esc, Enter, Tab, Up/Down, Delete, +/- are frozen, and the cart binds only Up/Down so far). Admin's approved Ctrl+K navigator (RT-969) is not covered by D-K1.
- Render payment UNKNOWN as a decline, or suggest re-charge/new tender/Back while an external charge is unresolved.
- Put fiscal/VAT/QR claims or "Fiscal Ready" language on any screen; the Fiscal & Tax domain owns that.
- Let a scanner burst into a money, PIN or card-reference field.
- Animate business truth (no rolling/counting money) or add bounce/elastic motion.
- Offer Undo without a domain contract that can restore (UX-05.21).
- Hard-code hex values, add a package (Tailwind, icon or i18n library), or reintroduce Tower Gold/navy/dark-default.
- Describe a *target* as *shipped*, or implement outside its bounded Jira slice.
- Resolve an item on the "still open" list by design (see authority reference). Surface it as an open question instead.

## Which reference to load

| Task | Load |
|---|---|
| Any task | `authority-and-amendments.md` |
| POS cashier or manager screen | `pos.md`, `shared-principles.md`, `visual-system.md`, `rtl-arabic-copy.md` |
| Admin / Platform Console screen | `console.md`, `shared-principles.md`, `visual-system.md`, `rtl-arabic-copy.md` |
| Tables, lists, bulk actions | `console.md` (table grammar), `shared-principles.md` |
| Charts, KPIs, reports | `data-viz.md` |
| Arabic copy, numerals, money, time, a11y, RTL | `rtl-arabic-copy.md` |
| Reviewing code or a design | `review-checklist.md` plus the surface reference |
| Someone proposes something not in the house rules, **or your design needs something the house rules do not define** (bulk previews or result reports, jobs/imports, draft/publish, saved views, latency budgets) | `advisory-candidates.md`; label those parts **Advisory** and list the rest under open questions |
| Checking whether a page changed | `source-map.md` |

## Output shapes

**Review** (a screen, a diff, a PR): findings table with columns `Severity | Rule ID | Evidence (file:line or screen) | Fix`. Severities: **Blocker** (breaks a non-negotiable or an RT-24 invariant), **Major** (violates a Constitution rule), **Minor** (polish, token/logical-property misses), **Advisory** (only backed by `advisory-candidates.md`, never governing). End with "Needs verification" for anything that needs a packaged-app or runtime check, because the house rules explicitly separate design intent from runtime evidence (UX-11.29).

**Design** a screen or flow: give (1) purpose and the one primary action per region, (2) the state set (loading, empty, filtered-empty, error, stale, offline, blocked-with-reason) with copy for each, (3) focus/keyboard/scanner behaviour, (4) RTL and money/time formatting, (5) which rules govern, (6) what is *not* decided yet.

**Spec / slice**: bounded scope, exact rule IDs implemented, behaviour authority preserved (cite RT-24 invariant numbers), evidence required (visual, accessibility, runtime). Never propose a single "implement the Constitution" slice.

**Arabic copy**: follow `rtl-arabic-copy.md` (What -> Safety -> Action -> Evidence, verb jurisdiction, terminology table). Do not write English fallbacks.

## Reasoning rules that keep answers correct

- **Say which layer a statement comes from**: governing rule, shipped behaviour, approved-not-shipped, target, open, or advisory. Mixing them is the most common mistake.
- **When two sources disagree, the higher layer wins and the newer dated owner decision wins within its stated scope** (authority reference lists the layers and known amendments). Show both sides if the conflict is unresolved; do not pick silently.
- **Merged is not shipped.** Per the 2026-10-20 owner page, RT-242/243/244/440/445/530/542 stay In Review until packaged verification is recorded. Say "merged, verification pending" for Undo, Sale layout B and the void screen. Doc text on a feature branch is not governing until it is on `origin/main`.
- **Prefer the smallest safe commitment surface** (UX-05.3): inline acknowledge, then button commit, then confirmation dialog, then recovery workspace, chosen by consequence.
- **Compress space before meaning** (UX-04.4): at 1024x768 reduce decoration and secondary metadata before shrinking money, truth or the primary action.
- **Simplicity-first is owner policy** (Decisions register, 2026-10-20): the simplest sufficient approach that still keeps correctness, evidence and gates.

## Related skills

Use `impeccable` or `frontend-design` for generic visual critique that this skill does not cover, `driving-electron-via-cdp` to screenshot or drive the packaged POS, and `pr-review` for a full code review. This skill supplies the domain rules those skills lack; it does not replace them. `impeccable` reads POS `.impeccable/design.json`, which `DESIGN.md` Q-2 records as stale (still "Pharmacy Teal", mono money): where they differ, `DESIGN.md` and this skill win.
