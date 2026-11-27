### Added
- RT-1362 S1 `[GATED: contract]`, owner decisions on RT-1362 (comments 19102, 19104 and 19107,
  2026-11-27): `provisioning-feed.yaml` 1.2.0-draft, contract only. `connectorIssueProvisionedCredential`
  gains the `credential.rotate` OVERLAP rule (RT-369 pattern): the call issues a pending credential
  and the current one stays valid; a repeat replaces the unpresented pending one; Backend-Core
  revokes the old credential in the same transaction that first accepts the new one; at most two
  unrevoked credentials per registration during a rotation; posting never pauses; a failed rotation
  revokes the pending credential and keeps the current one. The site stages the pending secret in a
  separate PENDING slot of Connector Settings (dual-slot staging: the provisioner never touches
  CURRENT, the Connector falls back to CURRENT on a `401` with PENDING and promotes PENDING on its
  first accepted call). Heartbeat-based completion stays with the other kinds; an early `succeeded`
  outcome on an open rotation is `409 lease_lost`. `tenant.provision` unchanged. Rotation
  keys on the stored site binding (new optional `ProvisioningRequest.erpnextSiteRef`; adopted
  registrations eligible), is routed to one ERP host (provisional, revision-checked host binding for
  adopted registrations), fenced per claim (optional `StepAckResult.leaseId` and
  `Provisioning-Lease-Id` header, enforced on `credential.rotate` only) and switched on only after a
  provisioner that handles it is deployed. New contract-only operation `POST
  /api/v1/platform/tenants/{tenant_id}/connector-instances/{id}/rotate-now`
  (`platformRequestConnectorCredentialRotation`): a platform admin creates a `credential.rotate`
  request due immediately; `201 requested` or `200 already_open`; `409 rotation_unavailable`,
  `not_managed`, `registration_disabled`, `provisioning_in_progress`, `site_not_bound`,
  `host_mismatch`, `host_not_bound` or `host_binding_stale`; audited. Runtime in RT-1362 S2 and S3.
  No migration, no runtime change, no consumer repin.
