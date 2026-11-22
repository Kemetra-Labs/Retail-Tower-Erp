/**
 * The per-product capture/profile lock (RT-451 comment 11790), moved here from
 * `sales/tracked-lines/capture-tracking.ts` (RT-1463): the lock guards a product's Tracking Profile,
 * which `catalog` owns. Under READ COMMITTED the first sale line of a product and a Tracking Profile
 * change could both commit without either seeing the other. Capture takes the product's key SHARED,
 * the profile setter EXCLUSIVE, both before they probe, so only one of the two commits against the
 * state the other would change. Runs on the caller's transaction client.
 */
import type { PoolClient } from "pg";

/** The advisory-lock namespace of a product's Tracking Profile (capture SHARED, setter EXCLUSIVE). */
const TRACKING_PROFILE_LOCK_NAMESPACE = "tracking_profile";

const LOCK_KEY_SQL = `hashtextextended($1 || ':' || $2::text || ':' || p::text, 0)`;

/**
 * Take the products' profile keys for the rest of the transaction, in id
 * order (so two captures never wait on each other in a cycle; SHARED keys
 * never block each other anyway). `exclusive` is the profile setter's mode.
 */
export async function lockProductProfiles(
  client: PoolClient,
  tenantId: string,
  productIds: ReadonlyArray<string>,
  mode: "shared" | "exclusive",
): Promise<void> {
  const ids = [...new Set(productIds)].sort();
  if (ids.length === 0) return;
  const fn = mode === "shared" ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock";
  await client.query(
    `SELECT ${fn}(${LOCK_KEY_SQL}) FROM unnest($3::uuid[]) WITH ORDINALITY AS u(p, n) ORDER BY n`,
    [TRACKING_PROFILE_LOCK_NAMESPACE, tenantId, ids],
  );
}
