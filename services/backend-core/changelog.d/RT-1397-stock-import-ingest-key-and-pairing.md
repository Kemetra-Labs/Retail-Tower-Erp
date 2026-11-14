### Changed
- RT-1397: the ERP-origin stock import (`ErpnextStockImportService`, RT-1288) follows
  `erpnext-connector/stock-import.yaml` 1.1.0-draft (RT-1396). Every reported ledger row
  keys itself with the base tuple (voucher type, voucher no, voucher detail no, warehouse,
  Batch when present) plus `ledgerEntryRef` and `entryIndex`, so the out row and the in
  row of a tracked Stock Reconciliation (-4 / +3) both import instead of the second
  becoming `duplicate_effect_key`. A cancelled row is the reverse of the earliest recorded,
  uncompensated original with the same base tuple, a strictly earlier `creation` and the
  exact-decimal negated `actualQty`; it takes that original's key plus `cancel`, and still
  imports or becomes a finding by the existing rule (an original that moved nothing in
  Retail Tower's books gives a finding). Step 0 position de-dup, the anchor `covered`
  rule and the RT-453 `awaiting_identity` resolution work on the new keys. No migration
  (`effect_key` is TEXT, provenance uniqueness is on the string); no contract change. The
  Connector's stock import is unscheduled in `hooks.py`; it stays unscheduled and off.
