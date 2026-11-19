# Decisions Index

Durable technical decisions recorded in this repository. Project-level decisions, context and status live in [Confluence RETAIL](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL); the work that implements a decision is tracked in [Jira RT](https://rahmaqanater.atlassian.net/jira/software/projects/RT). Each record's own status line wins over this summary.

| Record | Decision | Status |
|---|---|---|
| [ADR-0002](./adr-0002-procurement-boundary.md) | Procurement: historical Delegate (2026-06-08, Option B) is superseded as the future target by **Progressive Mediate** (owner-ratified 2026-11-19, [ADR-RT-002](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/84606983) / [CR02](https://rahmaqanater.atlassian.net/wiki/spaces/RETAIL/pages/84050068)). Delegate restrictions remain the current runtime until typed contracts, permissions and tests are approved and deployed. No implementation is authorized. | Target ratified; implementation not started |

## Other records (frozen copy)

ADR-0001, ADR-0003 to ADR-0006 and the `AD-*` records were not migrated. Their frozen copies are in [`Kemetra/Orchestrator`](https://github.com/Kemetra/Orchestrator/tree/420db8b1176e2fbf67eb4d32f520d09e2b912ecf/docs/decisions) (AD-ORCH-003); where one of them still calls procurement "delegated to ERPNext (Option B)", read it with ADR-0002 above.
