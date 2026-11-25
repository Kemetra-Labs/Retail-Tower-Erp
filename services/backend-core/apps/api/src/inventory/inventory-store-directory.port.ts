/**
 * RT-1597 — what inventory needs from the Stores module to enumerate a tenant's live stores, as an INVERTED port.
 *
 * Stores already imports inventory (`stores/deletion/store-deletion.facts.ts` reads open count sessions), so inventory
 * may not import the stores port directly (RT-1454 import cycle), and naming `stores` in inventory SQL would grow the
 * module-boundaries baseline. Inventory declares the interface and DI token here; Stores implements it
 * (`stores/inventory-store-directory.module.ts`, a `@Global()` module that only `app.module.ts` imports), so the SQL stays
 * in the module that owns the table. Same pattern as `STORE_PRICING_LIFECYCLE` (RT-1525), roles swapped.
 */
import type { PoolClient } from 'pg';

/** A store as the directory reports it. */
interface DirectoryStore {
  readonly id: string;
  /** Not deleted AND active (`deleted_at IS NULL AND is_active`). */
  readonly live: boolean;
}

export interface InventoryStoreDirectory {
  /**
   * Every live store of `tenantId`, plus the stores in `named` that are the tenant's but not live (`live: false`).
   * A named id the tenant does not have is absent. Runs on the caller's client (RLS).
   */
  liveAndNamedStores(client: PoolClient, tenantId: string, named: readonly string[]): Promise<readonly DirectoryStore[]>;
}

export const INVENTORY_STORE_DIRECTORY = Symbol('INVENTORY_STORE_DIRECTORY');
