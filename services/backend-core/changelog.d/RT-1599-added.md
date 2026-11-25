### Added
- RT-1599 `[GATED: contract]`, W9 slice A (N2): new `inventory/redistribution-proposals.yaml` 1.0.0-draft, the contract
  for store redistribution proposals under `/api/inventory/v1/redistribution-proposals`: compute, list, get, review
  (shadow phase, "would accept" / "would reject"), accept (live phase, W3 shipment transfers in `draft` only) and reject.
  Owner or tenant_admin; every other role, another tenant and a tenant with the feature off get the same non-disclosing
  404. Every command requires `Idempotency-Key`. Contract-only until the RT-1600 runtime lands. Additive: a new file,
  no existing operation changes; no migration.
