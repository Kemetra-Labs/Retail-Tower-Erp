### Added
- RT-937 `[GATED]`, owner authorization RT-791 c13305 (D-B) and c13436 / c13437: `POST
  /api/v1/invitations/accept` is now a runtime route (public, per-IP limited). An existing
  user gains the membership only, with no session; a NEW user is created at the identity
  provider (verified email, ACTIVE password), the user, its identity link and the membership
  are written in one transaction, and a session cookie is set for that new user only. New
  `DESCOPE_MANAGEMENT_KEY` (environment only; unset answers 503, never logged) and a new
  routine domain-grants script `invitation-acceptance-domain-grants.sql` (INSERT on users,
  external_identity_links, memberships, store_access; UPDATE on invitations; no migration).
