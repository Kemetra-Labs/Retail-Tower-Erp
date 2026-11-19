/**
 * line-pricing-provenance.spec.ts — RT-1151 (RT-282 PR-07; sales.yaml
 * 1.25.0-draft `CaptureSaleLine.pricingProvenance`, migration 0122), against a
 * real RLS-forced Postgres.
 *
 * Owner D3 (RT-1151 comment 17783): capture persists `pricingProvenance`
 * verbatim whenever a line carries it; lines without it store nothing;
 * existing behaviour is unchanged; a replay with a different provenance is an
 * idempotency conflict. It is never recomputed or checked against the price,
 * so an unknown price event is stored as sent, and it is not echoed in the
 * response.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  type HarnessHandle,
} from "./__capture-harness";

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));
afterEach(async () => {
  await clearProvenance();
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

const EVENT = "0192f000-0000-7000-8000-00000000115a";
const PRICING = { origin: "pricing", sourceScope: "zone", priceEventId: EVENT, priceKind: "regular", pricingRevision: 418 };
const LEGACY = { origin: "legacy", sourceScope: "legacy_store", catalogCursor: "c:1042" };

/** The provenance rows are append-only for every role: clean them up with the triggers off (test only). */
async function clearProvenance(): Promise<void> {
  if (!h.harness) return;
  const client = await h.harness.env.admin.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM sale_line_pricing_provenance");
    await client.query("DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')");
    await client.query("DELETE FROM sales WHERE source_system = 'pos-1'");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function sale(externalId: string, provenances: ReadonlyArray<Record<string, unknown> | undefined>): Record<string, unknown> {
  const base = captureBody({ externalId });
  const lines = (base["lines"] as Array<Record<string, unknown>>).map((line, i) =>
    provenances[i] === undefined ? line : { ...line, pricingProvenance: provenances[i] },
  );
  return { ...base, lines };
}

function post(body: Record<string, unknown>, key: string) {
  return h.harness!.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(key)).send(body);
}

interface Row {
  line_seq: number;
  origin: string;
  source_scope: string;
  price_event_id: string | null;
  price_kind: string | null;
  pricing_revision: string | null;
  catalog_cursor: string | null;
}

async function provenanceOf(externalId: string): Promise<Row[]> {
  const r = await h.harness!.env.admin.query<Row>(
    `SELECT l.line_seq, p.origin, p.source_scope, p.price_event_id::text AS price_event_id, p.price_kind,
            p.pricing_revision::text AS pricing_revision, p.catalog_cursor
       FROM sale_line_pricing_provenance p
       JOIN sale_lines l ON l.id = p.sale_line_id
       JOIN sales s ON s.id = p.sale_id
      WHERE s.external_id = $1
      ORDER BY l.line_seq`,
    [externalId],
  );
  return r.rows;
}

async function salesRecorded(externalId: string): Promise<number> {
  const r = await h.harness!.env.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM sales WHERE external_id = $1`, [externalId]);
  return Number(r.rows[0]!.n);
}

describe("RT-1151 — capture stores the line pricing provenance verbatim", () => {
  it("stores each variant on its line and nothing for a line without one; the response does not echo it", async () => {
    if (skip()) return;
    const res = await post(sale("slp-mixed", [PRICING, undefined]), "slpmixed");
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain("pricingProvenance");
    expect(await provenanceOf("slp-mixed")).toEqual([
      {
        line_seq: 1,
        origin: "pricing",
        source_scope: "zone",
        price_event_id: EVENT,
        price_kind: "regular",
        pricing_revision: "418",
        catalog_cursor: null,
      },
    ]);
  });

  it("maps each provenance to its own line: a provenance on line 2 only is stored on line 2", async () => {
    if (skip()) return;
    const res = await post(sale("slp-second", [undefined, PRICING]), "slpsecond");
    expect(res.status).toBe(201);
    expect((await provenanceOf("slp-second")).map((r) => [r.line_seq, r.origin, r.price_event_id])).toEqual([[2, "pricing", EVENT]]);
  });

  it("stores the legacy variant", async () => {
    if (skip()) return;
    const res = await post(sale("slp-legacy", [LEGACY, LEGACY]), "slplegacy");
    expect(res.status).toBe(201);
    const rows = await provenanceOf("slp-legacy");
    expect(rows.map((r) => [r.line_seq, r.origin, r.source_scope, r.catalog_cursor, r.price_event_id])).toEqual([
      [1, "legacy", "legacy_store", "c:1042", null],
      [2, "legacy", "legacy_store", "c:1042", null],
    ]);
  });

  it("a sale with no provenance stores nothing (unchanged behaviour)", async () => {
    if (skip()) return;
    const res = await post(sale("slp-none", []), "slpnone");
    expect(res.status).toBe(201);
    expect(await provenanceOf("slp-none")).toEqual([]);
  });

  it("an unknown price event is stored as sent: provenance is never checked against the timeline", async () => {
    if (skip()) return;
    const unknown = { ...PRICING, priceEventId: "0192f000-0000-7000-8000-0000000fffff", pricingRevision: 999_999 };
    const res = await post(sale("slp-unknown", [unknown]), "slpunknown");
    expect(res.status).toBe(201);
    expect((await provenanceOf("slp-unknown"))[0]!.pricing_revision).toBe("999999");
  });

  it("a malformed provenance is 400 and nothing is recorded", async () => {
    if (skip()) return;
    const res = await post(sale("slp-bad", [{ ...LEGACY, priceEventId: EVENT }]), "slpbad");
    expect(res.status).toBe(400);
    expect(await salesRecorded("slp-bad")).toBe(0);
  });
});

describe("RT-1151 — idempotency", () => {
  it("the same Idempotency-Key with a changed provenance is 409 idempotency_key_conflict", async () => {
    if (skip()) return;
    const first = await post(sale("slp-idem", [PRICING]), "slpidem");
    expect(first.status).toBe(201);
    const second = await post(sale("slp-idem", [{ ...PRICING, pricingRevision: 419 }]), "slpidem");
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("idempotency_key_conflict");
    expect(await salesRecorded("slp-idem")).toBe(1);
    expect((await provenanceOf("slp-idem"))[0]!.pricing_revision).toBe("418");
  });

  it("a provenance replay under another key with a changed provenance is 409, the stored facts unchanged", async () => {
    if (skip()) return;
    const first = await post(sale("slp-prov", [PRICING]), "slpprov1");
    expect(first.status).toBe(201);
    const replay = await post(sale("slp-prov", [LEGACY]), "slpprov2");
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("idempotency_key_conflict");
    expect((await provenanceOf("slp-prov")).map((r) => r.origin)).toEqual(["pricing"]);
  });

  it("an identical replay under another key is 200 and stores nothing twice", async () => {
    if (skip()) return;
    const first = await post(sale("slp-same", [PRICING]), "slpsame1");
    expect(first.status).toBe(201);
    const replay = await post(sale("slp-same", [PRICING]), "slpsame2");
    expect(replay.status).toBe(200);
    expect(await provenanceOf("slp-same")).toHaveLength(1);
  });
});
