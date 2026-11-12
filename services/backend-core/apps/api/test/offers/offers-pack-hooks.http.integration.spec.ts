/**
 * RT-1337 (RT-286 S4) — the Pack follows the catalog and the store list, the
 * OD-7 re-materialisation rule, and concurrent writers, over HTTP against real
 * Postgres with the real Console catalog, stores and offers modules.
 *
 *   - a catalog change (category, active, retire, a new product) that moves a
 *     product into or out of a live set issues a new Pack revision in the same
 *     transaction; an edit no rule can see issues none;
 *   - a store added later joins an `allStores` offer's Pack; a deleted store
 *     leaves it; an explicit store list never grows;
 *   - two live offers that come to want the same product (a catalog change):
 *     the earlier-published keeps it, the later one is reported in
 *     `rematerialisationConflicts`, and the Pack holds the product once;
 *   - two writers at once serialise: revisions stay gapless, and a product is
 *     in one offer only.
 */
import "reflect-metadata";

import { Module, type INestApplication } from "@nestjs/common";
import request from "supertest";

import { ConsoleCatalogModule } from "../../src/catalog/console-catalog/console-catalog.module";
import { OffersModule } from "../../src/offers/offers.module";
import { StoresModule } from "../../src/stores/stores.module";
import { idempotencyProviders } from "../_helpers/idempotency-providers";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";
import { bootScopedApp } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  BR_ADIDAS,
  BR_NIKE,
  CAT_HATS,
  CAT_SHOES,
  P_BARE,
  P_HAT,
  P_RUN,
  P_TRAIN,
  SES_OWNER_ALL,
  STORE_A_X,
  STORE_A_Y,
  TENANT_A,
  seedOffersFixture,
} from "./__support__/offers-fixture";

@Module({ imports: [OffersModule, ConsoleCatalogModule, StoresModule] })
class OffersWiringModule {}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let skipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedOffersFixture(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw new Error(`Container start failed: ${err instanceof Error ? err.message : String(err)}`);
    skipped = true;
    return;
  }
  app = await bootScopedApp(env, OffersWiringModule, undefined, { authLookupPool: env.admin, providers: idempotencyProviders() });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = (): boolean => skipped;
const ORIGIN = "http://127.0.0.1";
let keySeq = 0;
const nextKey = (): string => `rt1337-hook-key-${String((keySeq += 1)).padStart(8, "0")}`;

function call(method: "get" | "post" | "patch" | "delete", path: string, body?: object): request.Test {
  const agent = request(app!.getHttpServer() as Parameters<typeof request>[0]);
  let req = agent[method](path).set("x-test-session", SES_OWNER_ALL);
  if (method !== "get") req = req.set("Origin", ORIGIN);
  if (method === "post") req = req.set("Idempotency-Key", nextKey());
  return body === undefined ? req : req.send(body);
}

const params = { buyQuantity: 1, getQuantity: 1, percentOff: "40", rewardSelection: "cheapest", maxApplicationsPerSale: null, priceBasis: "resolved_store_price" };
const definition = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  nameAr: "عرض",
  type: "buy_x_get_y_percent",
  parameters: params,
  eligibility: { include: { categoryIds: [CAT_SHOES] } },
  storeScope: { allStores: true },
  schedule: { timeBasis: "store_local", startsAt: "2020-01-01T00:00", endsAt: null },
  ...over,
});

async function create(def: Record<string, unknown>): Promise<string> {
  const created = await call("post", "/api/v1/offers", { definition: def });
  expect(created.status).toBe(201);
  return (created.body as { offerId: string }).offerId;
}

async function publishOk(def: Record<string, unknown>): Promise<{ offerId: string }> {
  const offerId = await create(def);
  const published = await call("post", `/api/v1/offers/${offerId}/publish`, { expectedDraftRevision: 1 });
  expect([published.status, published.body]).toEqual([200, expect.anything()]);
  return { offerId };
}

async function endAll(): Promise<void> {
  const res = await call("get", "/api/v1/offers?page_size=100");
  for (const o of (res.body as { items: Array<{ offerId: string; state: string }> }).items) {
    if (["scheduled", "active", "paused"].includes(o.state)) await call("post", `/api/v1/offers/${o.offerId}/end`, {}).expect(200);
  }
}

const sql = <T = Record<string, any>>(text: string, values: unknown[] = []): Promise<T[]> => env!.admin.query(text, values).then((r) => r.rows as T[]);
const revisionCount = async (): Promise<number> => Number((await sql(`SELECT count(*)::int AS n FROM offer_pack_revisions WHERE tenant_id = $1`, [TENANT_A]))[0]!.n);

async function heldBy(storeId: string): Promise<Map<string, string>> {
  const rows = await sql<{ product_id: string; offer_id: string }>(
    `SELECT product_id::text, offer_id::text FROM offer_pack_eligible_products WHERE tenant_id = $1 AND store_id = $2 AND to_revision IS NULL`,
    [TENANT_A, storeId],
  );
  return new Map(rows.map((x) => [x.product_id, x.offer_id]));
}

async function stamp(table: string, id: string): Promise<string> {
  return (await sql<{ t: string }>(`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t FROM ${table} WHERE id = $1`, [id]))[0]!.t;
}

async function patchProduct(id: string, body: object): Promise<request.Response> {
  return call("patch", `/api/v1/catalog/products/${id}`, { expectedUpdatedAt: await stamp("tenant_products", id), ...body });
}

/** Put the fixture's catalog back after a test that edits it. */
async function resetCatalog(): Promise<void> {
  await sql(`UPDATE tenant_products SET retired_at = NULL, is_active = true WHERE id = ANY($1::uuid[])`, [[P_RUN, P_HAT, P_BARE, P_TRAIN]]);
  await sql(`UPDATE tenant_products SET category_id = CASE id WHEN $1 THEN $3::uuid WHEN $2 THEN $4::uuid ELSE NULL END WHERE id = ANY($5::uuid[])`, [P_HAT, P_BARE, CAT_HATS, null, [P_HAT, P_BARE]]);
}

describe("the Pack follows catalog changes", () => {
  beforeEach(async () => {
    if (skip()) return;
    await endAll();
    await resetCatalog();
  });

  it("moves a product into and out of a live set (category, active, retire) in the same transaction, one revision per change", async () => {
    if (skip()) return;
    const offer = await publishOk(definition());
    expect([...(await heldBy(STORE_A_X)).keys()].sort()).toEqual([P_RUN, P_TRAIN].sort());
    let revisions = await revisionCount();

    // Into the set: the hat joins the Shoes category.
    expect((await patchProduct(P_HAT, { categoryId: CAT_SHOES })).status).toBe(200);
    expect(await revisionCount()).toBe(revisions + 1);
    expect((await heldBy(STORE_A_X)).get(P_HAT)).toBe(offer.offerId);
    expect((await heldBy(STORE_A_Y)).get(P_HAT)).toBe(offer.offerId);
    revisions += 1;

    // Out of the set: inactive; back in; then retired.
    expect((await patchProduct(P_HAT, { isActive: false })).status).toBe(200);
    expect((await heldBy(STORE_A_X)).has(P_HAT)).toBe(false);
    expect(await revisionCount()).toBe(revisions + 1);
    expect((await patchProduct(P_HAT, { isActive: true })).status).toBe(200);
    expect((await heldBy(STORE_A_X)).has(P_HAT)).toBe(true);
    const retired = await call("post", `/api/v1/catalog/products/${P_RUN}/retire`, { expectedUpdatedAt: await stamp("tenant_products", P_RUN) });
    expect([retired.status, retired.body]).toEqual([200, expect.anything()]);
    expect((await heldBy(STORE_A_X)).has(P_RUN)).toBe(false);
    expect((await heldBy(STORE_A_Y)).has(P_RUN)).toBe(false);
  });

  it("issues no revision for an edit no offer rule can see, nor for a change that moves nothing", async () => {
    if (skip()) return;
    await publishOk(definition({ eligibility: { include: { brandIds: [BR_NIKE] } } }));
    const before = await revisionCount();
    expect((await patchProduct(P_BARE, { name: "Bare renamed" })).status).toBe(200);
    expect((await patchProduct(P_RUN, { name: "Run renamed" })).status).toBe(200);
    expect(await revisionCount()).toBe(before);
  });

  it("a new product that matches a live rule joins the Pack at once", async () => {
    if (skip()) return;
    const offer = await publishOk(definition({ eligibility: { include: { brandIds: [BR_ADIDAS] } } }));
    const created = await call("post", "/api/v1/catalog/products", { name: "New adidas", brandId: BR_ADIDAS, taxCategory: "standard" });
    expect(created.status).toBe(201);
    const id = (created.body as { summary: { productId: string } }).summary.productId;
    expect((await heldBy(STORE_A_X)).get(id)).toBe(offer.offerId);
  });
});

describe("the Pack follows the store list", () => {
  beforeEach(async () => {
    if (!skip()) await endAll();
  });

  it("an all-stores offer includes a store created later and drops it when it is deleted; an explicit list never grows", async () => {
    if (skip()) return;
    const all = await publishOk(definition({ nameAr: "كل", eligibility: { include: { productIds: [P_RUN] } } }));
    const explicit = await publishOk(definition({ nameAr: "صريح", storeScope: { storeIds: [STORE_A_X] }, eligibility: { include: { productIds: [P_HAT] } } }));
    const created = await call("post", "/api/v1/stores", { code: "RT1337-NEW", name: "New store" });
    expect(created.status).toBe(201);
    const storeId = (created.body as { id: string }).id;
    expect([...(await heldBy(storeId)).entries()]).toEqual([[P_RUN, all.offerId]]);
    expect((await heldBy(STORE_A_X)).get(P_HAT)).toBe(explicit.offerId);
    expect((await call("delete", `/api/v1/stores/${storeId}`)).status).toBe(204);
    expect((await heldBy(storeId)).size).toBe(0);
  });
});

describe("re-materialisation conflicts (OD-7 clarification)", () => {
  beforeEach(async () => {
    if (skip()) return;
    await endAll();
    await resetCatalog();
  });

  it("the earlier-published offer keeps a product two live offers come to want; the later is reported, the Pack holds it once", async () => {
    if (skip()) return;
    const earlier = await publishOk(definition({ nameAr: "الأقدم", eligibility: { include: { categoryIds: [CAT_SHOES] } } }));
    const later = await publishOk(definition({ nameAr: "الأحدث", eligibility: { include: { productIds: [P_BARE] } } }));
    expect((await heldBy(STORE_A_X)).get(P_BARE)).toBe(later.offerId);
    // The bare product joins the Shoes category: both offers now match it.
    expect((await patchProduct(P_BARE, { categoryId: CAT_SHOES })).status).toBe(200);
    const held = await heldBy(STORE_A_X);
    expect(held.get(P_BARE)).toBe(earlier.offerId);
    const read = await call("get", `/api/v1/offers/${later.offerId}`);
    expect(read.status).toBe(200);
    expect((read.body as { rematerialisationConflicts: unknown[] }).rematerialisationConflicts).toEqual([
      { offerId: earlier.offerId, offerVersion: 1, nameAr: "الأقدم", removedProductCount: 1, removedProductSample: [P_BARE] },
    ]);
    const list = await call("get", "/api/v1/offers?page_size=100");
    const summary = (list.body as { items: Array<{ offerId: string; rematerialisationConflictCount: number }> }).items.find((i) => i.offerId === later.offerId)!;
    expect(summary.rematerialisationConflictCount).toBe(1);
    const mine = await call("get", `/api/v1/offers/${earlier.offerId}`);
    expect((mine.body as { rematerialisationConflicts: unknown[] }).rematerialisationConflicts).toEqual([]);
    // The invariant the till relies on: no product in two offers of one store.
    const dupes = await sql(
      `SELECT product_id FROM offer_pack_eligible_products WHERE tenant_id = $1 AND to_revision IS NULL GROUP BY store_id, product_id HAVING count(*) > 1`,
      [TENANT_A],
    );
    expect(dupes).toEqual([]);
  });
});

describe("concurrent writers", () => {
  beforeEach(async () => {
    if (!skip()) await endAll();
  });

  it("two publishes of conflicting offers at once: one wins, the other is 409 offer_conflict, revisions stay gapless", async () => {
    if (skip()) return;
    const a = await create(definition({ nameAr: "أ", eligibility: { include: { productIds: [P_RUN] } } }));
    const b = await create(definition({ nameAr: "ب", eligibility: { include: { productIds: [P_RUN] } } }));
    const results = await Promise.all([
      call("post", `/api/v1/offers/${a}/publish`, { expectedDraftRevision: 1 }),
      call("post", `/api/v1/offers/${b}/publish`, { expectedDraftRevision: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const lost = results.find((r) => r.status === 409)!;
    expect((lost.body as { error: { code: string } }).error.code).toBe("offer_conflict");
    expect((await heldBy(STORE_A_X)).size).toBe(1);
    const revs = await sql<{ revision: string }>(`SELECT revision::text AS revision FROM offer_pack_revisions r WHERE tenant_id = $1 ORDER BY r.revision`, [TENANT_A]);
    expect(revs.map((r) => Number(r.revision))).toEqual(revs.map((_, i) => i + 1));
  });

  it("many writes at once all land: every pause, publish and end is serialised on the tenant lock", async () => {
    if (skip()) return;
    const ids = await Promise.all([P_RUN, P_TRAIN, P_HAT, P_BARE].map((p, i) => create(definition({ nameAr: `س${i}`, eligibility: { include: { productIds: [p] } } }))));
    const published = await Promise.all(ids.map((id) => call("post", `/api/v1/offers/${id}/publish`, { expectedDraftRevision: 1 })));
    expect(published.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const paused = await Promise.all(ids.slice(0, 2).map((id) => call("post", `/api/v1/offers/${id}/pause`, { reason: "parallel" })));
    expect(paused.map((r) => r.status)).toEqual([200, 200]);
    expect([...(await heldBy(STORE_A_X)).keys()].sort()).toEqual([P_HAT, P_BARE].sort());
    const revs = await sql<{ revision: string }>(`SELECT revision::text AS revision FROM offer_pack_revisions r WHERE tenant_id = $1 ORDER BY r.revision`, [TENANT_A]);
    expect(revs.map((r) => Number(r.revision))).toEqual(revs.map((_, i) => i + 1));
  });
});
