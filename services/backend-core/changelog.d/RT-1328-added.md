### Added
- RT-1328 `[GATED: contract]`, owner authorization in the issue (RT-1290): two platform-admin reads of the POS pilot lane in
  `pos-pilot-releases.openapi.yaml`, served: `platformListPilotReleases` (`GET /api/v1/platform/pos-pilot-releases`, every
  registry row newest first, withdrawn and current rows included) and `platformListPilotTenants`
  (`GET /api/v1/platform/pos-pilot-tenants`, every allowlisted tenant oldest first). Session cookie, platform admin only,
  `Cache-Control: no-store`, no query parameter, no audit row, no presigned URL or object key. They let the Platform Console
  (RT-1329) show the registry and the allowlist before it activates a release. No migration, grant, package or lockfile change.
