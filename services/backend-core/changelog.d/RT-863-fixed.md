### Fixed
- RT-863 `[GATED .github]`, owner authorization in chat 2026-10-26 (MR-3): the POS compatibility
  matrix runs again as the root CI job `bc/contracts-compat`, so the monorepo release guard no
  longer refuses every Backend-Core SHA. `contracts-compat/pos-supported.yaml` is re-keyed from
  Kemetra/Backend-Core 1711813d to its imported commit 30cff009 (tools/history/crosswalk); every
  snapshot blob and `snapshot_sha256` are unchanged.
