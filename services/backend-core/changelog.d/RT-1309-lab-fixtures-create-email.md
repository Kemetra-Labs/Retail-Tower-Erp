### Fixed
- RT-1309: the lab-fixtures CLI now sends the fixture's non-deliverable email
  (`rtfx-cashier-NNN@fixtures.invalid`) when it creates the Descope Test User; Descope refuses a
  create with neither email nor phone (`E011002`), so the first live `provision` was refused. A
  refused create now reports the provider's error code (`provider_create_rejected:E011002`), only
  when it is a well-formed code, never the message or body. No HTTP route or runtime path changed.
