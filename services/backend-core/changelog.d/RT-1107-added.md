### Added
- RT-1107 `[GATED]`, owner authorization RT-1098 comment 16496 (2026-11-11): migration
  `0091_vouchers` (voucher issuance slice I-2 of RT-1098) adds `vouchers` and
  `voucher_eligible_stores`, both FORCE ROW LEVEL SECURITY. `vouchers` holds the code as a
  hash only (unique per tenant), an amount in minor units, a currency code, a stored status
  of `active`, `redeemed` or `cancelled` (expiry stays derived from a nullable `expires_at`),
  the eligibility flag and the cancel columns; it has SELECT, INSERT and UPDATE tenant
  policies. `voucher_eligible_stores` pins its voucher and store to the same tenant by
  composite FKs and has SELECT and INSERT policies only. Adds the Drizzle schema, the
  `vouchers-domain-grants.sql` deploy script (domain role: SELECT, INSERT, UPDATE on
  `vouchers`; SELECT, INSERT on `voucher_eligible_stores`) and its grant fragment, and a
  down migration that refuses while any voucher exists. No runtime, redemption table or
  contract change; nothing reads or writes the tables yet.
