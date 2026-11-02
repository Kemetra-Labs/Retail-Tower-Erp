### Added
- RT-968 `[GATED]` draft, decisions selected under the owner's delegation of 2026-11-02
  (captain session): contract `console-people.openapi.yaml` for `listPeopleNames`
  (`GET /api/v1/console/people?ids=…`), `x-runtime-status: contract-only`. Up to 200 user
  ids resolve to `{ user_id, display_name }` for people who hold or held a membership in the
  session tenant (revoked included; a soft-deleted user's name is null); a store manager
  resolves only people whose membership grants a store in their scope. No e-mail, role or
  grants; unknown and out-of-scope ids are absent. Audit action `people.names_read` (counts
  only); console rate-limit class `cheapRead`. Decision record
  `docs/planning/rt-968-people-name-read.md`. No runtime, migration or client change.
