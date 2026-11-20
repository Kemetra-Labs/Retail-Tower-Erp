/**
 * RT-1484 (RT-282 PR-10b) — the tenant's pricing publish lock and the Store bootstrap row, shared by
 * Pricing and the Store lifecycle writes (spec 042 §8; spec 041 data-model §2.5, §2.6).
 *
 * It lives in `common` because both sides need it and Pricing already depends on the stores port:
 * a Store write importing from `pricing` would close a module cycle (RT-1454). There is ONE lock
 * key, so `pricing/pricing-publish-lock.ts` re-exports `lockPricingPublish` from here.
 *
 *   - `lockPricingPublish`: a transaction-scoped advisory lock per tenant, the
 *     `lockPostingFeedSequence` pattern (RT-456). It serializes, per tenant, a Change Set publish
 *     (its staleness re-check, revision allocation and fan-out), the Price Book create's
 *     single-Book check, a Zone retirement's in-use check, and every Store lifecycle write
 *     (create, activate, deactivate, delete, time-zone change). Lock order rule: take it as the
 *     FIRST statement of the transaction, before any row lock. Held until COMMIT or ROLLBACK.
 *   - `bootstrapStorePricing`: the bootstrap row `(store_id, head revision_no)` in
 *     `pricing_revision_stores` for a Store created or (re)activated after revisions were
 *     published, so its applied revision starts at the head (data-model §2.6). No row when the
 *     tenant has no revision yet; an existing row is kept (the primary key makes it idempotent).
 *     0121's insert trigger accepts a row that names the tenant's head.
 */
import type { PoolClient } from "pg";

/** Advisory-lock key namespace; the tenant id is appended. */
const PRICING_PUBLISH_LOCK_NAMESPACE = "pricing-publish";

/** Take the tenant's pricing publish lock for the rest of the transaction. */
export async function lockPricingPublish(client: Pick<PoolClient, "query">, tenantId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 0))`, [
    PRICING_PUBLISH_LOCK_NAMESPACE,
    tenantId,
  ]);
}

/** The Store's bootstrap fan-out row at the tenant's head revision (none before the first revision). */
export async function bootstrapStorePricing(
  client: Pick<PoolClient, "query">,
  input: { readonly tenantId: string; readonly storeId: string; readonly actorUserId: string; readonly correlationId: string },
): Promise<void> {
  await client.query(
    `INSERT INTO pricing_revision_stores (tenant_id, store_id, revision_no, created_by_user_id, correlation_id)
     SELECT $1::uuid, $2::uuid, h.head, $3::uuid, $4::uuid
       FROM (SELECT max(r.revision_no) AS head FROM pricing_revisions r WHERE r.tenant_id = $1::uuid) h
      WHERE h.head IS NOT NULL
     ON CONFLICT (tenant_id, store_id, revision_no) DO NOTHING`,
    [input.tenantId, input.storeId, input.actorUserId, input.correlationId],
  );
}
