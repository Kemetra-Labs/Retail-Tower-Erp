### Changed
- RT-1343 `[GATED]`, owner decision in chat 2026-11-12 (item 4 of the voucher-tender go-live blockers):
  `SaleTenderView.method` lists `voucher` in `pos-sales/sale-history.yaml` (1.1.0-draft) and
  `console-sales.openapi.yaml` (1.3.0-draft), as `SaleTender.method` of `sales.yaml` already does
  since RT-1114. The sale-history and console sale-detail reads returned the stored method unfiltered
  already; the contract and the projection types now say so. Adding a response enum value is a
  breaking change to a consumer (`response-property-enum-value-added`): acknowledged for the POS and
  the Admin-Console in `tools/oasdiff/breaking-ignore.txt` and, for the three supported POS
  snapshots, in `contracts-compat/accepted-breaks.txt`; both consumers are repinned in the same PR.
  No runtime change; no voucher tender exists until `POS_SALE_VOUCHER_TENDER_ENABLED` is turned on.
