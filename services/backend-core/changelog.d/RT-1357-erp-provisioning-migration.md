### Added
- RT-1357 `[GATED: migration]`: migration `0109_erp_provisioning` (RT-1352 PB-B), storage only. Tables
  `erp_provisioning_request` (one active `tenant.provision` per tenant, lease, backoff, attempt floor,
  optimistic `version`), an append-only `erp_provisioning_step_log` (unique request, step, attempt) and
  `erp_provisioner_credential` (one live row per ERP host label); `connector_registration.managed_by`
  (nullable, no backfill); the `connector_provisioner` scope in `auth_tokens_scope_valid` with its
  platform-scope shape CHECK; a seeded system actor that cannot sign in. All three tables are FORCE RLS
  with a new `app.is_provisioner` setting for the provisioner bearer (it cannot write any other table).
  Grants script `erp-provisioning-domain-grants.sql`. The down migration refuses while provisioning data
  exists. No service, contract or Connector change.
