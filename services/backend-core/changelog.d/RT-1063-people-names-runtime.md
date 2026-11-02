### Added
- RT-1063: runtime for `listPeopleNames` (`GET /api/v1/console/people?ids=…`, contract
  RT-968). Up to 200 user ids resolve to `{ user_id, display_name }` for people with a
  non-deleted membership in the session tenant (revoked included; a soft-deleted user's name
  is null; a blank name is null); owner and tenant_admin resolve every such person, a store
  manager only people whose membership grants a store of their operator-surface scope
  (`callerStoreScope`). Unknown, cross-tenant and out-of-scope ids are absent. One query
  under tenant RLS on the existing `memberships (tenant_id, user_id)` and `store_access`
  indexes; `ids` count and length are bounded before any element is parsed. Audit
  `people.names_read` (registered as a read action; counts only); console rate-limit class
  `cheapRead`; every 200 is `Cache-Control: no-store`. `[GATED]` (RT-1063): only the
  operation's `contract-only` marker is removed from `console-people.openapi.yaml`. No
  migration or client change.
