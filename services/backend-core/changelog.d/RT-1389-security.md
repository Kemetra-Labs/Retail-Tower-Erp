### Security
- RT-1389 `[GATED: migration]`, owner go-ahead 2026-11-14: public self-signup, the
  provisioner bearer verifier's credential lookup and the ERP provisioning sweep no longer
  set the human platform-admin flag. Each runs on its own narrow `app.system_privilege`
  value (`signup`, `provisioner_lookup`, `provisioning_sweep`), set only by
  `runWithSystemPrivilege`, with additive policies in migration `0111` that reach only the
  tables each path already used. None of them can read another tenant's
  `tenant_access_entitlements` row (the 0110 cross-tenant SELECT stays platform-admin only).
  A fence keeps every remaining production platform-admin site on an explicit allowlist.
- ERP provisioning request status transitions now come from one shared table in
  `packages/db`, used by the api repository and the worker sweep, and migration `0112`'s
  guard trigger rejects any other status change in SQL. A `succeeded` request records its
  host in the new `provisioned_host_label` column (the OD-10 per-host site count) instead of
  a synthetic ended lease, and no terminal request keeps a lease (a failure's reporting host
  is in its audit row); `0113` backfills the label. Deploy step 4 now also runs
  `docs/operations/sql/erp-provisioning-host-label-catchup.sql` (idempotent) after the new
  api and worker are up.
