### Changed
- RT-1468 `[GATED: contract]`, owner decision 2026-11-18 (RT-1468 comment 17463; amends RT-414 and
  RT-1462): a platform admin is admitted to every covered route of any existing tenant, member or
  not, WITHOUT a support session, and also on a suspended tenant. The support-session requirement
  and the suspended-tenant read-only rule are lifted for every route, so RT-1462's six-route list
  (`PLATFORM_DIRECT_HANDLERS`, the contract's `platform-direct-operations` and
  `PlatformDirectRoute`) is gone. Every platform-admin request on a covered route, member or not,
  writes one `platform.cross_tenant.accessed` row naming the live support session for the tenant
  when there is one (an expired one is absent); a member platform admin's force actions now name
  that session in `on_behalf_of`. The only refusals left are a tenant that no longer exists
  (`support_session_required`) and `origin_rejected`; `support_session_expired` and
  `support_session_read_only` are no longer returned but stay valid on older audit rows. The
  support session stays (optional purpose and ticket). Re-authentication, typed reasons and the D9
  cap are unchanged. No wire change; `platform-support-sessions` 1.4.0-draft, `context`
  1.4.0-draft, `console-force-actions` 1.2.0-draft, `stores` 1.5.0-draft. No new platform-admin
  database context (the gate keeps its existing support-session context).
