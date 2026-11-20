### Changed
- RT-1312 `[GATED: contract]` (owner decision, RT-1312 comment 17812): `sale-sync-ops.yaml`
  now says that on the four quarantine operations (`consoleListQuarantinedSales`,
  `consoleGetQuarantinedSale`, `consoleRepairQuarantinedSale`, `consoleWriteOffQuarantinedSale`)
  a signed-in user with the wrong role gets the same 404 `not_found` as an absent or
  out-of-scope item, never 403, like the rest of the sale-sync-ops family. Wording only: the
  runtime already answers 404, and no operation, status code or schema changes. The `403` entries
  keep their keys and are reworded (`QuarantineForbidden`, `QuarantineForbiddenOrOriginRejected`)
  to say what a 403 can still be.
