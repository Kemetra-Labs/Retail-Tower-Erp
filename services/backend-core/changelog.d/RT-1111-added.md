### Added
- RT-1111 `[GATED]`, owner authorization RT-1098 comment 16496 (2026-11-11): migration
  `0092_voucher_redemptions` (voucher redemption slice R-2 of RT-1098) adds
  `voucher_redemption_intents` and `voucher_redemptions`, both FORCE ROW LEVEL SECURITY with
  SELECT, INSERT and UPDATE tenant policies and no DELETE policy. An intent holds the hash of
  the short-lived redemption token (unique per tenant), the voucher, payment attempt, applied
  and forfeited amounts, the operator and device, and an expiry of at most 5 minutes after
  creation. A redemption (its id is the contract's `redemption_id`) links to exactly one intent,
  records the reverse (`reversed_at`, `reversed_by_device_id`, set together), and a partial
  unique index allows at most one un-reversed redemption per voucher. Composite FKs pin the
  voucher, store, intent and device (including the reversing device, which must belong to the
  redemption's store) to the row's tenant, and a redemption must equal its intent in store,
  voucher, payment attempt and amounts. Adds the Drizzle schema, the
  `voucher-redemptions-domain-grants.sql` deploy script (domain role: SELECT, INSERT on both
  tables; column-level UPDATE on `consumed_at` of the intents and on `reversed_at`,
  `reversed_by_device_id` of the redemptions) and its grant fragment, and a down migration that
  refuses while any row exists. No runtime or contract change; nothing reads or writes the
  tables yet.
