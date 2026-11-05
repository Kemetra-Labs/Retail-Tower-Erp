### Security
- RT-1249 `[GATED: grants]`, owner approval recorded on RT-1249: the domain
  database role no longer reaches `users.password_hash` (RT-147 probe 5: it
  could read and overwrite every tenant's password hashes, since `users` has
  no RLS). The new routine `users-columns-domain-grants.sql` replaces its
  table-level `SELECT`, `INSERT` and `UPDATE` on `users` with column grants
  (`SELECT` id, email, display_name, is_platform_admin, deleted_at; `INSERT`
  id, email, display_name, email_verified_at). `invitation-acceptance-domain-grants.sql`
  no longer grants table-level `INSERT` on `users`. In production the API
  refuses to boot if the domain role can `SELECT`, `INSERT` or `UPDATE`
  `password_hash` by any path (table or column grant, `PUBLIC`, a member role),
  or lacks a required column grant. The invitation paths name their `users`
  columns. A rollback to an earlier release first needs the owner-run
  `users-columns-rollback.sql` (see `docs/operations/database-roles.md`).
