/**
 * The `audit` module's port (RT-1453 module boundaries). Other modules import from here, not from
 * the files inside. It exposes only what a route needs to be audited: the `@Auditable` marker and
 * the request annotation (ids and labels only, FR-AUDIT-3).
 */
export { Auditable, annotateAudit } from "./auditable.decorator";
