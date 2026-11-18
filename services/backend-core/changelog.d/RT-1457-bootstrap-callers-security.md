### Security
- RT-1457 (audit A-04, RT-1389 phase 2): the request bootstrap reads (`RolesGuard`,
  `TenantContextGuard`, `ContextService`, the sign-in membership list and the POS stuck-shift
  membership lookup) no longer set the human platform-admin flag. They run on the SELECT-only
  `membership_bootstrap` system privilege added by migration `0120`, through the single
  `runWithSystemPrivilege` setter. `PLATFORM_ADMIN_ALLOWLIST` shrinks from 32 to 27 entries, and a
  new fence fails if either guard names `isPlatformAdmin: true` or `app.is_platform_admin` in code.
  Auth, role and tenant-context behaviour is unchanged. Deploy after migration `0120`.
