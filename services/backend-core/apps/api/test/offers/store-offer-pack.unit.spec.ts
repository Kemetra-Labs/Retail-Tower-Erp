/**
 * RT-1453: the `offers` store Offer Pack port (DB-less, a recording fake client).
 *
 * Store deletion asks this port how many distinct offers have a live eligible row at the store (what
 * the deletion's Pack rebuild drops), instead of naming `offer_pack_eligible_products`. The write
 * reaches `rebuildOfferPackForStoreChange` through the same `offers/index.ts`.
 */
import type { PoolClient } from "pg";

import { countOffersInPackOfStore, rebuildOfferPackForStoreChange } from "../../src/offers";
import { rebuildOfferPackForStoreChange as internal } from "../../src/offers/offer-pack.rebuild";

const STORE = "0e170000-0000-4000-8000-0000000a5001";

describe("countOffersInPackOfStore", () => {
  it("counts distinct offers with an open-revision row at the store", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [{ n: 3 }] };
      },
    } as unknown as PoolClient;
    await expect(countOffersInPackOfStore(client, STORE)).resolves.toBe(3);
    expect(calls[0]!.params).toEqual([STORE]);
    expect(calls[0]!.sql).toMatch(/count\(DISTINCT offer_id\)/);
    expect(calls[0]!.sql).toMatch(/to_revision IS NULL/);
  });

  it("is zero when the statement returns no row", async () => {
    const client = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
    await expect(countOffersInPackOfStore(client, STORE)).resolves.toBe(0);
  });
});

describe("the offers barrel", () => {
  it("re-exports the existing rebuild, not a copy", () => {
    expect(rebuildOfferPackForStoreChange).toBe(internal);
  });
});
