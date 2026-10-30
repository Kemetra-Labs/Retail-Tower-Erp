### Changed
- RT-1005 (docs, RT-717 Phase C5): the "Admin Console release" steps in
  `deploy/README.md` now fetch the monorepo release `admin-console/vX.Y.Z` from
  `Kemetra-Labs/Retail-Tower-Erp` instead of the frozen `Kemetra/Admin-Console`,
  and verify its build-provenance attestation (`gh attestation verify`, signed by
  `release-admin-console.yml` for that tag) as well as its checksum before the
  `current` symlink swap. Legacy `admin-console-<sha12>` releases already on a
  host stay as rollback targets. The README also states that the Console's
  `backendContractPin` should be the commit of the running Backend-Core release.
