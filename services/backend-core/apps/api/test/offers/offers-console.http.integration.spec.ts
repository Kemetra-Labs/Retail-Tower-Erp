/**
 * RT-1337 (RT-286 S4) — the Offer Engine Console routes and the Pack read over
 * HTTP against real Postgres (every migration incl. 0100/0101, the NOBYPASSRLS
 * `app_test` pool), the real module graph (`SessionOnlyAdminGuard`'s Origin
 * check aside, which the harness stands in for with a header session) and the
 * real `IdempotencyInterceptor` over a fake Redis.
 *
 * Contract: `offers.openapi.yaml`. Docker policy: HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (run here on a native Postgres 16, see the PR).
 */
import "reflect-metadata";

import type request from "supertest";

import { OffersModule } from "../../src/offers/offers.module";
import { idempotencyProviders } from "../_helpers/idempotency-providers";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import {
  BR_ADIDAS,
  BR_B,
  BR_NIKE,
  CAT_B,
  CAT_HATS,
  CAT_SHOES,
  CAT_SOCKS,
  P_BARE,
  P_B,
  P_HAT,
  P_OFF,
  P_OLD,
  P_RUN,
  P_SOCK,
  P_TRAIN,
  SES_ADMIN_ALL,
  SES_MANAGER,
  SES_OWNER_ALL,
  SES_OWNER_B,
  SES_STAFF,
  STORE_A_X,
  STORE_A_Y,
  STORE_ABSENT,
  TENANT_A,
  TOKEN_B,
  TOKEN_X,
  TOKEN_Y,
  seedOffersFixture,
} from "./__support__/offers-fixture";

const h = scopedHttpHarness({
  label: "RT-1337 offers",
  contractId: "offers.openapi",
  module: OffersModule,
  seed: seedOffersFixture,
  providers: idempotencyProviders(),
});
const skip = (): boolean => h.skipped();

let keySeq = 0;
const nextKey = (): string => `rt1337-offer-key-${String((keySeq += 1)).padStart(8, "0")}`;
const ORIGIN = "http://127.0.0.1";

function write(method: "post" | "put", path: string, session: string | null, body: object, key: string | null = nextKey()): request.Test {
  const req = (method === "post" ? h.post(path, session, body) : h.put(path, session, body)).set("Origin", ORIGIN);
  return key === null ? req : req.set("Idempotency-Key", key);
}
const post = (path: string, session: string | null, body: object = {}, key: string | null = nextKey()): request.Test =>
  write("post", path, session, body, key);
const get = (path: string, session: string | null, query: Record<string, string | number> = {}): request.Test => h.get(path, session, query);
const packRead = (token: string, headers: Record<string, string> = {}): request.Test => {
  let req = h.get("/api/pos/v1/store/offer-pack", null).set("Authorization", `Bearer ${token}`);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req;
};

function expectError(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  h.conforms("OfferError", res.body);
}

const params = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  buyQuantity: 1,
  getQuantity: 1,
  percentOff: "40",
  rewardSelection: "cheapest",
  maxApplicationsPerSale: null,
  priceBasis: "resolved_store_price",
  ...over,
});

/** An open-ended offer from 2020 (so it is `active` now) over the given rules and scope. */
const definition = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  nameAr: "القطعة التانية بخصم 40%",
  nameEn: "Second item 40% off",
  type: "buy_x_get_y_percent",
  parameters: params(),
  eligibility: { include: { categoryIds: [CAT_SHOES] } },
  storeScope: { allStores: true },
  schedule: { timeBasis: "store_local", startsAt: "2020-01-01T00:00", endsAt: null },
  offlinePolicy: "allow_cached",
  ...over,
});

interface OfferBody {
  offerId: string;
  state: string;
  draft: { draftRevision: number; definition: Record<string, unknown> } | null;
  currentVersion: { version: number; eligibleSetCount: number; definition: Record<string, unknown> } | null;
  pause: unknown;
  pausedStores: Array<{ storeId: string }>;
  rematerialisationConflicts: unknown[];
}

async function createOffer(def: Record<string, unknown>, session = SES_OWNER_ALL): Promise<OfferBody> {
  const res = await post("/api/v1/offers", session, { definition: def });
  expect([res.status, res.body]).toEqual([201, expect.anything()]);
  h.conforms("Offer", res.body);
  return res.body as OfferBody;
}

async function publishOffer(offer: OfferBody, session = SES_OWNER_ALL): Promise<request.Response> {
  return post(`/api/v1/offers/${offer.offerId}/publish`, session, { expectedDraftRevision: offer.draft!.draftRevision });
}

async function publishOk(def: Record<string, unknown>): Promise<OfferBody> {
  const offer = await createOffer(def);
  const res = await publishOffer(offer);
  expect([res.status, res.body]).toEqual([200, expect.anything()]);
  h.conforms("Offer", res.body);
  return res.body as OfferBody;
}

/** Ends every offer of tenant A so each test starts with an empty Pack (rows are closed, history is kept). */
async function endAll(): Promise<void> {
  const res = await get("/api/v1/offers", SES_OWNER_ALL, { page_size: 100 });
  for (const o of (res.body as { items: Array<{ offerId: string; state: string }> }).items) {
    if (["scheduled", "active", "paused"].includes(o.state)) await post(`/api/v1/offers/${o.offerId}/end`, SES_OWNER_ALL).expect(200);
  }
}

async function auditRows(action: string, offerId: string): Promise<Array<Record<string, any>>> {
  const r = await h.env().admin.query(`SELECT * FROM audit_events WHERE action = $1 AND target_id = $2`, [action, offerId]);
  return r.rows;
}

async function openRows(storeId: string): Promise<Array<{ product_id: string; offer_id: string; offer_version: number }>> {
  const r = await h.env().admin.query(
    `SELECT product_id::text, offer_id::text, offer_version FROM offer_pack_eligible_products
      WHERE tenant_id = $1 AND store_id = $2 AND to_revision IS NULL ORDER BY product_id`,
    [TENANT_A, storeId],
  );
  return r.rows;
}

describe("authz", () => {
  it("is 401 without a session, 403 for store_staff everywhere, and 403 for a store_manager on every manage operation", async () => {
    if (skip()) return;
    const offer = await createOffer(definition());
    const id = offer.offerId;
    expect((await get("/api/v1/offers", null)).status).toBe(401);
    expect((await post("/api/v1/offers", null, { definition: definition() })).status).toBe(401);
    const all = [
      () => get("/api/v1/offers", SES_STAFF),
      () => get(`/api/v1/offers/${id}`, SES_STAFF),
      () => post("/api/v1/offers", SES_STAFF, { definition: definition() }),
      () => post(`/api/v1/offers/${id}/pause`, SES_STAFF, { reason: "x" }),
    ];
    for (const call of all) {
      const res = await call();
      expect(res.status).toBe(403);
      expect((res.body as { error: { code: string } }).error.code).toBe("forbidden");
    }
    const manage = [
      () => post("/api/v1/offers", SES_MANAGER, { definition: definition() }),
      () => write("put", `/api/v1/offers/${id}/draft`, SES_MANAGER, { expectedDraftRevision: 1, definition: definition() }),
      () => post(`/api/v1/offers/${id}/preview`, SES_MANAGER, {}),
      () => post(`/api/v1/offers/${id}/publish`, SES_MANAGER, { expectedDraftRevision: 1 }),
      () => post(`/api/v1/offers/${id}/resume`, SES_MANAGER, {}),
      () => post(`/api/v1/offers/${id}/end`, SES_MANAGER),
      () => post(`/api/v1/offers/${id}/archive`, SES_MANAGER),
    ];
    for (const call of manage) {
      const res = await call();
      expect([res.status, (res.body as { error: { code: string } }).error.code]).toEqual([403, "forbidden"]);
    }
  });

  it("answers a cookie write without a trusted Origin with 403 origin_rejected", async () => {
    if (skip()) return;
    // No session header: the real guard runs, and the cookie POST has no trusted Origin (RT-430).
    const cookie = "dp2_session=rt1337-not-a-session";
    const none = await h.post("/api/v1/offers", null, { definition: definition() }).set("Cookie", cookie).set("Idempotency-Key", nextKey());
    expect([none.status, (none.body as { error: { code: string } }).error.code]).toEqual([403, "origin_rejected"]);
    const foreign = await h.post("/api/v1/offers", null, { definition: definition() }).set("Cookie", cookie).set("Origin", "https://evil.example").set("Idempotency-Key", nextKey());
    expect([foreign.status, (foreign.body as { error: { code: string } }).error.code]).toEqual([403, "origin_rejected"]);
    const bearer = await h.post("/api/v1/offers", null, { definition: definition() }).set("Authorization", "Bearer not-a-real-token").set("Idempotency-Key", nextKey());
    expect(bearer.status).toBe(401);
  });

  it("requires an Idempotency-Key on every write", async () => {
    if (skip()) return;
    const res = await post("/api/v1/offers", SES_OWNER_ALL, { definition: definition() }, null);
    expect([res.status, (res.body as { error: { code: string } }).error.code]).toEqual([400, "idempotency_key_required"]);
  });
});

describe("create and edit a draft", () => {
  it("creates an offer with its first draft, replays a same-key retry and refuses a different body on that key", async () => {
    if (skip()) return;
    const key = nextKey();
    const first = await post("/api/v1/offers", SES_OWNER_ALL, { definition: definition() }, key);
    expect(first.status).toBe(201);
    h.conforms("Offer", first.body);
    expect(first.body).toMatchObject({ state: "draft", currentVersion: null, pause: null, pausedStores: [], draft: { draftRevision: 1 } });
    const replay = await post("/api/v1/offers", SES_OWNER_ALL, { definition: definition() }, key);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    expectError(await post("/api/v1/offers", SES_OWNER_ALL, { definition: definition({ nameAr: "مختلف" }) }, key), 409, "idempotency_key_conflict");
    const rows = await auditRows("offer.draft_created", (first.body as OfferBody).offerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: expect.any(String), tenant_id: TENANT_A, target_type: "offer" });
  });

  it("tenant_admin can create too, and the offer is listed newest first", async () => {
    if (skip()) return;
    const a = await createOffer(definition({ nameAr: "A" }), SES_ADMIN_ALL);
    const b = await createOffer(definition({ nameAr: "B" }));
    const list = await get("/api/v1/offers", SES_OWNER_ALL, { page_size: 100 });
    expect(list.status).toBe(200);
    h.conforms("OfferPage", list.body);
    const ids = (list.body as { items: Array<{ offerId: string }> }).items.map((i) => i.offerId);
    expect(ids.indexOf(b.offerId)).toBeLessThan(ids.indexOf(a.offerId));
  });

  it.each([
    ["an include that names nothing", { eligibility: { include: {} } }],
    ["an unknown key", { surprise: true }],
    ["endsAt not after startsAt", { schedule: { timeBasis: "store_local", startsAt: "2026-12-02T00:00", endsAt: "2026-12-01T00:00" } }],
    ["a store_local time with an offset", { schedule: { timeBasis: "store_local", startsAt: "2026-12-01T00:00:00Z", endsAt: null } }],
    ["an absolute time without an offset", { schedule: { timeBasis: "absolute", startsAt: "2026-12-01T00:00", endsAt: null } }],
    ["a percent of 0", { parameters: params({ percentOff: "0" }) }],
    ["a percent above 100", { parameters: params({ percentOff: "101" }) }],
    ["a quantity of 0", { parameters: params({ buyQuantity: 0 }) }],
    ["an unsupported type", { type: "bundle_price" }],
    ["an empty store list", { storeScope: { storeIds: [] } }],
    ["a repeated id", { eligibility: { include: { productIds: [P_RUN, P_RUN] } } }],
    ["a name over 120 characters", { nameAr: "ا".repeat(121) }],
  ])("refuses %s with 400 before any write", async (_label, over) => {
    if (skip()) return;
    const before = await h.env().admin.query(`SELECT count(*)::int AS n FROM offers`);
    const res = await post("/api/v1/offers", SES_OWNER_ALL, { definition: definition(over) });
    expectError(res, 400, "validation_error");
    expect((await h.env().admin.query(`SELECT count(*)::int AS n FROM offers`)).rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("accepts a draft that names references that do not exist yet (preview and publish report them)", async () => {
    if (skip()) return;
    const offer = await createOffer(definition({ eligibility: { include: { brandIds: [BR_B] } }, storeScope: { storeIds: [STORE_ABSENT] } }));
    expect(offer.state).toBe("draft");
  });

  it("edits the draft under optimistic concurrency and never reuses a revision", async () => {
    if (skip()) return;
    const offer = await createOffer(definition());
    const id = offer.offerId;
    const edit = await write("put", `/api/v1/offers/${id}/draft`, SES_OWNER_ALL, { expectedDraftRevision: 1, definition: definition({ nameAr: "نسخة 2" }) });
    expect(edit.status).toBe(200);
    h.conforms("Offer", edit.body);
    expect((edit.body as OfferBody).draft).toMatchObject({ draftRevision: 2, definition: { nameAr: "نسخة 2" } });
    const stale = await write("put", `/api/v1/offers/${id}/draft`, SES_OWNER_ALL, { expectedDraftRevision: 1, definition: definition() });
    expectError(stale, 409, "offer_draft_changed_concurrently");
    expect(((await get(`/api/v1/offers/${id}`, SES_OWNER_ALL)).body as OfferBody).draft?.draftRevision).toBe(2);
    expect(await auditRows("offer.draft_updated", id)).toHaveLength(1);
    // null is only for an offer with no draft.
    expectError(await write("put", `/api/v1/offers/${id}/draft`, SES_OWNER_ALL, { expectedDraftRevision: null, definition: definition() }), 409, "offer_draft_changed_concurrently");
  });

  it("is a non-disclosing 404 for an offer of another tenant or one that never existed, and 400 for a malformed id", async () => {
    if (skip()) return;
    const offer = await createOffer(definition());
    for (const call of [
      () => get(`/api/v1/offers/${offer.offerId}`, SES_OWNER_B),
      () => get("/api/v1/offers/0a000000-0000-7000-8000-00001337ffff", SES_OWNER_ALL),
      () => post(`/api/v1/offers/${offer.offerId}/preview`, SES_OWNER_B, {}),
      () => post(`/api/v1/offers/${offer.offerId}/end`, SES_OWNER_B),
    ]) {
      expectError(await call(), 404, "offer_not_found");
    }
    expectError(await get("/api/v1/offers/not-a-uuid", SES_OWNER_ALL), 400, "validation_error");
  });
});

describe("preview", () => {
  it("resolves include and exclude with exclusion winning, retired and inactive products never eligible", async () => {
    if (skip()) return;
    const offer = await createOffer(
      definition({
        eligibility: { include: { categoryIds: [CAT_SHOES, CAT_SOCKS], brandIds: [BR_NIKE] }, exclude: { productIds: [P_TRAIN], categoryIds: [CAT_SOCKS] } },
      }),
    );
    const res = await post(`/api/v1/offers/${offer.offerId}/preview`, SES_OWNER_ALL, {});
    expect(res.status).toBe(200);
    h.conforms("OfferPreview", res.body);
    const body = res.body as { eligibleSet: { count: number; sample: Array<{ productId: string }> }; issues: unknown[]; conflicts: unknown[]; publishable: boolean };
    // SHOES: RUN, TRAIN(excluded), OLD(retired), OFF(inactive); SOCKS excluded; NIKE: RUN, SOCK(excluded by category).
    expect(body.eligibleSet.sample.map((p) => p.productId)).toEqual([P_RUN]);
    expect(body).toMatchObject({ eligibleSet: { count: 1 }, issues: [], conflicts: [], publishable: true });
  });

  it("reports every issue a publish would refuse for, and changes nothing", async () => {
    if (skip()) return;
    const offer = await createOffer(
      definition({
        eligibility: { include: { productIds: [P_B], brandIds: [BR_B] } },
        storeScope: { storeIds: [STORE_ABSENT] },
        schedule: { timeBasis: "absolute", startsAt: "2020-01-01T00:00:00Z", endsAt: "2020-02-01T00:00:00Z" },
      }),
    );
    const before = await h.env().admin.query(`SELECT count(*)::int AS n FROM offer_pack_revisions`);
    const res = await post(`/api/v1/offers/${offer.offerId}/preview`, SES_OWNER_ALL, {});
    expect(res.status).toBe(200);
    h.conforms("OfferPreview", res.body);
    const issues = (res.body as { issues: Array<{ code: string; field: string }> }).issues;
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(["offer_reference_invalid", "offer_eligible_set_empty"]));
    expect(issues.filter((i) => i.code === "offer_reference_invalid").map((i) => i.field).sort()).toEqual([
      "/eligibility/include/brandIds/0",
      "/eligibility/include/productIds/0",
      "/storeScope/storeIds/0",
    ]);
    expect((res.body as { publishable: boolean }).publishable).toBe(false);
    expect((await h.env().admin.query(`SELECT count(*)::int AS n FROM offer_pack_revisions`)).rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("reports an elapsed schedule", async () => {
    if (skip()) return;
    const offer = await createOffer(definition({ schedule: { timeBasis: "absolute", startsAt: "2020-01-01T00:00:00Z", endsAt: "2020-02-01T00:00:00Z" } }));
    const res = await post(`/api/v1/offers/${offer.offerId}/preview`, SES_OWNER_ALL, {});
    expect((res.body as { issues: Array<{ code: string }> }).issues.map((i) => i.code)).toContain("offer_schedule_elapsed");
  });

  it("simulates a cart with the draft's parameters (spec 048 E2: the discount goes to the cheapest units of the basket)", async () => {
    if (skip()) return;
    const offer = await createOffer(definition());
    const res = await post(`/api/v1/offers/${offer.offerId}/preview`, SES_OWNER_ALL, {
      simulation: { currencyCode: "EGP", lines: [{ unitPrice: "100.00" }, { unitPrice: "80.00" }, { unitPrice: "60.00" }, { unitPrice: "40.00" }, { unitPrice: "5.00", productId: P_HAT }] },
    });
    expect(res.status).toBe(200);
    h.conforms("OfferPreview", res.body);
    const sim = (res.body as { simulation: { applications: number; totalDiscount: string; total: string; lines: Array<{ lineIndex: number; eligible: boolean; discountAmount: string }> } }).simulation;
    // The hat is not eligible (category Hats): four eligible units, k = 2, rewards 60 and 40.
    expect(sim).toMatchObject({ applications: 2, totalDiscount: "40.00", total: "245.00" });
    expect(sim.lines.filter((l) => l.discountAmount !== "0.00").map((l) => l.lineIndex)).toEqual([2, 3]);
    expect(sim.lines.find((l) => l.lineIndex === 4)).toMatchObject({ eligible: false });
    // A price with more digits than the minor unit is a 400.
    expectError(await post(`/api/v1/offers/${offer.offerId}/preview`, SES_OWNER_ALL, { simulation: { currencyCode: "EGP", lines: [{ unitPrice: "1.005" }] } }), 400, "validation_error");
  });

  it("is 409 offer_draft_changed_concurrently for a stale revision and 409 offer_state_invalid with no draft", async () => {
    if (skip()) return;
    const offer = await createOffer(definition());
    expectError(await post(`/api/v1/offers/${offer.offerId}/preview`, SES_OWNER_ALL, { expectedDraftRevision: 7 }), 409, "offer_draft_changed_concurrently");
    const published = await publishOffer(offer);
    expect(published.status).toBe(200);
    expectError(await post(`/api/v1/offers/${offer.offerId}/preview`, SES_OWNER_ALL, {}), 409, "offer_state_invalid");
    await endAll();
  });
});

describe("publish", () => {
  beforeEach(async () => {
    if (!skip()) await endAll();
  });

  it("publishes version 1, consumes the draft, materialises the eligible set into a new Pack revision and audits it", async () => {
    if (skip()) return;
    const offer = await createOffer(definition({ eligibility: { include: { categoryIds: [CAT_SHOES] }, exclude: { productIds: [P_TRAIN] } } }));
    const res = await publishOffer(offer);
    expect(res.status).toBe(200);
    h.conforms("Offer", res.body);
    expect(res.body).toMatchObject({ state: "active", draft: null, currentVersion: { version: 1, eligibleSetCount: 1 } });
    const rows = await openRows(STORE_A_X);
    expect(rows).toEqual([{ product_id: P_RUN, offer_id: offer.offerId, offer_version: 1 }]);
    expect(await openRows(STORE_A_Y)).toEqual([{ product_id: P_RUN, offer_id: offer.offerId, offer_version: 1 }]);
    const audit = await auditRows("offer.published", offer.offerId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ version: 1, eligible_set_count: 1, pack_revision: expect.any(Number) });
    // The draft revision counter is never reused: the next draft is revision 2.
    const next = await write("put", `/api/v1/offers/${offer.offerId}/draft`, SES_OWNER_ALL, { expectedDraftRevision: null, definition: definition({ nameAr: "v2" }) });
    expect((next.body as OfferBody).draft?.draftRevision).toBe(2);
  });

  it("a second publish is a new immutable version whose eligible set replaces the first (the versions list is newest first)", async () => {
    if (skip()) return;
    const offer = await createOffer(definition());
    await publishOffer(offer).then((r) => expect(r.status).toBe(200));
    const edit = await write("put", `/api/v1/offers/${offer.offerId}/draft`, SES_OWNER_ALL, {
      expectedDraftRevision: null,
      definition: definition({ eligibility: { include: { categoryIds: [CAT_SHOES] }, exclude: { brandIds: [BR_ADIDAS] } } }),
    });
    const second = await post(`/api/v1/offers/${offer.offerId}/publish`, SES_OWNER_ALL, { expectedDraftRevision: (edit.body as OfferBody).draft!.draftRevision });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ currentVersion: { version: 2 } });
    expect(await openRows(STORE_A_X)).toEqual([{ product_id: P_RUN, offer_id: offer.offerId, offer_version: 2 }]);
    const versions = await get(`/api/v1/offers/${offer.offerId}/versions`, SES_OWNER_ALL);
    expect(versions.status).toBe(200);
    h.conforms("OfferVersionPage", versions.body);
    expect((versions.body as { items: Array<{ version: number }> }).items.map((v) => v.version)).toEqual([2, 1]);
    const page1 = await get(`/api/v1/offers/${offer.offerId}/versions`, SES_OWNER_ALL, { page_size: 1 });
    const cursor = (page1.body as { nextCursor: string }).nextCursor;
    expect(cursor).toEqual(expect.any(String));
    const page2 = await get(`/api/v1/offers/${offer.offerId}/versions`, SES_OWNER_ALL, { page_size: 1, cursor });
    expect((page2.body as { items: Array<{ version: number }>; nextCursor: null }).items.map((v) => v.version)).toEqual([1]);
    expect((page2.body as { nextCursor: null }).nextCursor).toBeNull();
    expectError(await get(`/api/v1/offers/${offer.offerId}/versions`, SES_OWNER_ALL, { cursor: "bogus" }), 400, "validation_error");
  });

  it.each([
    ["offer_reference_invalid", { eligibility: { include: { categoryIds: [CAT_B] } } }],
    ["offer_eligible_set_empty", { eligibility: { include: { categoryIds: [CAT_HATS] }, exclude: { categoryIds: [CAT_HATS] } } }],
    ["offer_schedule_elapsed", { schedule: { timeBasis: "absolute", startsAt: "2020-01-01T00:00:00Z", endsAt: "2020-02-01T00:00:00Z" } }],
  ])("refuses with 422 %s and writes nothing", async (code, over) => {
    if (skip()) return;
    const offer = await createOffer(definition(over));
    const before = await h.env().admin.query(`SELECT count(*)::int AS n FROM offer_versions`);
    expectError(await publishOffer(offer), 422, code);
    expect((await h.env().admin.query(`SELECT count(*)::int AS n FROM offer_versions`)).rows[0]!.n).toBe(before.rows[0]!.n);
    expect(await auditRows("offer.published", offer.offerId)).toHaveLength(0);
  });

  it("is 409 offer_draft_changed_concurrently for a stale revision and for no draft", async () => {
    if (skip()) return;
    const offer = await createOffer(definition());
    expectError(await post(`/api/v1/offers/${offer.offerId}/publish`, SES_OWNER_ALL, { expectedDraftRevision: 9 }), 409, "offer_draft_changed_concurrently");
    await publishOffer(offer).then((r) => expect(r.status).toBe(200));
    expectError(await post(`/api/v1/offers/${offer.offerId}/publish`, SES_OWNER_ALL, { expectedDraftRevision: 1 }), 409, "offer_draft_changed_concurrently");
  });

  it("refuses a conflicting offer with 409 offer_conflict listing the other offer and the shared products (OD-7), even with disjoint windows", async () => {
    if (skip()) return;
    const first = await publishOk(definition({ nameAr: "الأول", eligibility: { include: { categoryIds: [CAT_SHOES] } } }));
    const second = await createOffer(
      definition({
        nameAr: "الثاني",
        eligibility: { include: { brandIds: [BR_NIKE] } },
        schedule: { timeBasis: "absolute", startsAt: "2090-01-01T00:00:00Z", endsAt: "2090-02-01T00:00:00Z" },
      }),
    );
    const res = await publishOffer(second);
    expectError(res, 409, "offer_conflict");
    const conflicts = (res.body as { error: { conflicts: Array<Record<string, unknown>> } }).error.conflicts;
    expect(conflicts).toEqual([
      { offerId: first.offerId, offerVersion: 1, nameAr: "الأول", state: "active", sharedProductCount: 1, sharedProductSample: [P_RUN] },
    ]);
    // A different store scope removes the overlap.
    const other = await createOffer(definition({ eligibility: { include: { brandIds: [BR_NIKE] } }, storeScope: { storeIds: [STORE_A_Y] } }));
    expect((await publishOffer(other)).status).toBe(409);
    const split = await publishOk(definition({ storeScope: { storeIds: [STORE_A_X] }, eligibility: { include: { categoryIds: [CAT_HATS] } } }));
    expect(split.state).toBe("active");
  });

  it("publishing a new version of an offer does not conflict with the offer's own earlier version", async () => {
    if (skip()) return;
    const offer = await publishOk(definition());
    const edit = await write("put", `/api/v1/offers/${offer.offerId}/draft`, SES_OWNER_ALL, { expectedDraftRevision: null, definition: definition({ nameAr: "نفس العرض" }) });
    const res = await post(`/api/v1/offers/${offer.offerId}/publish`, SES_OWNER_ALL, { expectedDraftRevision: (edit.body as OfferBody).draft!.draftRevision });
    expect(res.status).toBe(200);
  });

  it("a future offer is scheduled, and holds its products against a later offer", async () => {
    if (skip()) return;
    const future = await publishOk(definition({ schedule: { timeBasis: "absolute", startsAt: "2090-01-01T00:00:00Z", endsAt: null } }));
    expect(future.state).toBe("scheduled");
    const clash = await createOffer(definition({ eligibility: { include: { productIds: [P_RUN] } } }));
    expectError(await publishOffer(clash), 409, "offer_conflict");
  });
});

describe("lifecycle: pause, resume, end, archive", () => {
  beforeEach(async () => {
    if (!skip()) await endAll();
  });

  it("pauses the whole offer with a reason (owner / tenant_admin), leaves the Pack, and resumes", async () => {
    if (skip()) return;
    const offer = await publishOk(definition());
    expect((await openRows(STORE_A_X)).length).toBeGreaterThan(0);
    expectError(await post(`/api/v1/offers/${offer.offerId}/pause`, SES_OWNER_ALL, {}), 400, "validation_error");
    const paused = await post(`/api/v1/offers/${offer.offerId}/pause`, SES_ADMIN_ALL, { reason: "wrong price" });
    expect(paused.status).toBe(200);
    h.conforms("Offer", paused.body);
    expect(paused.body).toMatchObject({ state: "paused", pause: { reason: "wrong price" } });
    expect(await openRows(STORE_A_X)).toEqual([]);
    expect(await openRows(STORE_A_Y)).toEqual([]);
    const audit = await auditRows("offer.paused", offer.offerId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ reason: "wrong price", store_ids: null });
    // Pausing what is already paused: 200, no change, no second audit row.
    const again = await post(`/api/v1/offers/${offer.offerId}/pause`, SES_OWNER_ALL, { reason: "again" });
    expect(again.status).toBe(200);
    expect(await auditRows("offer.paused", offer.offerId)).toHaveLength(1);
    const resumed = await post(`/api/v1/offers/${offer.offerId}/resume`, SES_OWNER_ALL, {});
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ state: "active", pause: null, pausedStores: [] });
    expect((await openRows(STORE_A_X)).length).toBeGreaterThan(0);
    expect(await auditRows("offer.resumed", offer.offerId)).toHaveLength(1);
    expectError(await post(`/api/v1/offers/${offer.offerId}/resume`, SES_OWNER_ALL, {}), 409, "offer_state_invalid");
  });

});
