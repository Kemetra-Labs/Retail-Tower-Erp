### Fixed
- RT-1343 `[GATED]`, owner authorization 2026-11-12 (items 1, 3 and 5; blockers before
  `POS_SALE_VOUCHER_TENDER_ENABLED` can be turned on): a voucher redemption can no longer be
  undone behind the sale that spent it.
  `POST /api/pos/v1/vouchers/reverse` locks the redemption (`FOR NO KEY UPDATE`, the lock a
  capture takes) and refuses one that a sale tender pays with: 409 `redemption_consumed_by_sale`.
  An already reversed redemption still answers 200 with `already_reversed: true`, before that
  check. A full void of a completed voucher-paid sale now RESTORES the voucher: in the void's own
  transaction (created path only; a replayed void changes nothing) it reverses the redemption of
  each `voucher` tender and the voucher is `active` again, with one `voucher.reversed` audit row
  naming the sale. `recordVoid` takes the verified device (`posDeviceId`) for
  `reversed_by_device_id`. `RATE_LIMITED` joins the closed error sets of `posValidateVoucher` and
  `posRedeemVoucher` in `pos-payments/vouchers.yaml`, now 1.2.0-draft (descriptions only: no schema
  change, no consumer repin needed).
