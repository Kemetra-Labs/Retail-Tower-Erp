# Source map and refresh protocol

Recorded 2026-10-21. Space: Confluence **RETAIL** (Retail Tower), site `rahmaqanater.atlassian.net`, cloudId `78e4deee-429c-4a88-9c95-38ffe1708bf9`.

## Refresh procedure

1. Fetch pages with `getConfluencePage(cloudId, pageId, contentFormat: "html")`. **Never trust `markdown`**: the export drops decision-list bodies and shows only headings. Very large pages (RT-116, Authority Matrix) exceed the tool limit and are saved to a file: convert with `python -I` (json, strip tags, `html.unescape`) and grep.
2. First read the **Decisions register (5341185)** and its children for owner decisions dated after the table below; update `authority-and-amendments.md` if a newer decision amends a page.
3. Compare each page's `lastModified` with this table. Re-read changed pages; update only the affected reference.
4. For implementation questions read the repo docs below and the code. GitHub `main` outranks every doc.

## Confluence pages (id, title, last modified at recording)

| ID | Page | Last modified |
|---|---|---|
| 5341185 | Decisions (register and index) | 2026-10-20/21 |
| 48824321 | Owner decisions 2026-10-20: D-K1, D-U1, RT-263, RT-400, RT-414, RT-392 | 2026-10-20 |
| 43712513 | Owner decision ratification and exclusions 2026-10-18 | 2026-10-18 |
| 40599553 | Owner decisions 2026-10-16: pilot cashier scope RT-536 | 2026-10-16 |
| 40468506 | Owner decisions 2026-10-16: store-wide sales history RT-534 | 2026-10-16 |
| 39550978 | Owner decisions 2026-10-15: void authorization, optional cash drawer RT-495 | 2026-10-15 |
| 24510466 | UX/UI Constitution Final Audit and Gap Map | 2026-10-07 |
| 23134234 | POS VNext Constitution Rebaseline | 2026-10-07 |
| 24018945 | UX-01 Product Personality | 2026-10-07 |
| 24150017 | UX-02 Color and Visual Identity | 2026-10-07 |
| 22839299 | UX-03 Typography and Iconography (icon rules added) | 2026-10-18 |
| 24215553 | UX-04 Layout, Density, Spatial System | 2026-10-07 |
| 24281089 | UX-05 Interaction Language | 2026-10-07 |
| 22806531 | UX-06 Motion and Micro-interactions | 2026-10-07 |
| 23658507 | UX-07 Operational States, Feedback, Resilience | 2026-10-07 |
| 23822338 | UX-08 Forms, Input, Validation | 2026-10-07 |
| 24215573 | UX-09 Navigation, Wayfinding, IA | 2026-10-07 |
| 23658523 | UX-10 Tables, Lists, Data-Dense Operations | 2026-10-07 |
| 23166988 | UX-11 Accessibility, RTL, Inclusive Operation | 2026-10-07 |
| 24477697 | UX-12 Content, Copy, Localization (two-locale target added) | 2026-10-08 |
| 23035927 | UX-13 Data Visualization and Reporting | 2026-10-07 |
| 7405593 | Cashier UX RT-24 / RT-25 Approved Planning Reference | 2026-10-08 |
| 32014353 | POS display and scaling support policy (RT-312) | 2026-10-12 |
| 24248322 | POS Direct Add and Delete Undo Contract (RT-245) | 2026-10-07 |
| 15663113 | POS Inactivity lock, held cart, stuck-payment contract (RT-116) | 2026-10-18 |
| 23035910 | Sales and Returns Operations architecture (decisions 991-1100) | 2026-10-07 |
| 24674305 | Shift and Cash Management architecture | 2026-10-07 |
| 21495809 | Authority and Capability Matrix | 2026-10-07 |
| 24444929 | Fiscal and Tax decisions 1248-1270 (Egypt gates) | 2026-10-07 |
| 29327361 | Admin Console Desktop Distribution Decision | 2026-10-15 |

**Not read yet (read before relying on them):** Catalog and Product Mgmt 23461894, Org and Store Mgmt 23625729, Pricing and Store Overrides 23855106, Payment/Tender/Receivables 23560196, Device Registry 23887876, ERP Integration and Sync Ops 25264129, Operational Support 25264161, Policy/Permissions 23134209, Fiscal and Tax product architecture 24084489, shadcn/MUI extraction 24576002, Reference Library 18120705, Khepri v2 8060950 (non-governing).

## Repo docs (monorepo `Kemetra-Labs/Retail-Tower-Erp`)

Both products live in this repository since the RT-715 cutover (2026-10-25); the former POS and
Admin-Console repositories are frozen. Before citing a doc, run `git fetch` and
`git diff --stat origin/main -- <doc>`: worktrees are often on feature branches.

Admin Console is Arabic-first: `index.html` is `lang="ar-EG" dir="rtl"` and `DEFAULT_LOCALE = "ar"`
(verified 2026-10-21). Confluence pages dated 2026-10-07 that call Admin English/LTR are stale.

POS (`apps/pos/`): `docs/DESIGN.md` (shipped tokens, constitution reconciliation table, open questions Q-1..Q-4); `docs/design/vnext/README.md`; `08-rt24-invariants.md` (I-1..I-17); `15-vnext-freeze-package.md` (journey map, state matrix S1-S22, M-states, input/focus/scanner contract, component/token contract, message catalogue M-*); `19`, `20`, `21` (PIN status, sale number, card outcome), `22-rt311-locale-architecture.md`, `24-vn-s6-connection-sync-signal.md`, `25-rt263-icon-registry-fluent-poc.md`, `26-rt536-cashier-feature-completeness.md`, `28-rt699-manual-discount-contract.md`, `29-rt278-shift-amount-bounds.md`; `visual-acceptance/` (visual reference only); `src/renderer/icons/`; `src/renderer/ui/format/human-format.ts`.

Admin Console (`apps/admin-console/`): `DESIGN.md` v4.0 (token block = shipped truth; §12 = the approved, not yet shipped, "Ink & Receipt" target); `docs/design/arabic-first-rtl-migration-plan.md` (RT-266); `docs/design/rt777-platform-console/README.md`; `docs/design/rt263-icon-registry/`; `design/claude-design-system/README.md`; `design/screens/README.md`; `src/styles/tokens.css`; `src/components/DataTable.tsx`.

## Quick staleness tells

A rule that says "planned", "target", "proposed" or carries a ⏳ marker is not shipped. A slice named in `DESIGN.md` (VN-S2, W1-x, IC-x) lands only through its Jira issue. If code and doc disagree, the code is what ships and the doc is stale.
