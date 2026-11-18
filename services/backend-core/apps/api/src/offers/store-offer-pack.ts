/**
 * The live Offer Pack footprint of a store, as a public port of `offers` (RT-1453). Store deletion (its
 * preview and its write: one evaluator) used to name `offer_pack_eligible_products` itself; it asks this
 * port instead, on the caller's client. The write rebuilds the Pack for the store change
 * (`rebuildOfferPackForStoreChange`, exported beside this from `offers/index.ts`).
 */
import type { PoolClient } from "pg";

/** The number of distinct offers with a live (open-revision) eligible row at the store: what a deletion's rebuild drops. */
export async function countOffersInPackOfStore(client: PoolClient, storeId: string): Promise<number> {
  const r = await client.query<{ n: number }>(
    `SELECT count(DISTINCT offer_id)::int AS n
       FROM offer_pack_eligible_products WHERE store_id = $1 AND to_revision IS NULL`,
    [storeId],
  );
  return r.rows[0]?.n ?? 0;
}
