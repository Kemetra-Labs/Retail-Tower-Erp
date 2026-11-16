### Added
- RT-1427 `[GATED: migration, contract]`, owner delegation in chat 2026-11-16:
  the Connector heartbeat carries the Count activation evidence. Migration 0115
  adds four nullable columns on `connector_health` (accepted work-item kinds,
  back-dated role status, its Connector check time and its DP2 server report
  time). `connector-health.yaml` 1.2.0-draft adds the optional
  `acceptedWorkItemKinds` and `backDatedRole` to the heartbeat body and the
  operator read; a beat that omits them clears them. Additive, no new endpoint.
