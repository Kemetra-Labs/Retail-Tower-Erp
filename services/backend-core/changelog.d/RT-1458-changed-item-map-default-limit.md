### Changed
- RT-1458 `[GATED: contract]`, owner audit follow-up A-17 PR 3c: `tenantAdminListErpnextItemMappings`
  (`GET /api/v1/catalog/erpnext-item-mappings`) applies a default page size of 100 when `limit` is
  absent: the response is the first page and `nextCursor` leads to the rest (it was every active
  mapping in one response). `limit` still accepts 1 to 500. The Admin-Console has paged since
  PR 3b and always sends `limit`; no other consumer pins the contract. Contract `1.3.0-draft`.
