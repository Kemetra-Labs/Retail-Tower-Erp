### Security
- RT-1051 `[GATED]`, owner authorization Jira RT-1051 comments 15078 and 15080
  (2026-11-01): request arrays that had no length limit are now bounded, closing
  zod GHSA-mrhx-c7xc-m3w5 (RT-1050) for them. zod 3 `.max()` still validates every
  element of an oversized array, so the new `boundedArray` helper checks the
  length first and aborts with a single 400 `validation_error` before any element
  or parent refinement runs. Limits, mirrored as contract `maxItems`: return and
  credit-reversal `lines` 50, `refundTenders` 16; membership-update and invitation
  `store_ids` 100; POS audit `events` 100; AI entitlement `targetStores` 100.
  Contracts: `pos-sales/sales.yaml` 1.16.0-draft, `memberships.openapi.yaml`
  2.2.0-draft, `pos-audit-events.openapi.yaml` 1.2.0-draft,
  `ai-entitlements.openapi.yaml` 1.1.0-draft. Capture-sale `lines` and `tenders`
  stay unbounded until the POS enforces the same caps (RT-1052).
