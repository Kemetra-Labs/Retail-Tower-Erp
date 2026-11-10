### Added
- RT-1101 `[GATED]` OpenAPI (RT-1098 slice I-1, Post-Pilot; owner decisions RT-1098
  comments 15289, 15291 and 2026-11-10): new contract
  `packages/contracts/openapi/vouchers-admin.openapi.yaml` (`1.0.0-draft`,
  `x-runtime-status: contract-only`) with the tenant-scoped voucher issuance
  operations `consoleIssueVouchers`, `consoleListVouchers`, `consoleGetVoucher` and
  `consoleCancelVoucher`. Owner and tenant admin only, 1 to 100 vouchers per batch,
  non-replayable issue, codes returned once and never in a read, cancel of an expired
  voucher allowed. Adds its contract spec and console rate-limit class file. No
  runtime, migration, Admin-Console or POS change, and no change to the existing
  V-A contract (`pos-payments/vouchers.yaml`).
