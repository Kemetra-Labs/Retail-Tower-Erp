### Added
- RT-1557 `[GATED: contract]`, owner authorization on RT-1557 (2026-11-23): `POST
  /api/v1/platform/tenants/{tenant_id}/connector-instances/{id}/adopt`
  (`platformAdoptConnectorRegistration`, `provisioning-feed.yaml` 1.1.0-draft), a platform-admin
  only, session only, audited operation that sets `connector_registration.managed_by` to
  `provisioner` on one existing registration (RT-1433 S1). It refuses a disabled registration
  (`409 registration_disabled`) and an already-managed one (`409 already_managed`), is idempotent
  for a repeat by the same admin, and writes one `connector.registration.adopted` audit row in the
  same transaction. No migration, no consumer repin. It ships dormant: running it on the lab is an
  owner step after RT-1360 and RT-1362 are live.
