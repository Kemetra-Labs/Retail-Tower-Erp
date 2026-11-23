### Added
- RT-1404 `[GATED]` contract, owner-accepted design (RT-1303 comments 17134 and
  17135): the ERP sync-ops summary (`console-sync-ops.yaml` 1.3.0-draft) adds
  two optional `DomainSummary` fields so the Console can show each tile from
  catalog copy instead of the English `detail` text. `reconciliation.latestRun`
  is `{ status: running | completed | failed, at }` for the latest run in scope
  (`at` = `started_at`), or null when there is none. `connector_health.instances`
  is `{ total, stale, neverSeen }` over the active connector instances, and is
  absent when the tile is `not_available`. Additive: no new query, table or
  index, and `detail` is unchanged (now documented as diagnostic text).
