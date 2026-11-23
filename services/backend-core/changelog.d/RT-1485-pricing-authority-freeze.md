### Added
- RT-1485 `[GATED]`, owner authorization in chat (2026-11-23): migration
  `0132_pricing_authority_freeze` (spec 044 PR-16a-1). New FORCE-RLS tables
  `tenant_pricing_authority` (seeded `legacy` for every tenant; a tenants trigger adds the row for
  new tenants), `pricing_import_runs` and `pricing_cutover_runs`; a freeze trigger on
  `tenant_products` and `store_product_overrides` that rejects legacy price writes once a tenant
  leaves `legacy` (inert today), with one privileged bypass, `pricing_reverse_project`, owned by
  the `NOLOGIN` role `pricing_projection_writer`. **Deploy prerequisite:** a superuser creates that
  role and grants it to the migration owner before `migrate up` reaches 0132
  (`docs/operations/database-roles.md`). Grants script
  `docs/operations/sql/pricing-authority-domain-grants.sql` (domain role: `SELECT` on the authority
  table only).
