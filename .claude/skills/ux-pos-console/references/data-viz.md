# Data visualization and reporting (UX-13)

Admin Overview ships a first chart and KPI set on `main` (`ReceiptRow`, `TrendPanel` with the RT-993 trend chart, `PostingPanel` in `apps/admin-console/src/overview/`); POS has none. Review those against these rules and extend them rather than adding duplicates; anything beyond them is target.

## Before any chart

1. **Question first, then the metric contract, then the representation** (UX-13.1-.2). A chart must earn its existence by a concrete comparison, trend, distribution, relationship or part-to-whole question.
2. Every KPI/chart metric owns: definition, scope, time grain and timezone, inclusions/exclusions, numerator/denominator for ratios, freshness, authoritative read-model source (UX-13.5). A ratio without its denominator is undefined (UX-13.11): do not chart a generic "return rate" until numerator and denominator are frozen.
3. Charts reveal patterns, **tables prove values** (UX-13.3). Analytics never become truth authority over sale, return, inventory, payment or ERP facts (UX-13.4).

## KPI grammar

A KPI is a claim with context: value, scope, period/grain, baseline and freshness inspectable together (UX-13.6). **No metric without scope** (Tenant/Store/all-store, consistent with UX-09). **Every delta names its baseline** (no bare "+8%"). **Direction is mathematics, judgment is domain meaning**: up/down never maps automatically to green/red (UX-13.9). Target comparison does not auto-create an alert (UX-13.27).

## Colour and encoding

Data colour is a separate family from status colour (UX-13.12): categorical for unordered identity, sequential for ordered magnitude, diverging only around a meaningful midpoint. Colour never owns identity: add direct labels, markers, line styles or position (UX-13.14); identity must survive forced colours and colour-vision loss, with an inspect/table path (UX-13.16). State may annotate data without recolouring it (UX-13.15).

## Chart choices

Bars start at zero (UX-13.17). Line axes may use a non-zero range only when explicit and truthful (UX-13.18). Dual axes need exceptional justification; prefer aligned small multiples (UX-13.19). Pie/donut only for a few categories with a meaningful whole (UX-13.20). Prefer direct labels over legends (UX-13.21). A sparkline needs time context (UX-13.22).

## Missing, stale, forecast

**Zero != missing != not applicable != pending** (UX-13.23). Do not draw through unknown truth: a missing time bucket is a gap, not zero sales, unless complete bucket emission is contractually guaranteed (UX-13.24). A stale chart is still stale: show snapshot age with UX-07 semantics (UX-13.25). Forecast never masquerades as fact (UX-13.26). Current-state counts (posted/pending/dead-lettered) do **not** imply a time series; a trend needs a bucket/history/retention contract, not successive client polls.

## Reporting and placement

Drill-down preserves scope, period, filters and series (UX-13.28). Hover reveals convenience, never exclusive information (UX-13.29). Export keeps metric definition, scope, filters, period/timezone and freshness (UX-13.30). Axes may abbreviate (k/M) but tooltips, tables and exports show exact values (UX-13.31). Multi-store reports declare a calendar policy (Store-local business day, a named reporting zone, or UTC evidence grain); never bucket by the viewer's workstation timezone. Analytics do not compete with transaction work: cashier Sale/Checkout stay transaction surfaces (UX-13.34). Charts transition state; they do not perform data: no count-ups, bar growth or pie spin (UX-13.35).

## Prototype disposition (UX-13.36)

`charts.jsx` stays reference-only. Not adopted: automatic up=green/down=red deltas, status tokens as a generic palette, routine dual-axis combos, colour-only donut identity.
