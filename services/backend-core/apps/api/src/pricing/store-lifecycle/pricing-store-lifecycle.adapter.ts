/**
 * RT-1525 — Pricing's implementation of the stores port `StorePricingLifecycle` (spec 042 §8; spec 041
 * data-model §2.5, §2.6). Moved from `common/pricing-store-lifecycle.ts` (RT-1484 PR-10b) so the
 * pricing tables are written only by Pricing; the SQL, the lock key and the callers' transaction
 * position are unchanged.
 *
 *   - `lockForStoreWrite`: the tenant's pricing publish lock (`lockPricingPublish`). It serializes, per
 *     tenant, a Change Set publish, the Price Book create's single-Book check, a Zone retirement's
 *     in-use check and every Store lifecycle write.
 *   - `bootstrapStore`: the row `(store_id, head revision_no)` in `pricing_revision_stores` for a Store
 *     created or (re)activated after revisions were published, so its applied revision starts at the
 *     head. No row when the tenant has no revision yet; an existing row is kept (the primary key makes
 *     it idempotent). 0121's insert trigger accepts a row that names the tenant's head.
 */
import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";

import type { StorePricingBootstrap, StorePricingLifecycle } from "../../stores";
import { lockPricingPublish } from "../pricing-publish-lock";

@Injectable()
export class PricingStoreLifecycleAdapter implements StorePricingLifecycle {
  async lockForStoreWrite(client: Pick<PoolClient, "query">, tenantId: string): Promise<void> {
    await lockPricingPublish(client, tenantId);
  }

  async bootstrapStore(client: Pick<PoolClient, "query">, input: StorePricingBootstrap): Promise<void> {
    await client.query(
      `INSERT INTO pricing_revision_stores (tenant_id, store_id, revision_no, created_by_user_id, correlation_id)
     SELECT $1::uuid, $2::uuid, h.head, $3::uuid, $4::uuid
       FROM (SELECT max(r.revision_no) AS head FROM pricing_revisions r WHERE r.tenant_id = $1::uuid) h
      WHERE h.head IS NOT NULL
     ON CONFLICT (tenant_id, store_id, revision_no) DO NOTHING`,
      [input.tenantId, input.storeId, input.actorUserId, input.correlationId],
    );
  }
}
