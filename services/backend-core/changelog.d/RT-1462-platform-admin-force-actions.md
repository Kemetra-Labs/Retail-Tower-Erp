### Changed
- RT-1462 `[GATED: contract]`, owner decision 2026-11-18 (amends RT-1437 D1): a platform admin may
  force-close a shift and delete a store on a customer's behalf, through the same guarded flows as
  the owner (`consoleListOpenShifts`, `consoleGetForceClosePreview`, `consoleForceCloseShift`,
  `previewStoreDeletion`, `consoleDeleteStore`, `consoleReauthenticate`). A platform admin who is not
  a tenant member still reaches the tenant only through the support session that names it (RT-414);
  one who is a member needs none. The ticket reference of that session is optional. A platform admin
  re-enters their own password. Every other caller keeps the uniform 404, a `tenant_admin` is still
  refused store deletion, and a support session stays read-only for every other write. The
  `shift.force_closed` and `store.deleted` audit rows gain `actor_kind` (`owner`, `tenant_admin`,
  `platform_admin`) and `on_behalf_of` (the tenant, the support session and its ticket reference,
  read from the server), and the `auth.reauth.*` rows carry them for a platform admin. No wire
  change; `console-force-actions` 1.1.0-draft, `stores` 1.4.0-draft. No new platform-admin database
  context (the RT-1389 allowlist is unchanged).
