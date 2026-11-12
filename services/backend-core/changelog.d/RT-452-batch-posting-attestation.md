### Added
- RT-452 `[GATED: migration]`, owner authorization of 2026-11-12 ("Owner attestation" for
  `erp_batch_posting_verified`, then "merge authorized"): migration `0104_batch_posting_attestation`
  adds three nullable columns to `tenant_inventory_settings` (`erp_batch_posting_attested_at`,
  `_attested_by`, `_evidence_ref`; all three set together or all NULL, the evidence reference
  non-blank and at most 200 characters). The operator CLI `inventory-effects attest-batch-posting
  --tenant <uuid> --actor <uuid> --evidence <ref> [--dry-run]` records the owner's attestation in one
  tenant-scoped transaction (it upserts the settings row, refuses a second attestation with exit 4,
  prints JSON with no PII). The tracked-selling precondition `erp_batch_posting_verified` is now met
  when the tenant holds the attestation; its contract meaning is unchanged. Nothing attests
  anything by itself and nothing switches tracked selling on. There is no un-attest command. The
  down migration refuses while any tenant holds an attestation. No new table, so no new grant.
