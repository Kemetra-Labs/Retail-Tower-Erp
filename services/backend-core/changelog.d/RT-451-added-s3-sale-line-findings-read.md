### Added
- RT-451 slice S3 (`[GATED: contract]`, marker removal only): the runtime of
  `listSaleLineFindings` (`GET /api/inventory/v1/safety/sale-line-findings`),
  which drops its `contract-only` markers. It reads the append-only
  `sale_line_findings` (0089) under the tenant's RLS, newest first
  (`recordedAt DESC, id DESC`), every finding `critical`, filtered by `kind`
  and `storeId`, in RT-731 keyset pages (`limit` 1-200, default 50) with an
  opaque cursor bound to the operation, the tenant and the filters (a
  foreign, tampered or filter-mismatched cursor is a 400
  `validation_error`). Owner and tenant_admin read the tenant; a
  store_manager only its own stores, as `listInventorySafetyFindings`; any
  other role is a 403. A `storeId` outside the caller's scope or not of the
  tenant answers an empty page. Console rate-limit class `expensiveRead`; a
  read, not audited.
