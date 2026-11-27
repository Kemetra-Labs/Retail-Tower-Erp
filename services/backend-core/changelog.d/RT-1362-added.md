### Added
- RT-1362 S1 `[GATED: contract]`, owner approval on RT-1362 (comment 19102, 2026-11-27):
  `provisioning-feed.yaml` 1.2.0-draft. `connectorIssueProvisionedCredential` gains the
  `credential.rotate` repeat rule (the first call revokes the presented current credential and
  issues one new one atomically; a repeat replaces the never-presented credential this request
  issued; once that one is presented a repeat is the same `404`; no overlap window,
  `tenant.provision` unchanged). New contract-only operation `POST
  /api/v1/platform/tenants/{tenant_id}/connector-instances/{id}/rotate-now`
  (`platformRequestConnectorCredentialRotation`): a platform admin creates a `credential.rotate`
  request due immediately for one managed registration; `201 requested` or `200 already_open`;
  `409 rotation_unavailable` (rotation off until a provisioner that handles the kind is deployed),
  `not_managed`, `registration_disabled`, `provisioning_in_progress` or `site_not_bound`; audited.
  Adopted managed registrations are eligible (owner decision, RT-1362 comment 19104): rotation keys
  on the stored site binding, sent as the new optional `ProvisioningRequest.erpnextSiteRef`, and the
  provisioner verifies the site before anything is revoked. A rotation is done when the site first
  presents the new credential. Runtime in RT-1362 S2 and S3. No migration, no runtime change, no
  consumer repin.
