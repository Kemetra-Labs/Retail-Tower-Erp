### Added
- RT-1458 `[GATED: contract]`, owner audit follow-up A-17, additive:
  `tenantAdminListErpnextItemMappings` (`GET /api/v1/catalog/erpnext-item-mappings`)
  accepts the optional `limit` (1 to 500) and `cursor` query parameters and returns
  `nextCursor` (`null` on the last page). Keyset order `suggested_at DESC, id`. Without
  `limit` the list is unchanged (every active mapping, `nextCursor` null); a default page size
  follows once the Admin-Console pages. Contract `1.2.0-draft`.
