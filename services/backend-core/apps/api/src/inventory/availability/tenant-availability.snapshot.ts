/**
 * RT-1597 — the Available-to-Sell snapshot of every active store of a tenant, for the W9 redistribution proposals
 * (RT-1596 §3.1, candidate W1; W3 owns the snapshot, decision RT-1595 D-5). An internal port: no HTTP, no new table.
 *
 * It is the POS store-availability snapshot (`PosAvailabilityService`, RT-1577) walked over every store:
 *   - the store set is the Stores module's live set (not deleted AND `is_active`), asked through inventory's inverted port
 *     `InventoryStoreDirectory` (Stores already imports inventory, so inventory cannot import Stores);
 *   - per store, the catalog's `readStoreSellablePage` gives the sellable products and the resolved reorder level (the
 *     store's active level, else the tenant default, else null);
 *   - `readAvailabilityFactsOfPage` reads that page's facts in one statement and `composeStoreAvailabilityItem` applies the
 *     one A-1 formula. `composeAvailability` (the `OnHand.availability` composer) needs the primary location and the
 *     in-transit facts, which a page read does not carry; both composers call the same private `availableToSell`, so the
 *     snapshot cannot drift from `OnHand.availability` or the till. There is no second ATS formula here.
 *
 * Consistency: the caller's transaction is READ COMMITTED (`runWithTenantContext`), so stores are read at slightly
 * different instants. Each row carries its page's `asOf`, and each store its OLDEST page `asOf` (as the till keeps the
 * oldest page of a refresh). A caller that needs certainty re-reads at accept time.
 *
 * Limits are checked BEFORE the next read and the result is all or nothing: past `maxStores` or `maxRows` the answer is
 * `refused_too_large` and no row is returned. The placeholder values are owner decision P-6 (RT-1596), tuned in RT-1598.
 *
 * Side effect: the catalog read pins `app.current_store` per store. The previous value is restored before returning, so
 * the caller's transaction is left as it was found (only catalog override and price tables read that setting).
 */
import type { PoolClient } from 'pg';

import { readStoreSellablePage } from '../../catalog';
import type { InventoryStoreDirectory } from '../inventory-store-directory.port';
import { composeStoreAvailabilityItem, type SnapshotFacts } from './availability.rules';
import { readAvailabilityFactsOfPage } from './availability.snapshot.query';

/** The size limits of one snapshot. */
export interface TenantAvailabilityLimits {
  readonly maxStores: number;
  readonly maxRows: number;
}

/** Placeholder limits, owner decision P-6 (RT-1596): no measured basis yet. */
export const TENANT_AVAILABILITY_PLACEHOLDER_LIMITS: TenantAvailabilityLimits = Object.freeze({ maxStores: 50, maxRows: 20_000 });

/** One sellable product at one store. Quantities are exact `numeric(19,4)` decimal strings. */
interface TenantAvailabilityRow {
  readonly storeId: string;
  readonly productId: string;
  /** The A-1 Available-to-Sell, never clamped: it may be negative (A-4). */
  readonly availableToSell: string;
  /** The resolved reorder level: the store's active level, else the tenant default; null when neither is set. */
  readonly reorderLevel: string | null;
  /** The instant this row's facts were read (its page's `asOf`, ISO 8601). */
  readonly readAt: string;
}

/** One store that was read. */
interface TenantAvailabilityStore {
  readonly storeId: string;
  /** The oldest `asOf` of the store's pages (ISO 8601). */
  readonly readAt: string;
  readonly rowCount: number;
}

/** A requested store that was not read: deactivated or deleted, or not a store of this tenant. */
interface TenantAvailabilityExcludedStore {
  readonly storeId: string;
  readonly reason: 'inactive' | 'not_found';
}

export type TenantAvailabilitySnapshot =
  | {
      readonly kind: 'snapshot';
      readonly stores: readonly TenantAvailabilityStore[];
      readonly rows: readonly TenantAvailabilityRow[];
      readonly excludedStores: readonly TenantAvailabilityExcludedStore[];
    }
  | {
      readonly kind: 'refused_too_large';
      /** Which limit was passed. */
      readonly limit: 'maxStores' | 'maxRows';
      readonly max: number;
    };

/** Products scanned per catalog page (the POS snapshot's contract maximum). */
const PAGE_SIZE = 1000;
const ZERO_FACTS: SnapshotFacts = { primarySellable: '0.0000', expiredTrackedSellable: '0.0000', activeReserved: '0.0000' };

/**
 * The snapshot of the tenant's active stores, or of the requested `storeIds` among them (an empty list reads nothing).
 * Runs on the caller's tenant-scoped client (RLS), inside the caller's transaction. Rows are ordered by store id, then
 * product id.
 */
export async function readTenantAvailabilitySnapshot(
  client: PoolClient,
  input: { readonly tenantId: string; readonly storeIds?: readonly string[] | undefined; readonly limits: TenantAvailabilityLimits },
  deps: { readonly stores: InventoryStoreDirectory },
): Promise<TenantAvailabilitySnapshot> {
  const { tenantId, limits } = input;
  const requested = input.storeIds === undefined ? null : [...new Set(input.storeIds.map((id) => id.toLowerCase()))];
  const known = await deps.stores.liveAndNamedStores(client, tenantId, requested ?? []);
  const liveIds = known.filter((s) => s.live).map((s) => s.id.toLowerCase());
  const storeIds = requested === null ? liveIds : liveIds.filter((id) => requested.includes(id));
  const excludedStores: TenantAvailabilityExcludedStore[] =
    requested === null
      ? []
      : requested
          .filter((id) => !storeIds.includes(id))
          .map((id) => ({ storeId: id, reason: known.some((s) => s.id.toLowerCase() === id) ? 'inactive' : 'not_found' }));
  if (storeIds.length > limits.maxStores) return { kind: 'refused_too_large', limit: 'maxStores', max: limits.maxStores };

  const pinned = await client.query<{ store: string | null }>(`SELECT current_setting('app.current_store', true) AS store`);
  const restore = (): Promise<unknown> =>
    client.query(`SELECT set_config('app.current_store', $1, true)`, [pinned.rows[0]?.store ?? '']);
  let result: Awaited<ReturnType<typeof readStores>>;
  try {
    result = await readStores(client, tenantId, [...storeIds].sort(), limits.maxRows);
  } catch (err) {
    // Best effort: after a database error the transaction is aborted and the restore fails too; keep the first error.
    await restore().catch(() => undefined);
    throw err;
  }
  await restore();
  return result === null
    ? { kind: 'refused_too_large', limit: 'maxRows', max: limits.maxRows }
    : { kind: 'snapshot', ...result, excludedStores };
}

/** Every listed store in order; null as soon as the rows would pass `maxRows` (no partial result). */
async function readStores(
  client: PoolClient,
  tenantId: string,
  storeIds: readonly string[],
  maxRows: number,
): Promise<{ readonly stores: TenantAvailabilityStore[]; readonly rows: TenantAvailabilityRow[] } | null> {
  const stores: TenantAvailabilityStore[] = [];
  const rows: TenantAvailabilityRow[] = [];
  for (const storeId of storeIds) {
    const read = await readStore(client, tenantId, storeId, maxRows - rows.length);
    if (read === null) return null;
    stores.push({ storeId, readAt: read.readAt, rowCount: read.rows.length });
    rows.push(...read.rows);
  }
  return { stores, rows };
}

/** Every sellable product of one store, page by page; null as soon as more than `budget` rows would be returned. */
async function readStore(
  client: PoolClient,
  tenantId: string,
  storeId: string,
  budget: number,
): Promise<{ readonly readAt: string; readonly rows: TenantAvailabilityRow[] } | null> {
  const rows: TenantAvailabilityRow[] = [];
  let oldest: Date | null = null;
  let afterProductId: string | null = null;
  for (;;) {
    const page = await readStoreSellablePage(client, { tenantId, storeId, afterProductId, limit: PAGE_SIZE });
    if (rows.length + page.items.length > budget) return null;
    const facts = await readAvailabilityFactsOfPage(client, { storeId, productIds: page.items.map((p) => p.productId) });
    if (oldest === null || facts.asOf < oldest) oldest = facts.asOf;
    const readAt = facts.asOf.toISOString();
    for (const product of page.items) {
      const item = composeStoreAvailabilityItem(product.productId, facts.byProduct.get(product.productId) ?? ZERO_FACTS, product.lowStockLevel);
      rows.push({ storeId, productId: product.productId, availableToSell: item.availableToSell, reorderLevel: product.lowStockLevel, readAt });
    }
    // A page may hold no sellable product and still say more follow: the walk follows the SCANNED products.
    if (!page.hasMore || page.lastScannedProductId === null) break;
    afterProductId = page.lastScannedProductId;
  }
  // `oldest` is set: the loop body runs at least once, and the facts read always has its `asOf`.
  return { readAt: (oldest as Date).toISOString(), rows };
}
