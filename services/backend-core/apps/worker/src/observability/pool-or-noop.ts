/**
 * `poolOrNoOp` — the "no DB, no consumers" choice every worker provider factory
 * makes (RT-1211).
 *
 * `AuditDbPool.pool === null` is the safe non-prod / no-Redis / no-DB path:
 * nothing is consumed, so a repository that lists no tenants stands in for the
 * Postgres-backed one. Returns `noOp()` on that path, otherwise `real(pool)`.
 * The result is the union of the two, so each branch only has to satisfy the
 * port the caller uses it as.
 */
export function poolOrNoOp<P, N, R>(pool: P | null, noOp: () => N, real: (pool: P) => R): N | R {
  return pool === null ? noOp() : real(pool);
}
