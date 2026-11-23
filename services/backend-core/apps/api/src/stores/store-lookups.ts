/**
 * RT-1484 — read-only lookups of the tenant's live stores (`deleted_at IS NULL`) for other
 * modules, on the caller's client and inside its tenant transaction (RLS). The `stores` module
 * owns the table (RT-1453), so a module that must enumerate or check stores asks here instead of
 * naming the table in its own SQL.
 */
import type { PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query">;

/** Whether `storeId` is a live store of `tenantId`. */
export async function isLiveStore(client: Queryable, tenantId: string, storeId: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM stores WHERE tenant_id = $1::uuid AND id = $2::uuid AND deleted_at IS NULL`,
    [tenantId, storeId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The IANA time zone (`stores.timezone`) of a live store of `tenantId`, or null when there is none. */
export async function liveStoreTimezone(client: Queryable, tenantId: string, storeId: string): Promise<string | null> {
  const r = await client.query<{ timezone: string }>(
    `SELECT timezone FROM stores WHERE tenant_id = $1::uuid AND id = $2::uuid AND deleted_at IS NULL`,
    [tenantId, storeId],
  );
  return r.rows[0]?.timezone ?? null;
}

/**
 * RT-1485 (spec 044 MC-1): every store of `tenantId` with its IANA time zone, active or not and
 * deleted or not, ordered by id. The legacy import takes its Book-scope bound from the westernmost
 * of them, so a Store that comes back still sees the imported price from the import instant.
 */
export async function allStoreZones(client: Queryable, tenantId: string): Promise<{ id: string; timezone: string }[]> {
  const r = await client.query<{ id: string; timezone: string }>(
    `SELECT id::text AS id, timezone FROM stores WHERE tenant_id = $1::uuid ORDER BY id`,
    [tenantId],
  );
  return r.rows;
}

/**
 * A store as Pricing validation sees it: its IANA time zone and whether it is live for Pricing.
 * RT-1531: live for Pricing means not deleted AND active (`deleted_at IS NULL AND is_active`), as
 * spec 042 §3 (Q-B8: deactivating a Store stales a set) and 041 data-model §2.6 (reactivation
 * bootstraps the Store at the head) require. The other lookups in this file stay "not deleted".
 */
interface StoreForPricing {
  readonly id: string;
  readonly timezone: string;
  readonly live: boolean;
}

/**
 * Every Pricing-live store of `tenantId` (not deleted and active), plus the stores in `named` that
 * are the tenant's but deleted or deactivated (`live: false`), each with its time zone. A named id
 * the tenant does not have is absent.
 */
export async function liveAndNamedStores(
  client: Queryable,
  tenantId: string,
  named: readonly string[],
): Promise<StoreForPricing[]> {
  const r = await client.query<StoreForPricing>(
    `SELECT id::text AS id, timezone, (deleted_at IS NULL AND is_active) AS live
       FROM stores
      WHERE tenant_id = $1::uuid AND ((deleted_at IS NULL AND is_active) OR id = ANY($2::uuid[]))
      ORDER BY id`,
    [tenantId, named],
  );
  return r.rows;
}

/**
 * Up to `limit` live store ids of `tenantId`, ascending, strictly after `after` (keyset), limited
 * to `storeIds` when that is not null (an empty list reads nothing: fail closed).
 */
export async function liveStoreIdsAfter(
  client: Queryable,
  tenantId: string,
  page: { readonly after: string | null; readonly storeIds: readonly string[] | null; readonly limit: number },
): Promise<string[]> {
  const r = await client.query<{ id: string }>(
    `SELECT id::text AS id
       FROM stores
      WHERE tenant_id = $1::uuid
        AND deleted_at IS NULL
        AND ($2::uuid IS NULL OR id > $2::uuid)
        AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))
      ORDER BY id
      LIMIT $4`,
    [tenantId, page.after, page.storeIds, page.limit],
  );
  return r.rows.map((row) => row.id);
}
