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


  it("a store_manager pauses only their own stores (200, audited with the stores), never the whole offer, and cannot resume, end or archive", async () => {
    if (skip()) return;
    const offer = await publishOk(definition());
    const id = offer.offerId;
    // A whole-offer pause (no storeIds) is a 403 for a store_manager.
    expect((await post(`/api/v1/offers/${id}/pause`, SES_MANAGER, { reason: "r" })).status).toBe(403);
    // A store outside their scope is the non-disclosing 404 store_not_found, nothing is paused.
    expectError(await post(`/api/v1/offers/${id}/pause`, SES_MANAGER, { reason: "r", storeIds: [STORE_A_Y] }), 404, "store_not_found");
    expectError(await post(`/api/v1/offers/${id}/pause`, SES_MANAGER, { reason: "r", storeIds: [STORE_ABSENT] }), 404, "store_not_found");
    expect((await openRows(STORE_A_X)).length).toBeGreaterThan(0);
    const res = await post(`/api/v1/offers/${id}/pause`, SES_MANAGER, { reason: "shelf label wrong", storeIds: [STORE_A_X] });
    expect(res.status).toBe(200);
    h.conforms("Offer", res.body);
    expect(res.body).toMatchObject({ state: "active", pause: null, pausedStores: [{ storeId: STORE_A_X, reason: "shelf label wrong" }] });
    expect(await openRows(STORE_A_X)).toEqual([]);
    expect((await openRows(STORE_A_Y)).length).toBeGreaterThan(0);
    const audit = await auditRows("offer.paused", id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ reason: "shelf label wrong", store_ids: [STORE_A_X] });
    // Pausing the same store again is a no-op (200, no second audit row).
    expect((await post(`/api/v1/offers/${id}/pause`, SES_MANAGER, { reason: "again", storeIds: [STORE_A_X] })).status).toBe(200);
    expect(await auditRows("offer.paused", id)).toHaveLength(1);
    // A manager cannot resume, even the store they paused; the owner can.
    expect((await post(`/api/v1/offers/${id}/resume`, SES_MANAGER, { storeIds: [STORE_A_X] })).status).toBe(403);
    const resumed = await post(`/api/v1/offers/${id}/resume`, SES_OWNER_ALL, { storeIds: [STORE_A_X] });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ pausedStores: [] });
    expect((await openRows(STORE_A_X)).length).toBeGreaterThan(0);
  });

  it("pauses named stores for an owner, refuses a store outside the offer's scope (422) and a resume of a store that is not paused (422)", async () => {
    if (skip()) return;
    const offer = await publishOk(definition({ storeScope: { storeIds: [STORE_A_X] } }));
    const id = offer.offerId;
    expectError(await post(`/api/v1/offers/${id}/pause`, SES_OWNER_ALL, { reason: "r", storeIds: [STORE_A_Y] }), 422, "offer_store_not_in_scope");
    expect((await post(`/api/v1/offers/${id}/pause`, SES_OWNER_ALL, { reason: "r", storeIds: [STORE_A_X] })).status).toBe(200);
    expectError(await post(`/api/v1/offers/${id}/resume`, SES_OWNER_ALL, { storeIds: [STORE_A_Y] }), 422, "offer_store_not_in_scope");
    expectError(await post(`/api/v1/offers/${id}/resume`, SES_OWNER_ALL, { storeIds: [STORE_ABSENT] }), 404, "store_not_found");
    expect((await post(`/api/v1/offers/${id}/resume`, SES_OWNER_ALL, {})).status).toBe(200);
  });

  it("a resume that would put products back into a store another live offer now holds is refused with 409 offer_conflict (OD-7)", async () => {
    if (skip()) return;
    const first = await publishOk(definition({ nameAr: "الأول" }));
    expect((await post(`/api/v1/offers/${first.offerId}/pause`, SES_OWNER_ALL, { reason: "pause for the second" })).status).toBe(200);
    // A paused offer still counts: the second cannot be published over it.
    const second = await createOffer(definition({ nameAr: "الثاني", eligibility: { include: { productIds: [P_RUN] } } }));
    expectError(await publishOffer(second), 409, "offer_conflict");
    // End the paused offer, publish the second, and the first can no longer be resumed (it is ended).
    await post(`/api/v1/offers/${first.offerId}/end`, SES_OWNER_ALL).expect(200);
    expect((await publishOffer(second)).status).toBe(200);
    expectError(await post(`/api/v1/offers/${first.offerId}/resume`, SES_OWNER_ALL, {}), 409, "offer_state_invalid");
  });

  it("ends an offer (200, leaves the Pack, audited once), a second end is a no-op, an ended offer cannot be edited or published", async () => {
    if (skip()) return;
    const offer = await publishOk(definition());
    const id = offer.offerId;
    const ended = await post(`/api/v1/offers/${id}/end`, SES_OWNER_ALL);
    expect(ended.status).toBe(200);
    h.conforms("Offer", ended.body);
    expect(ended.body).toMatchObject({ state: "ended", endedAt: expect.any(String) });
    expect(await openRows(STORE_A_X)).toEqual([]);
    expect((await post(`/api/v1/offers/${id}/end`, SES_OWNER_ALL)).status).toBe(200);
    expect(await auditRows("offer.ended", id)).toHaveLength(1);
    expectError(await write("put", `/api/v1/offers/${id}/draft`, SES_OWNER_ALL, { expectedDraftRevision: null, definition: definition() }), 409, "offer_state_invalid");
    expectError(await post(`/api/v1/offers/${id}/publish`, SES_OWNER_ALL, { expectedDraftRevision: 2 }), 409, "offer_state_invalid");
    expectError(await post(`/api/v1/offers/${id}/pause`, SES_OWNER_ALL, { reason: "r" }), 409, "offer_state_invalid");
    // Only a draft or an archived offer cannot be ended.
    const draft = await createOffer(definition());
    expectError(await post(`/api/v1/offers/${draft.offerId}/end`, SES_OWNER_ALL), 409, "offer_state_invalid");
  });

  it("archives only an ended offer; archiving twice is a no-op; an archived offer never changes", async () => {
    if (skip()) return;
    const offer = await publishOk(definition());
    const id = offer.offerId;
    expectError(await post(`/api/v1/offers/${id}/archive`, SES_OWNER_ALL), 409, "offer_state_invalid");
    await post(`/api/v1/offers/${id}/end`, SES_OWNER_ALL).expect(200);
    const archived = await post(`/api/v1/offers/${id}/archive`, SES_OWNER_ALL);
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ state: "archived", archivedAt: expect.any(String) });
    expect((await post(`/api/v1/offers/${id}/archive`, SES_OWNER_ALL)).status).toBe(200);
    expect(await auditRows("offer.archived", id)).toHaveLength(1);
    expectError(await post(`/api/v1/offers/${id}/end`, SES_OWNER_ALL), 409, "offer_state_invalid");
    const listed = await get("/api/v1/offers", SES_OWNER_ALL, { state: "archived", page_size: 100 });
    expect((listed.body as { items: Array<{ offerId: string }> }).items.map((o) => o.offerId)).toContain(id);
    // The versions stay readable.
    expect(((await get(`/api/v1/offers/${id}/versions`, SES_OWNER_ALL)).body as { items: unknown[] }).items).toHaveLength(1);
  });

  it("a window that closed by itself reads as ended, and its rows are swept by the next write", async () => {
    if (skip()) return;
    const offer = await createOffer(definition({ schedule: { timeBasis: "absolute", startsAt: "2020-01-01T00:00:00Z", endsAt: new Date(Date.now() + 1500).toISOString() } }));
    expect((await publishOffer(offer)).status).toBe(200);
    expect((await openRows(STORE_A_X)).length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1700));
    expect(((await get(`/api/v1/offers/${offer.offerId}`, SES_OWNER_ALL)).body as OfferBody).state).toBe("ended");
    // A new offer on the same products publishes: the closed window no longer holds them.
    const next = await publishOk(definition({ nameAr: "التالي" }));
    expect(next.state).toBe("active");
    expect(await openRows(STORE_A_X)).toEqual([{ product_id: P_RUN, offer_id: next.offerId, offer_version: 1 }, { product_id: P_TRAIN, offer_id: next.offerId, offer_version: 1 }].sort((a, b) => (a.product_id < b.product_id ? -1 : 1)));
  });
});

describe("what a store_manager sees", () => {
  beforeEach(async () => {
    if (!skip()) await endAll();
  });

  it("answers the same 404 for an offer outside their stores as for no offer at all, on a whole-offer pause too", async () => {
    if (skip()) return;
    const onlyY = await publishOk(definition({ nameAr: "واي فقط", storeScope: { storeIds: [STORE_A_Y] }, eligibility: { include: { productIds: [P_HAT] } } }));
    const missing = "0a000000-0000-7000-8000-00000000d0d0";
    const hidden = await post(`/api/v1/offers/${onlyY.offerId}/pause`, SES_MANAGER, { reason: "r" });
    const absent = await post(`/api/v1/offers/${missing}/pause`, SES_MANAGER, { reason: "r" });
    expect([hidden.status, absent.status]).toEqual([404, 404]);
    expect((hidden.body as { error: { code: string } }).error.code).toBe((absent.body as { error: { code: string } }).error.code);
  });

  it("lists and reads only offers whose scope includes one of their stores, with store lists filtered to those stores", async () => {
    if (skip()) return;
    const both = await publishOk(definition({ nameAr: "الاتنين", storeScope: { storeIds: [STORE_A_X, STORE_A_Y] }, eligibility: { include: { productIds: [P_RUN] } } }));
    const onlyY = await publishOk(definition({ nameAr: "واي", storeScope: { storeIds: [STORE_A_Y] }, eligibility: { include: { productIds: [P_HAT] } } }));
    const everywhere = await publishOk(definition({ nameAr: "كله", eligibility: { include: { productIds: [P_BARE] } } }));
    await post(`/api/v1/offers/${both.offerId}/pause`, SES_OWNER_ALL, { reason: "secret reason", storeIds: [STORE_A_Y] }).expect(200);

    const list = await get("/api/v1/offers", SES_MANAGER, { page_size: 100 });
    expect(list.status).toBe(200);
    h.conforms("OfferPage", list.body);
    const items = (list.body as { items: Array<{ offerId: string; storeScope: Record<string, unknown> }> }).items;
    const byId = new Map(items.map((i) => [i.offerId, i]));
    expect(byId.has(onlyY.offerId)).toBe(false);
    expect(byId.get(both.offerId)!.storeScope).toEqual({ storeIds: [STORE_A_X] });
    expect(byId.get(everywhere.offerId)!.storeScope).toEqual({ allStores: true });
    expectError(await get(`/api/v1/offers/${onlyY.offerId}`, SES_MANAGER), 404, "offer_not_found");
    expectError(await get(`/api/v1/offers/${onlyY.offerId}/versions`, SES_MANAGER), 404, "offer_not_found");
    const read = await get(`/api/v1/offers/${both.offerId}`, SES_MANAGER);
    expect(read.status).toBe(200);
    h.conforms("Offer", read.body);
    const body = read.body as OfferBody;
    expect((body.currentVersion!.definition as { storeScope: unknown }).storeScope).toEqual({ storeIds: [STORE_A_X] });
    // Another store's pause (its id, reason and user) is not returned.
    expect(body.pausedStores).toEqual([]);
    expect(JSON.stringify(read.body)).not.toContain("secret reason");
    expect(JSON.stringify(read.body)).not.toContain(STORE_A_Y);
    // The owner sees all of it.
    const owner = await get(`/api/v1/offers/${both.offerId}`, SES_OWNER_ALL);
    expect((owner.body as OfferBody).pausedStores).toHaveLength(1);
    // The store filter: a store outside the manager's scope is a 404, an own store filters.
    expectError(await get("/api/v1/offers", SES_MANAGER, { store_id: STORE_A_Y }), 404, "store_not_found");
    const filtered = await get("/api/v1/offers", SES_MANAGER, { store_id: STORE_A_X, page_size: 100 });
    expect((filtered.body as { items: Array<{ offerId: string }> }).items.map((i) => i.offerId)).toEqual(expect.arrayContaining([both.offerId, everywhere.offerId]));
  });

  it("lists by state with a keyset walk", async () => {
    if (skip()) return;
    await publishOk(definition({ nameAr: "1", eligibility: { include: { productIds: [P_RUN] } } }));
    await publishOk(definition({ nameAr: "2", eligibility: { include: { productIds: [P_HAT] } } }));
    await createOffer(definition({ nameAr: "3" }));
    const active = await get("/api/v1/offers", SES_OWNER_ALL, { state: "active", page_size: 1 });
    expect(active.status).toBe(200);
    const first = active.body as { items: Array<{ offerId: string; state: string }>; nextCursor: string };
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await get("/api/v1/offers", SES_OWNER_ALL, { state: "active", page_size: 1, cursor: first.nextCursor });
    const secondBody = second.body as { items: Array<{ offerId: string; state: string }> };
    expect(secondBody.items[0]!.offerId).not.toBe(first.items[0]!.offerId);
    expect([first.items[0]!.state, secondBody.items[0]!.state]).toEqual(["active", "active"]);
    expectError(await get("/api/v1/offers", SES_OWNER_ALL, { cursor: Buffer.from(JSON.stringify({ t: TENANT_A })).toString("base64url") }), 400, "validation_error");
    expectError(await get("/api/v1/offers", SES_OWNER_ALL, { state: "nonsense" }), 400, "validation_error");
  });
});

describe("the Offer Pack read (posGetOfferPack)", () => {
  beforeEach(async () => {
    if (!skip()) await endAll();
  });

  it("is 401 without a device token and for a dashboard session; an unknown query key is 400; a malformed If-None-Match is 400", async () => {
    if (skip()) return;
    expect((await h.get("/api/pos/v1/store/offer-pack", null)).status).toBe(401);
    expect((await h.get("/api/pos/v1/store/offer-pack", SES_OWNER_ALL)).status).toBe(401);
    expect((await h.get("/api/pos/v1/store/offer-pack", null, { store_id: STORE_A_Y }).set("Authorization", `Bearer ${TOKEN_X}`)).status).toBe(400);
    expect((await packRead(TOKEN_X, { "If-None-Match": 'W/"abc"' })).status).toBe(400);
  });

  it("is an empty revision-0 Pack before any offer, with trusted-time headers and an ETag that revalidates to 304", async () => {
    if (skip()) return;
    const tenantBefore = await h.env().admin.query(`SELECT count(*)::int AS n FROM offer_pack_store_revisions WHERE store_id = $1`, [STORE_A_X]);
    const res = await packRead(TOKEN_Y).expect(200);
    h.conforms("OfferPack", res.body);
    expect(res.body).toMatchObject({ freshnessWindowHours: 24, storeTimezone: "UTC", currencyCode: "EGP" });
    expect(res.headers["cache-control"]).toBe("no-cache, private");
    expect(res.headers["x-server-time"]).toBe((res.body as { issuedAt: string }).issuedAt);
    expect(res.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
    const again = await packRead(TOKEN_Y, { "If-None-Match": res.headers["etag"] as string });
    expect(again.status).toBe(304);
    expect(again.headers["x-server-time"]).toEqual(expect.any(String));
    expect(again.headers["etag"]).toBe(res.headers["etag"]);
    expect(tenantBefore.rows[0]!.n).toBeGreaterThanOrEqual(0);
  });

  it("carries a published offer's version, parameters, schedule resolved in the store's zone, offline policy and disjoint eligible sets", async () => {
    if (skip()) return;
    const a = await publishOk(
      definition({
        nameAr: "أ",
        eligibility: { include: { categoryIds: [CAT_SHOES] }, exclude: { productIds: [P_TRAIN] } },
        schedule: { timeBasis: "store_local", startsAt: "2090-07-01T00:00", endsAt: "2090-08-01T00:00" },
        offlinePolicy: "online_only",
      }),
    );
    const b = await publishOk(definition({ nameAr: "ب", eligibility: { include: { productIds: [P_HAT] } }, storeScope: { storeIds: [STORE_A_X] } }));
    const x = await packRead(TOKEN_X).expect(200);
    h.conforms("OfferPack", x.body);
    const pack = x.body as { packRevision: number; storeTimezone: string; offers: Array<Record<string, any>> };
    expect(pack.storeTimezone).toBe("Africa/Cairo");
    expect(pack.packRevision).toBeGreaterThan(0);
    const offerA = pack.offers.find((o) => o.offerId === a.offerId)!;
    // Cairo is UTC+3 in summer 2090 (the rule keeps DST): local midnight is 21:00Z the day before.
    expect(offerA).toMatchObject({ offerVersion: 1, nameAr: "أ", offlinePolicy: "online_only", eligibleProductIds: [P_RUN], startsAt: "2090-06-30T21:00:00.000Z", endsAt: "2090-07-31T21:00:00.000Z" });
    expect(offerA.parameters).toMatchObject({ buyQuantity: 1, getQuantity: 1, percentOff: "40", rewardSelection: "cheapest" });
    expect(pack.offers.find((o) => o.offerId === b.offerId)).toMatchObject({ eligibleProductIds: [P_HAT] });
    // The Pack invariant: no product in two offers.
    const all = pack.offers.flatMap((o) => o.eligibleProductIds as string[]);
    expect(new Set(all).size).toBe(all.length);
    // The UTC store (Y) gets a's UTC window and not b (b is X-only).
    const y = (await packRead(TOKEN_Y).expect(200)).body as { offers: Array<Record<string, any>> };
    expect(y.offers.map((o) => o.offerId)).toEqual([a.offerId]);
    expect(y.offers[0]).toMatchObject({ startsAt: "2090-07-01T00:00:00.000Z" });
  });

  it("carries no offers, and no guessed currency, when the store's prices use more than one currency", async () => {
    if (skip()) return;
    await publishOk(definition({ eligibility: { include: { productIds: [P_RUN] } } }));
    expect(((await packRead(TOKEN_X).expect(200)).body as { offers: unknown[] }).offers).toHaveLength(1);
    await h.env().admin.query(`UPDATE tenant_products SET default_currency_code = 'USD' WHERE id = $1`, [P_BARE]);
    try {
      const res = await packRead(TOKEN_X).expect(200);
      h.conforms("OfferPack", res.body);
      expect(res.body).toMatchObject({ offers: [], currencyCode: "XXX" });
    } finally {
      await h.env().admin.query(`UPDATE tenant_products SET default_currency_code = 'EGP' WHERE id = $1`, [P_BARE]);
    }
    expect((await packRead(TOKEN_X).expect(200)).body).toMatchObject({ currencyCode: "EGP" });
  });

  it("answers the non-disclosing 404 (never a 500) when the device's store was deleted", async () => {
    if (skip()) return;
    await h.env().admin.query(`DELETE FROM store_access WHERE store_id = $1`, [STORE_A_Y]).catch(() => undefined);
    await h.env().admin.query(`UPDATE stores SET deleted_at = now() WHERE id = $1`, [STORE_A_Y]);
    try {
      const res = await packRead(TOKEN_Y);
      expect(res.status).toBe(404);
    } finally {
      await h.env().admin.query(`UPDATE stores SET deleted_at = NULL WHERE id = $1`, [STORE_A_Y]);
    }
  });

  it("changes its ETag only when the Pack changes (a pause for another store leaves it), and a tenant never sees another tenant's offers", async () => {
    if (skip()) return;
    const offer = await publishOk(definition({ eligibility: { include: { productIds: [P_RUN] } } }));
    const x1 = await packRead(TOKEN_X).expect(200);
    const y1 = await packRead(TOKEN_Y).expect(200);
    await post(`/api/v1/offers/${offer.offerId}/pause`, SES_OWNER_ALL, { reason: "only Y", storeIds: [STORE_A_Y] }).expect(200);
    const x2 = await packRead(TOKEN_X).expect(200);
    expect(x2.headers["etag"]).toBe(x1.headers["etag"]);
    expect((x2.body as { offers: unknown[] }).offers).toHaveLength(1);
    const y2 = await packRead(TOKEN_Y).expect(200);
    expect(y2.headers["etag"]).not.toBe(y1.headers["etag"]);
    expect((y2.body as { offers: unknown[] }).offers).toEqual([]);
    expect((await packRead(TOKEN_Y, { "If-None-Match": y1.headers["etag"] as string })).status).toBe(200);
    // Tenant B's device sees an empty Pack: tenant A's offers are invisible to it.
    const b = await packRead(TOKEN_B).expect(200);
    expect((b.body as { offers: unknown[]; packRevision: number })).toMatchObject({ offers: [], packRevision: 0 });
    // Tenant B prices nothing: no currency is guessed (ISO 4217 "XXX"), and the Pack still validates.
    h.conforms("OfferPack", b.body);
    expect((b.body as { currencyCode: string }).currencyCode).toBe("XXX");
    // And tenant B's owner cannot read tenant A's offers.
    expectError(await get(`/api/v1/offers/${offer.offerId}`, SES_OWNER_B), 404, "offer_not_found");
    expect(((await get("/api/v1/offers", SES_OWNER_B)).body as { items: unknown[] }).items).toEqual([]);
  });
});
