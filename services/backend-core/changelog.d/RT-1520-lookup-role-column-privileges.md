### Security
- RT-1520: the API boot check `assertLookupGrants` now also refuses a column-level
  `SELECT`, `INSERT`, `UPDATE` or `REFERENCES` held by the BYPASSRLS auth lookup role on any
  table a grant fragment lists as forbidden for it, limited to the privileges the entry
  lists. A grant to PUBLIC or through an inherited role counts. `has_table_privilege` ignores column grants, so `GRANT SELECT (cells) ON
  catalog_import_rows` used to pass. The error names the table and columns. No change to
  which tables are forbidden.
