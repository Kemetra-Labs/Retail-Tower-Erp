### Changed
- RT-1276: the Datadog site default is now EU1 (`datadoghq.eu`) in `deploy/datadog/apply.mjs`,
  `docker-compose.prod.yml` and `deploy/prod.env.example`, so a recreated agent or an `apply.mjs`
  run without `DD_SITE` no longer falls back to another site. An explicit `DD_SITE` still wins. The
  allowed observability egress text in the Backend-Core, ERPNext-Connector and Admin-Console
  `CLAUDE.md` files now matches the POS wording.
