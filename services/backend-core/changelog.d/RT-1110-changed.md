### Changed
- RT-1110 `[GATED]` OpenAPI, accepted break pending (RT-1098 slice R-1, Post-Pilot; owner
  decisions RT-1098 comments 15289, 15291, 16394 and 16402): amend the POS voucher contract
  V-A (`pos-payments/vouchers.yaml`, still `x-runtime-status: contract-only`). The three
  operations use the `device` credential (RT-224 option B) instead of the provider-JWT
  `operator-identity` scheme; `posValidateVoucher` and `posRedeemVoucher` carry a required
  `operatorUserId`, `posReverseVoucher` does not. `posRedeemVoucher` adds
  `voucher_cancelled`, `voucher_expired` and `voucher_branch_mismatch`; both validate and redeem
  gain the generic 403 `refused`. A redemption consumes the whole voucher and forfeits the
  remainder (decision 1A); `posValidateVoucher` returns `forfeited_amount_minor`. The code is
  normalised before lookup. No runtime, migration or POS change.
