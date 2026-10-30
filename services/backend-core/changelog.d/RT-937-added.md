### Added
- RT-937 `[GATED]`, owner authorization RT-791 c13305 (D-B): Admin sign-in for a user
  with an ACTIVE external identity link verifies the password at the identity provider
  on the server (request, response and session cookie unchanged; the local password of
  such a user never signs in; 503 when the provider is unavailable). New
  `POST /api/v1/auth/password/change` (cookie session only): replaces the password at
  the provider, revokes the user's other sessions, and counts failed attempts per user.
