### Added
- RT-973 (contract-first, owner delegation 2026-11-02, recommended option):
  `sale-sync-ops.yaml` `1.2.0-draft` adds an optional
  `SaleSyncStatus.syncStatusVersion`, the Backend-Core-owned ordering of a
  sale's sync status, so the Console can tell which of the sale detail and a
  repair response is newer. Not emitted yet; the runtime slice (combined with
  RT-977) emits it and makes it required. Decision records:
  `docs/planning/rt-973-sale-sync-status-ordering.md` and the RT-977 record §11.
