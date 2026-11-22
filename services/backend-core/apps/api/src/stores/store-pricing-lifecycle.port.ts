/**
 * RT-1525 — what a Store lifecycle write needs from Pricing, declared by Stores (an inverted port).
 *
 * Pricing already imports the stores port (`index.ts`), so Stores may not import Pricing: that closes
 * a module cycle (RT-1454). Stores declares this interface and its DI token instead; Pricing
 * implements it (`pricing/store-lifecycle/pricing-store-lifecycle.adapter.ts`) and provides the token
 * from a `@Global()` module that only the composition root (`app.module.ts`) imports.
 *
 * Contract (spec 042 §8; spec 041 data-model §2.5, §2.6):
 *   - Both methods run on the CALLER's client, so the caller's transaction and RLS context stay in force.
 *   - `lockForStoreWrite` is the tenant's pricing publish lock, transaction-scoped. Take it as the FIRST
 *     statement of every Store lifecycle write (create, activate, deactivate, delete, time-zone change),
 *     before any row lock. Held until COMMIT or ROLLBACK.
 *   - `bootstrapStore` writes the Store's bootstrap row at the tenant's head pricing revision, in the same
 *     transaction as the create or activation. It writes nothing before the tenant's first revision and
 *     is idempotent (a repeat keeps the existing row).
 */
import type { PoolClient } from "pg";

/** The DI token Pricing provides `StorePricingLifecycle` under. */
export const STORE_PRICING_LIFECYCLE = "STORE_PRICING_LIFECYCLE";

/** Who and why, for the bootstrap row. */
export interface StorePricingBootstrap {
  readonly tenantId: string;
  readonly storeId: string;
  readonly actorUserId: string;
  readonly correlationId: string;
}

export interface StorePricingLifecycle {
  /** The tenant's pricing publish lock; the first statement of a Store lifecycle write. */
  lockForStoreWrite(client: Pick<PoolClient, "query">, tenantId: string): Promise<void>;
  /** The Store's bootstrap row at the tenant's head revision; none before the first revision; idempotent. */
  bootstrapStore(client: Pick<PoolClient, "query">, input: StorePricingBootstrap): Promise<void>;
}
