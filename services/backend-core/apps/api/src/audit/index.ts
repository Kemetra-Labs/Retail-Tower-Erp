/**
 * The `audit` module's port (RT-1453 module boundaries). Other modules import from here, not from
 * the files inside. It exposes only what a route needs to be audited: the `@Auditable` marker and
 * the request annotation (ids and labels only, FR-AUDIT-3), and (RT-1484) the writer of an audit
 * row inside the caller's own transaction and (RT-1484 PR-6) the read-back of a fact such a row
 * recorded.
 */
export { Auditable, annotateAudit } from "./auditable.decorator";
export { insertAuditRowInTransaction, readFirstAuditMetadata, readLatestAuditMetadataWithKey } from "./audit-row.writer";
