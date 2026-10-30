### Changed
- RT-941 `[GATED]`, owner authorization 2026-10-29 (production config): the
  production compose and `deploy/prod.env.example` require `DESCOPE_PROJECT_ID`
  and pass `IDENTITY_PROVIDER` (default `descope`) plus the optional
  `DESCOPE_JWT_ISSUER` / `DESCOPE_JWT_AUDIENCE`. `CLERK_SECRET_KEY`,
  `CLERK_AUTHORIZED_PARTIES` and `CLERK_JWT_AUDIENCE` are removed. The
  schemathesis fuzz stack uses a dummy Descope project id. Upgrade order is in
  `deploy/README.md` (Prerequisites 9): set `DESCOPE_PROJECT_ID` and move each
  operator's identity link to `descope` (RT-797 CLI) before or with this release.
