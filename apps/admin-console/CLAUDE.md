> Program-wide operating instructions (Retail Tower OS §1–15 and the RT-948 push/merge rules) live in the root [CLAUDE.md](../../CLAUDE.md), which always loads. Only this product's additions are kept here.

### Allowed observability egress (RT-633, decision D9)

> **Allowed observability egress.** This service may send telemetry only to Sentry (`*.ingest.de.sentry.io`, org `kemetra`) and Datadog (`*.datadoghq.eu`, the EU1 org, per the owner decision of 2026-10-19 that supersedes D5; `*.us5.datadoghq.com` stays allowed only until the RT-736 cutover is verified and as rollback; or the internal Datadog Agent). It must follow the Observability contract (RT-629): allowlisted fields only, no PII, secrets or business payloads, default-inert without keys, and never blocking on vendor failure. Any new destination is a separate owner decision.

For the Console this means Sentry errors only, sent through Backend-Core's same-origin tunnel `/api/v1/console/telemetry/envelope` (OBS-3, RT-632), because the Caddy CSP is `connect-src 'self'`. The real DSN never reaches the browser. Session replay stays off (D7). The code lives in `src/observability/`.


<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
`specs/002-tooling-and-scaffold/plan.md`
<!-- SPECKIT END -->
