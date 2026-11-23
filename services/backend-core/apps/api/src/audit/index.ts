/**
 * The `audit` module's port (RT-1453 module boundaries). Other modules import from here, not from
 * the files inside. It exposes only what a route needs to be audited: the `@Auditable` marker and
 * the request annotation (ids and labels only, FR-AUDIT-3), and (RT-1484) the writer of an audit
 * row inside the caller's own transaction and (RT-1484 PR-6) the read-back of a fact such a row
 * recorded.
 */
export { Auditable, annotateAudit } from "./auditable.decorator";
/**
 * RT-1557: the guard of a platform-admin route (`users.is_platform_admin`, read from the database),
 * run after `SessionOnlyAdminGuard`. A host module lists it in `providers` and imports `ContextModule`.
 */
export { PlatformAdminGuard } from "./platform-admin.guard";
export { insertAuditRowInTransaction, insertAuditRowsInTransaction, readLatestAuditMetadataWithKey } from "./audit-row.writer";
export type { TransactionalAuditRow } from "./audit-row.writer";
/**
 * RT-1539: a route that must emit its audit event only on SOME 200 outcomes (the Manager Sales answer,
 * not its refusal) cannot use `@Auditable`, which fires on every 2xx. It enqueues the same job the
 * interceptor would, through this seam.
 */
export { AUDIT_JOB_ENQUEUER } from "./audit-job.enqueuer";
export type { AuditJobEnqueuer } from "./audit-job.enqueuer";
export type { AuditJobPayload } from "./audit-job.types";
