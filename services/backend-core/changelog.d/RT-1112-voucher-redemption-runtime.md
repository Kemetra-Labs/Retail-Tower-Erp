### Added
- RT-1112 `[GATED: contract]`, owner authorization RT-1112 c16636: the Contract V-A
  voucher runtime (`pos-payments/vouchers.yaml` 1.1.0-draft). `POST
  /api/pos/v1/vouchers/validate`, `/redeem` and `/reverse` are served (device token
  plus a live cashier claim on validate and redeem). Validate issues a 240 s
  single-use intent (hash stored only). Redeem consumes the whole voucher under a row
  lock with the `clock_timestamp()` expiry guard. Reverse restores it (an expired one
  too), from any device of the same store. Audit rows are `voucher.validated`,
  `voucher.redeemed` and `voucher.reversed`. A successful redeem replays before the
  admission check. Failed code or token lookups are limited to 10 per 15 minutes per
  device (429 with `Retry-After`, a contract addition). The POS voucher tender stays
  off (RT-103).
