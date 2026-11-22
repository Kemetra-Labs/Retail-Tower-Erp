### Added
- RT-1519 `[GATED: contract]`, owner instruction in chat 2026-11-22 ("Go"): the connector-health contract
  `erpnext-connector/connector-health.yaml` (1.3.0-draft) adds `transfer_dispatch` and `transfer_receive` to
  `acceptedWorkItemKinds` on the heartbeat body and the operator read, and the heartbeat validator accepts them.
  An unknown kind is still a 400. The Connector now advertises both kinds in its heartbeat. Backend-Core may emit
  the transfer work items only for a tenant whose Connector reports both (RT-1513 activation).
