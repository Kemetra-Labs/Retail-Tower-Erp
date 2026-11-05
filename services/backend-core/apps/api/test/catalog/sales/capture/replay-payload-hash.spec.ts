/**
 * replay-payload-hash.spec.ts — RT-1206 (RT-148 owner ruling 2026-10-02,
 * owner confirmation RT-1206 c15587; sales.yaml `captureSale` 200 / `Conflict`).
 *
 * A provenance replay — the same `(tenant, sourceSystem, externalId)` under a
 * NEW Idempotency-Key — is answered by comparing the stored `payload_hash` with
 * the hash of the re-sent sale facts:
 *   - identical hashed body → 200, `Idempotent-Replayed: true`, the stored sale;
 *   - different hashed body → 409 `idempotency_key_conflict`, nothing written,
 *     no second `sale.captured` outbox row, one mismatch audit event;
 *   - another store's provenance → the same answer whatever the body (store
 *     check first, so a replay can never probe another store's hash);
 *   - fields kept out of the hash (`receipt`) never make a replay a conflict.
 * The stored `payload_hash` bytes are the capture's own: unchanged by a replay.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  deleteCapturedSales,
  idempKey,
  SpyAuditEnqueuer,
  STORE_A_Y,
  type HarnessHandle,
} from "./__capture-harness";
import { sha256CanonicalHex } from "../../../../src/catalog/sales/payload-hash";

const spy = new SpyAuditEnqueuer();
const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness({ auditEnqueuer: spy }));
}, 180_000);
afterAll(() => stopCaptureHarness(h), 60_000);
beforeEach(() => {
  resetHarness(h);
  spy.reset();
});
afterEach(() => deleteCapturedSales(h));

/** True when Docker is unavailable and the harness was skipped. */
const skip = (): boolean => h.dockerSkipped || !h.harness;

/** POST a capture with its own Idempotency-Key (a new key per call is a provenance re-delivery). */
function post(body: Record<string, unknown>, key: string) {
  return h.harness!.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(key)).send(body);
}

/** The stored rows for a provenance: sales, lines, `sale.captured` outbox rows and the stored payload_hash. */
async function stored(externalId: string): Promise<{ sales: number; lines: number; captured: number; hash: string | null }> {
  const r = await h.harness!.env.admin.query<{ sales: string; lines: string; captured: string; hash: string | null }>(
    `SELECT (SELECT count(*) FROM sales WHERE external_id = $1)::text AS sales,
            (SELECT count(*) FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE s.external_id = $1)::text AS lines,
            (SELECT count(*) FROM outbox_events e JOIN sales s ON s.id::text = e.payload->>'sale_id'
              WHERE s.external_id = $1)::text AS captured,
            (SELECT payload_hash FROM sales WHERE external_id = $1) AS hash`,
    [externalId],
  );
  const row = r.rows[0]!;
  return { sales: Number(row.sales), lines: Number(row.lines), captured: Number(row.captured), hash: row.hash };
}

/** The RT-1206 replay-mismatch audit events the spy enqueuer received. */
const mismatchEvents = () => spy.calls.filter((c) => c.action === "sale.replay_payload_mismatch_rejected");

describe("RT-1206 — identical provenance replay", () => {
  it("→ 200, the replay marker, the same sale; the stored hash is the capture's own", async () => {
    if (skip()) return;
    const body = captureBody({ externalId: "rt1206-same" });
    const first = await post(body, "r1206same1");
    expect(first.status).toBe(201);
    const again = await post(body, "r1206same2");
    expect(again.status).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(await stored("rt1206-same")).toEqual({ sales: 1, lines: 2, captured: 1, hash: sha256CanonicalHex(body) });
    expect(mismatchEvents()).toEqual([]);
  });
  // A different `receipt` (kept out of the hash) replaying 200 is pinned by
  // sale-history.http.integration.spec.ts (RT-539).
});

describe("RT-1206 — provenance replay with a different body", () => {
  // `tag` keeps the two Idempotency-Keys distinct: idempKey() keeps only the
  // first 32 characters, and a shared key would be answered by the
  // Idempotency-Key layer (its own 409) instead of the provenance compare.
  it.each([
    ["changed lines", "lines", { lines: [{ lineName: "Widget", unitPrice: "12.5000", currencyCode: "USD", quantity: "1", lineAmount: "12.5000", unit: "ea" }] }],
    ["a changed posTotal", "total", { posTotal: "12.5100" }],
    ["a changed occurredAt", "occurred", { occurredAt: "2026-05-01T10:00:01.000Z" }],
  ])("%s → 409 idempotency_key_conflict, one sale, nothing rewritten, one audit event", async (_name, tag, change) => {
    if (skip()) return;
    const ext = `rt1206-diff-${tag}`;
    const body = captureBody({ externalId: ext });
    const first = await post(body, `r1206${tag}1`);
    expect(first.status).toBe(201);
    const before = await stored(ext);
    spy.reset();

    const replay = await post({ ...body, ...change }, `r1206${tag}2`);
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("idempotency_key_conflict");
    expect(replay.headers["idempotent-replayed"]).toBeUndefined();
    // One sale, its lines and its single sale.captured row; the hash unchanged.
    expect(await stored(ext)).toEqual(before);
    expect(before).toMatchObject({ sales: 1, lines: 2, captured: 1 });

    const events = mismatchEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toEqual({ sale_ref: first.body.saleRef });
    // The 409 is not a capture: no sale.captured audit for it.
    expect(spy.calls.filter((c) => c.action === "sale.captured")).toEqual([]);
  });

  it("the original sale still replays 200 after a refused different body", async () => {
    if (skip()) return;
    const body = captureBody({ externalId: "rt1206-after" });
    expect((await post(body, "r1206af1")).status).toBe(201);
    expect((await post({ ...body, posTotal: "99.0000" }, "r1206af2")).status).toBe(409);
    const again = await post(body, "r1206af3");
    expect(again.status).toBe(200);
  });
});

describe("RT-1206 — cross-store provenance", () => {
  // Characterization: the store check runs before the hash compare, so a
  // replay from another store of the tenant answers the same whatever its
  // body, and never reveals the stored hash with a 409. (Pinned as it is on
  // main: the capture mapper has no SaleNotFoundError case, so the answer is
  // the filter's generic error, not a 404; out of RT-1206 scope.)
  it("an identical and a different body from another store get the same answer, never a 409, no mismatch audit", async () => {
    if (skip()) return;
    const body = captureBody({ externalId: "rt1206-xstore" });
    expect((await post(body, "r1206xs1")).status).toBe(201);
    spy.reset();
    h.harness!.contextGuard.storeId = STORE_A_Y;
    const same = await post(body, "r1206xs2");
    const different = await post({ ...body, posTotal: "99.0000" }, "r1206xs3");
    expect(different.status).toBe(same.status);
    expect(different.body.error?.code).toBe(same.body.error?.code);
    expect(different.status).not.toBe(409);
    expect([200, 201]).not.toContain(different.status);
    expect(mismatchEvents()).toEqual([]);
    expect(await stored("rt1206-xstore")).toMatchObject({ sales: 1, captured: 1 });
  });
});
