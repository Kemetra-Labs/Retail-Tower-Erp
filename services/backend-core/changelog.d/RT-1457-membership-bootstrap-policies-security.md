### Security
- RT-1457 `[GATED: migration]` (audit A-04, RT-1389 phase 2): migration `0120` adds five additive,
  SELECT-only policies keyed on a new `app.system_privilege` value, `membership_bootstrap`
  (`memberships`, `roles`, `tenants`, `stores`, `store_access`; no INSERT, UPDATE or DELETE), and
  `runWithSystemPrivilege` accepts the value. This step changes no caller: the request bootstrap
  reads still run on the platform-admin flag until the follow-up PR moves them. The `.down.sql`
  drops exactly the five policies.
