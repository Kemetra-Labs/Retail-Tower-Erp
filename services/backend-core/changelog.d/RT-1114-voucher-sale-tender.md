### Added
- RT-1114 `[GATED: migration, contract]`, owner authorization RT-1114 comment 16670 (RT-1098
  slice R-4a, decision 4A: a voucher is a tender): migration 0099 adds `voucher` to the
  `sale_tenders` method CHECK and a `redemption_id` column, set on a voucher tender and only
  there, with a same-tenant and same-store FK to `voucher_redemptions` and one tender per
  redemption. `pos-sales/sales.yaml` 1.23.0-draft and `erpnext-connector/posting-feed.yaml`
  1.12.0-draft add `voucher` and `SaleTender.redemptionId`. Capture refuses a voucher tender whose
  redemption is unknown, of another store, reversed, already used, in another currency or for
  another amount (422 `sale_voucher_tender_invalid`); Σ tenders = `posTotal` still holds. The
  posting feed carries the voucher tender and its `redemptionId`. Voucher tenders stay OFF: capture
  accepts them only behind the new default-off, compose-unmapped `POS_SALE_VOUCHER_TENDER_ENABLED`,
  to be turned on only after RT-1330 (R-4b) is deployed.
