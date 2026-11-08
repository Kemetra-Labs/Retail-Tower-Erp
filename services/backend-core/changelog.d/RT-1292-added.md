### Added
- RT-1292 `[GATED: contract, migration]`, owner authorization in the issue (RT-1290 slice P1): the POS **pilot** release lane
  in Backend-Core, separate from the production lane designed in RT-1260. New contract `pos-pilot-releases.openapi.yaml`
  (`consolePilotGetLatestPosRelease`, `platformAddPilotTenant`, `platformRemovePilotTenant` served; register, withdraw and
  activate `contract-only`), migration `0088_pos_pilot_releases` (`pos_pilot_release_registry`, which admits only signing
  class `pilot` and refuses the lab markers, with at most one current release, and `pos_pilot_tenant_allowlist`), the
  resolver and the platform allowlist routes. A signed-in owner, tenant admin or store manager of an allowlisted tenant gets
  the current pilot release and a short-lived presigned URL naming the verified object version, otherwise exactly
  `{ "available": false }`. The lane is inert until a release is registered and activated, and until the S3 presigner (a
  later slice) is bound: an unconfigured lane answers `available:false`. Audit rows `pos.pilot_release.download_link_issued`
  (no URL) and `pos.pilot_tenant.added` / `pos.pilot_tenant.removed`; counter `pos_pilot_release_resolve_total{outcome}`.
  No package or lockfile change.
