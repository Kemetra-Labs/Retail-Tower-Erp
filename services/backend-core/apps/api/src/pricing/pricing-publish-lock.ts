/**
 * RT-1484 — the tenant's pricing publish lock (spec 042 §8; spec 041 data-model §2.5, §2.6).
 *
 * A transaction-scoped advisory lock per tenant, the `lockPostingFeedSequence` pattern (RT-456,
 * `packages/db/src/helpers/posting-feed-lock.ts`). It serializes, per tenant: the Price Book
 * create's single-Book check (price-structure.yaml, order of checks (4)), a Zone retirement's
 * in-use check (consoleRetirePriceZone) and, in later RT-1484 slices, a publish's revision
 * allocation and the Store lifecycle writes. Held until COMMIT or ROLLBACK.
 *
 * Lock order rule: take it as the first statement of the transaction, before any row lock.
 */
import type { PoolClient } from "pg";

/** Advisory-lock key namespace; the tenant id is appended. */
const PRICING_PUBLISH_LOCK_NAMESPACE = "pricing-publish";

/** A distinct namespace for Change Set validation (never the publish lock's key). */
const PRICING_VALIDATE_LOCK_NAMESPACE = "pricing-validate";

/**
 * RT-1484 PR-4b (review round 4): the tenant's Change Set validation lock, transaction-scoped. Two
 * validations of one tenant serialize, so the second reads the first's committed lines as
 * `conflicts_pending`. Lock order: the set's row lock (`FOR NO KEY UPDATE`) first, then this lock;
 * validation never takes the publish lock, and publish (PR-5) re-checks staleness under its own.
 */
export async function lockPricingValidate(client: Pick<PoolClient, "query">, tenantId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 0))`, [
    PRICING_VALIDATE_LOCK_NAMESPACE,
    tenantId,
  ]);
}

/** Take the tenant's pricing publish lock for the rest of the transaction. */
export async function lockPricingPublish(client: Pick<PoolClient, "query">, tenantId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 0))`, [
    PRICING_PUBLISH_LOCK_NAMESPACE,
    tenantId,
  ]);
}
