### Added
- RT-1418 `[GATED: .github, contract]`, owner direction "B + C" (2026-11-15): replacing the current POS pilot release
  is one approved run. New OIDC-only `POST /api/v1/platform/pos-pilot-releases/{releaseId}/supersede-current`
  (`platformSupersedeCurrentPilotRelease`, additive): in one transaction it withdraws the release that is current,
  never the keeper named in the path, only for a keeper the token's own run registered, only when the keeper is
  strictly newer (409 `release_not_newer`), and never activates. `promote-pos-pilot.yml` gains `replace_current`
  (default false) as a step of the live `register` job. Runbook sections 7 and 9 document replacement and rollback as
  roll-forward. The DB schema, the one-current index and the POS updater are unchanged.
