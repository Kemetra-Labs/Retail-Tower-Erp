/**
 * Eligible-set materialisation into Offer Pack revisions (spec 048 §7, OD-6,
 * OD-7; Jira RT-1337; schema 0101, Jira RT-1336).
 *
 * `rebuildOfferPack` brings the materialised rows (`offer_pack_eligible_products`)
 * in line with the plan of the tenant's live offers (`planPack`), in the
 * CALLER's transaction and under the tenant's advisory lock:
 *
 *   - no difference between the plan and the open rows: no revision (a publish
 *     that changes nothing a till can see, or a catalog change that moves no
 *     product, issues nothing);
 *   - otherwise ONE new tenant-wide revision (gapless, 0101) is issued; the
 *     open rows that left the plan, or whose offer version changed, are closed
 *     at it; the new rows open at it; and every store whose rows changed moves
 *     its applied revision to it. 0101's guards accept these writes only in
 *     the issuing transaction, so a revision's content is fixed at COMMIT.
 *
 * Called by every Pack-affecting write: publish, pause, resume, end, and a
 * catalog change that moves a product into or out of an eligible set. Rows of
 * an offer whose window closed by itself (no write happens then) are swept by
 * the next rebuild.
 */
import type { PoolClient } from "pg";

import { loadLiveOffers, loadTenantOffers, planPack, type PlannedRow } from "./offer-live";
import { dbNow, lockTenantOffers } from "./offers.repository";

const CHUNK = 5_000;

export interface RebuildResult {
  /** The revision issued, or null when nothing changed. */
  readonly revision: number | null;
  readonly changedStoreIds: ReadonlyArray<string>;
}

interface OpenRow {
  store_id: string;
  product_id: string;
  offer_id: string;
  offer_version: number;
}

const keyOf = (storeId: string, productId: string): string => `${storeId}|${productId}`;

export async function rebuildOfferPack(client: PoolClient, tenantId: string): Promise<RebuildResult> {
  await lockTenantOffers(client, tenantId);
  const now = await dbNow(client);
  const loaded = await loadTenantOffers(client, tenantId, now);
  const live = await loadLiveOffers(client, tenantId, loaded);
  const plan = planPack(live);

  const open = await client.query<OpenRow>(
    `SELECT store_id::text AS store_id, product_id::text AS product_id, offer_id::text AS offer_id, offer_version
       FROM offer_pack_eligible_products WHERE tenant_id = $1::uuid AND to_revision IS NULL`,
    [tenantId],
  );
  const current = new Map(open.rows.map((r) => [keyOf(r.store_id, r.product_id), r]));
  const wanted = new Map<string, PlannedRow>(plan.rows.map((r) => [keyOf(r.storeId, r.productId), r]));

  const toClose: OpenRow[] = [];
  const toOpen: PlannedRow[] = [];
  for (const [k, r] of current) {
    const w = wanted.get(k);
    if (w === undefined || w.offerId !== r.offer_id || w.version !== r.offer_version) toClose.push(r);
  }
  for (const [k, w] of wanted) {
    const r = current.get(k);
    if (r === undefined || w.offerId !== r.offer_id || w.version !== r.offer_version) toOpen.push(w);
  }
  if (toClose.length === 0 && toOpen.length === 0) return { revision: null, changedStoreIds: [] };

  const issued = await client.query<{ revision: string }>(
    `INSERT INTO offer_pack_revisions (tenant_id, revision)
     SELECT $1::uuid, COALESCE(max(revision), 0) + 1 FROM offer_pack_revisions WHERE tenant_id = $1::uuid
     RETURNING revision::text AS revision`,
    [tenantId],
  );
  const revision = Number(issued.rows[0]!.revision);

  // sequential: chunks run on one PoolClient (pg runs its queries one at a time).
  for (let i = 0; i < toClose.length; i += CHUNK) {
    const part = toClose.slice(i, i + CHUNK);
    await client.query(
      `UPDATE offer_pack_eligible_products t SET to_revision = $2::bigint
         FROM unnest($3::uuid[], $4::uuid[]) AS x(store_id, product_id)
        WHERE t.tenant_id = $1::uuid AND t.store_id = x.store_id AND t.product_id = x.product_id AND t.to_revision IS NULL`,
      [tenantId, revision, part.map((r) => r.store_id), part.map((r) => r.product_id)],
    );
  }
  for (let i = 0; i < toOpen.length; i += CHUNK) {
    const part = toOpen.slice(i, i + CHUNK);
    await client.query(
      `INSERT INTO offer_pack_eligible_products
         (tenant_id, store_id, product_id, offer_id, offer_version, from_revision)
       SELECT $1::uuid, x.store_id, x.product_id, x.offer_id, x.offer_version, $2::bigint
         FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::int[]) AS x(store_id, product_id, offer_id, offer_version)`,
      [tenantId, revision, part.map((r) => r.storeId), part.map((r) => r.productId), part.map((r) => r.offerId), part.map((r) => r.version)],
    );
  }
  const changed = [...new Set([...toClose.map((r) => r.store_id), ...toOpen.map((r) => r.storeId)])].sort();
  await client.query(
    `INSERT INTO offer_pack_store_revisions (tenant_id, store_id, applied_revision)
     SELECT $1::uuid, s, $2::bigint FROM unnest($3::uuid[]) AS s
     ON CONFLICT (tenant_id, store_id) DO UPDATE SET applied_revision = EXCLUDED.applied_revision`,
    [tenantId, revision, changed],
  );
  return { revision, changedStoreIds: changed };
}

/**
 * The catalog hook (Jira RT-1337 scope 2): a product was created or changed.
 * Re-materialises only when some offer rule names the product, or one of the
 * categories or brands it had or has now (a cheap, index-backed test), so an
 * unrelated product edit never recomputes a Pack.
 */
export async function rebuildOfferPackForCatalogChange(
  client: PoolClient,
  tenantId: string,
  change: { readonly productId: string; readonly categoryIds: ReadonlyArray<string | null>; readonly brandIds: ReadonlyArray<string | null> },
): Promise<RebuildResult> {
  // The tenant lock first: a concurrent publish holds it while it reads the catalog, so the gate below must see
  // that publish's committed rules (and the publish, if it comes after us, sees our committed product).
  await lockTenantOffers(client, tenantId);
  const r = await client.query<{ affected: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM offer_version_rules
        WHERE tenant_id = $1::uuid
          AND (product_id = $2::uuid OR category_id = ANY($3::uuid[]) OR brand_id = ANY($4::uuid[]))) AS affected`,
    [tenantId, change.productId, change.categoryIds.filter((x): x is string => x !== null), change.brandIds.filter((x): x is string => x !== null)],
  );
  if (!r.rows[0]?.affected) return { revision: null, changedStoreIds: [] };
  return rebuildOfferPack(client, tenantId);
}

/** A store was created, restored or deleted: all-stores offers follow the stores of the chain. */
export async function rebuildOfferPackForStoreChange(client: PoolClient, tenantId: string): Promise<RebuildResult> {
  await lockTenantOffers(client, tenantId); // before the gate, as in the catalog hook
  const r = await client.query<{ any: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM offer_versions WHERE tenant_id = $1::uuid AND all_stores) AS any`,
    [tenantId],
  );
  if (!r.rows[0]?.any) return { revision: null, changedStoreIds: [] };
  return rebuildOfferPack(client, tenantId);
}
