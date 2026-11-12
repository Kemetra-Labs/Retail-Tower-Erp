### Added
- RT-1288 (RT-451 S2, RT-50 Q13): the tracked-selling precondition `erp_tracking_import` is now
  confirmed from the ERP-origin stock import. It is met when every live store has an active
  `stock` warehouse mapping and a completed import run (`erp_stock_import_runs`) on that
  mapping; a run on a retired mapping, or another tenant's run, does not count. Its contract
  meaning is unchanged. No migration. `erp_batch_posting_verified` stays unmet until RT-452.
