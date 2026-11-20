### Added
- RT-1312 Phase 3(b), slice C `[GATED: contract]`: the Console repair of a quarantined sale.
  `consoleRepairQuarantinedSale` (`POST /api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}/repair`,
  `Idempotency-Key` required, `owner` and `tenant_admin` only) loses its contract-only marker. It
  re-ingests the item's stored body through the same capture code `captureSale` runs
  (`captureSaleInTransaction`, extracted from `SalesService.captureSale` with no behaviour change),
  under the item's provenance: one sale per `(tenant, sourceSystem, externalId)` by the FR-050 key
  and the RT-1206 same-facts rule, so a repeat, a race with a late till retry or a second repair
  never creates a second sale. The cashier admission window is not re-checked; a cashier named in
  the body must have been a tenant member at `occurredAt` (a later removal does not matter), else
  `repair_operator_unproven`. The sale is attributed to that cashier, else the repairer, on the
  item's `previousTerminalId`, else the uploading device. Always 200 with the item: `captured`,
  `already-captured` (same facts already captured) or `refused` (the item stays `open`, with the
  capture's status and code in `lastRepair`; a body whose facts differ, or a provenance captured in
  another store (404), can then only be written off). An item that is not `open` is 409
  `repair_conflict`; an item outside the caller's store scope is the same 404 as an absent one. One
  transaction: the capture runs under a savepoint, so a refusal is recorded on the item while the
  capture's rows roll back. The audit row carries ids, the state and the outcome, never the body.
  No migration (0093 already holds every column); `memberships` gains the `wasTenantMemberAt` port.
