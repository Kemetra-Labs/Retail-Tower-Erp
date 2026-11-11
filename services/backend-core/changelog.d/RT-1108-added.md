### Added
- RT-1108 (RT-1098 slice I-3): the Console voucher issuance runtime behind
  `vouchers-admin.openapi.yaml`. `consoleIssueVouchers` (`POST /api/v1/vouchers`)
  issues 1 to 100 server-generated codes in one transaction and returns them once
  (`Cache-Control: no-store`, non-replayable: a same-key retry is 409
  `idempotency_key_conflict`); `consoleListVouchers` and `consoleGetVoucher` read
  vouchers with the effective status (`expired` derived at read time) and never a
  code; `consoleCancelVoucher` cancels with one conditional update. Owner and
  tenant admin only. The contract's `x-runtime-status: contract-only` marker is
  lifted. Audit: `voucher.issued`, `voucher.cancelled` (never a code), reads
  `vouchers.listed` and `vouchers.read`.
