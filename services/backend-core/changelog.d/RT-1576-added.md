### Added
- RT-1576 `[GATED: contract]`, RT-1511 slice S1: `OnHand.availability` on `getOnHand` (`inventory.yaml` 1.23.0-draft).
  Backend-Core computes Available To Sell at the store's primary location (sellable, less expired tracked lots, less active
  reservations, less safety protection of zero) with In Transit inbound and outbound beside it, never clamped. Additive;
  no migration, no new table, no ERPNext read.
