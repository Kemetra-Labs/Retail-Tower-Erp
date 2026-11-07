# Advisory candidates (NOT governing)

Origin: a blind research pass written before reading the house rules (sources: NN/G data tables, WCAG 2.2, Material bidirectionality, Polaris/Carbon, GitLab Pajamas, payment-failure articles, Shopify POS design notes), then compared against Confluence and the repos on 2026-10-21. Items below were *not found* in the owner-approved rules. They may be proposed as ideas, labelled **Advisory**, and must never be stated as house rules. Adopting one requires an owner decision and its own bounded slice.

Status: **Confirmed gap** = not found in pages or repo docs read; **Unconfirmed** = likely lives in an unread page or POS repo doc; **Partial** = house covers part.

| ID | Candidate | Status | Handling |
|---|---|---|---|
| G1 | Bulk operations: preview of what changes, per-row result report, retry for partial failure | Confirmed gap | Strongest candidate. UX-10 covers selection scope only. Propose for Admin bulk work |
| G2 | Admin background jobs / progress centre; import template download and dry-run validation with row-level errors | Unconfirmed | Check Catalog & Product Mgmt, ERP Sync Ops, Operational Support pages first |
| G3 | Draft/publish, effective-dating and diff review before saving price/tax/permission changes | Partial | Approval/second-approval rules exist for pricing (ratified 2026-10-18); scheduling and diff UX not found. Read Pricing & Store Overrides (23855106) |
| G5 | Latency budgets (visual ack under 100 ms; scan-to-line about 300 ms) and a time-to-first-sale metric | Confirmed gap | House has only motion timings (80/150/220 ms). Propose as measurable targets, not rules |
| G6 | Soft delete / restore window for Admin entities with a stated deadline | Unconfirmed | Only RT-245 cart-line restore found |
| G7 | Permission-matrix UI with view-as-role; masking cost/margin by default | Partial | Authority Matrix covers roles, scope and credentials; matrix editor, preview and masking not found |
| G8 | Saved views, filter state in URL, sticky save bar | Confirmed gap (low risk) | UX-09.25 (URL depth vs visual depth) is compatible. Not a gap: the Admin command palette ships as the RT-969 Ctrl+K navigator (`src/shell/Navigator.tsx`) |
| G9 | Training mode; customer-facing display content rules | Confirmed gap, likely post-pilot | Do not design ahead of scope |
| G10 | Peripheral health with one-tap test/reconnect | Partial | UX-07.3 names printer in the status vector; check Device Registry and Operational Support pages |
| G11 | AAA contrast target for primary POS text under counter glare | Confirmed gap | House has forced-colours and the Color Under Pressure gate only |
| G14 | Minimum spacing between touch targets (about 8 px) | Confirmed gap (minor) | House relies on the 44 px floor and the 4 px scale |
| G16 | Table first column is a human-readable record identifier, not a raw ID; default column order by importance (NN/G) | Confirmed gap (partly implied by UX-10.6 "primary identity") | Offer as a suggestion; cite NN/G, not UX-10 |
| G17 | Visible "filters active" indicator with one-click clear; end-aligned numeric columns (NN/G, Polaris) | Confirmed gap | UX-10.15 only requires reset on filtered-empty |
| G18 | Type-to-confirm for rare catastrophic deletions (external UX advice) | Confirmed gap | House model is a consequence-stating dialog with a safe default (UX-05.23); do not present type-to-confirm as a rule |

## Resolved by the repo pass (not gaps; do not propose)

- Unknown-barcode flow: covered by freeze S3 / M-S3.
- Known card decline: covered by S11 / M-P8 (contract D-P1 pending, card is post-pilot).
- Lock screen content: freeze 2.1 / L3 / RT-161 hide everything.
- VAT / fiscal display: owned by Fiscal & Tax (pilot tax line stays «قيد الإضافة · لا تُحسب هنا»; I-17 forbids fiscal claims). An **ETA e-receipt status UI** is not defined anywhere; it needs an owner decision and must respect "No Silent Degradation" and "No Compliance by Assumption".
- Thumb-zone placement: dropped (desktop Electron).
- Drawer events: reasons by policy are covered (Shift & Cash); the drawer itself is optional (RT-495).

## Sourced but overridden by house rules (do not reintroduce)

- Alternate tender offered immediately after any decline (only valid after a *proven* decline).
- Keyboard shortcuts on POS (D-K1).
- User-persisted density toggle (UX-04.2: context-driven).
- Pagination totals and "virtualize above ~50 rows" (UX-10.17, .21, .32).
- Relative-time-with-hover as the only absolute time (UX-12.29, UX-05.7).
