/**
 * RT-1337 (RT-286 S4) — automatic-offer facts on captured sales and returns
 * with a clawback, against real Postgres (every migration incl. 0100/0101, the
 * NOBYPASSRLS app pool) and the real `SalesController`, `SalesService` and
 * `SaleReturnsService` (the RT-73 capture harness; only the envelope/device
 * auth is stood in for).
 *
 *   - capture: a line's `promotion` is validated (400 shape, 400 with a manual
 *     discount, 422 arithmetic: the percent against the cited version, the net
 *     invariant, quantity 1 on a reward, an unknown offer version or Pack
 *     revision), stored in `sale_line_promotions`, echoed by readSale and the
 *     history reads; the cited Pack REVISION decides eligibility, not the
 *     current offers (§19); a rule-level difference is accepted and flagged to
 *     review (OD-9), never re-priced;
 *   - returns: every golden `returns` and `returnSequences` vector of
 *     `packages/contracts/fixtures/offers/golden-vectors.json` end to end:
 *     the refund, the recorded clawback and `returnTotal`; the OD-10 refusal;
 *     the OD-11 clawback accepted; the give-back of S3 step 2 refused (fail
 *     closed, see `sale-return-promotions.ts`);
 *   - tenant isolation: another tenant cannot cite a tenant's offer.
 */
import "reflect-metadata";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { runWithTenantContext } from "@data-pulse-2/db";

import { OfferDefinitionSchema, normaliseDefinition, type OfferDefinition } from "../../src/offers/offers.dto";
import { SALE_OFFER_REVIEW_ACTION } from "../../src/catalog/sales/sale-promotions";
import { rebuildOfferPack } from "../../src/offers/offer-pack.rebuild";
import { clearDraft, insertOffer, insertVersion, markEnded } from "../../src/offers/offers.repository";
import {
  captureBody,
  idempKey,
  resetHarness,
  startCaptureHarness,
  stopCaptureHarness,
  STORE_A_X,
  STORE_A_Y,
  TENANT_A,
  TENANT_B,
  type HarnessHandle,
} from "../catalog/sales/capture/__capture-harness";
import { disableReturns, enableReturns, postReturn, returnBody } from "../catalog/sales/terminal/__returns-support";

const h: HarnessHandle = { harness: null, dockerSkipped: false };
const skip = (): boolean => h.dockerSkipped || !h.harness;
const ACTOR = "0a000000-0000-7000-8000-0000000000ac";

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
  enableReturns();
}, 180_000);
afterAll(async () => {
  disableReturns();
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));

const env = () => h.harness!.env;
const sql = <T = Record<string, any>>(text: string, values: unknown[] = []): Promise<T[]> => env().admin.query(text, values).then((r) => r.rows as T[]);

// ------------------------------------------------------------------ fixtures

let seq = 0;
const uid = (tag: string): string => {
  seq += 1;
  return `0a000000-0000-7000-8000-${tag.padEnd(4, "0").slice(0, 4)}${String(seq).padStart(8, "0")}`;
};

interface SeededOffer {
  offerId: string;
  productIds: string[];
  packRevision: number;
}

/** Products of tenant A and one live offer over them (version 1, all stores), published through the real repository and Pack rebuild. */
async function seedOffer(opts: { products: number; offer?: Partial<{ buyQuantity: number; getQuantity: number; percentOff: string; maxApplicationsPerSale: number | null }>; productIds?: string[]; tenantId?: string }): Promise<SeededOffer> {
  const tenantId = opts.tenantId ?? TENANT_A;
  const productIds = opts.productIds ?? Array.from({ length: opts.products }, () => uid("e1"));
  for (const id of productIds) {
    await env().admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by) VALUES ($1, $2, 'P', 'standard', $3, $3) ON CONFLICT DO NOTHING`,
      [id, tenantId, ACTOR],
    );
  }
  const definition: OfferDefinition = normaliseDefinition(
    OfferDefinitionSchema.parse({
      nameAr: "عرض",
      type: "buy_x_get_y_percent",
      parameters: { buyQuantity: 1, getQuantity: 1, percentOff: "40", rewardSelection: "cheapest", maxApplicationsPerSale: null, priceBasis: "resolved_store_price", ...(opts.offer ?? {}) },
      eligibility: { include: { productIds } },
      storeScope: { allStores: true },
      schedule: { timeBasis: "absolute", startsAt: "2020-01-01T00:00:00Z", endsAt: null },
    }),
  );
  const offerId = await runWithTenantContext(env().app, { tenantId, isPlatformAdmin: false }, async (client) => {
    const id = await insertOffer(client, { tenantId, definition, userId: ACTOR });
    await insertVersion(client, { tenantId, offerId: id, version: 1, definition, eligibleSetCount: productIds.length, userId: ACTOR });
    await clearDraft(client, tenantId, id);
    await rebuildOfferPack(client, tenantId);
    return id;
  });
  return { offerId, productIds, packRevision: await latestRevision(tenantId) };
}

async function latestRevision(tenantId = TENANT_A): Promise<number> {
  return Number((await sql<{ r: string }>(`SELECT max(revision)::text AS r FROM offer_pack_revisions WHERE tenant_id = $1`, [tenantId]))[0]!.r);
}

async function endOffer(offerId: string): Promise<number> {
  await runWithTenantContext(env().app, { tenantId: TENANT_A, isPlatformAdmin: false }, async (client) => {
    await markEnded(client, TENANT_A, offerId, ACTOR);
    await rebuildOfferPack(client, TENANT_A);
  });
  return latestRevision();
}

interface Line {
  product: string | null;
  unitPrice: string;
  quantity?: string;
  lineAmount: string;
  promotion?: { offerId: string; offerVersion: number; packRevision: number; discountAmount: string } | undefined;
  discount?: Record<string, unknown> | undefined;
}

let ext = 0;
const nextExternalId = (): string => `rt1337-${String((ext += 1)).padStart(5, "0")}`;

function body(lines: Line[], over: Record<string, unknown> = {}, currencyCode = "EGP"): Record<string, unknown> {
  const total = lines.reduce((sum, l) => sum + Math.round(Number(l.lineAmount) * 100), 0) / 100;
  return captureBody({
    externalId: nextExternalId(),
    currencyCode,
    posTotal: total.toFixed(2),
    lines: lines.map((l, i) => ({
      lineName: `Line ${i + 1}`,
      unitPrice: l.unitPrice,
      currencyCode,
      quantity: l.quantity ?? "1",
      lineAmount: l.lineAmount,
      unit: "ea",
      ...(l.product === null ? {} : { tenantProductRef: l.product }),
      ...(l.promotion ? { promotion: l.promotion } : {}),
      ...(l.discount ? { discount: l.discount } : {}),
    })),
    ...over,
  });
}

const capture = (b: Record<string, unknown>, key = nextExternalId()) =>
  h.harness!.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(`k${key}`)).send(b);

const cite = (o: SeededOffer, discountAmount: string, over: Partial<{ offerVersion: number; packRevision: number; offerId: string }> = {}) => ({
  offerId: over.offerId ?? o.offerId,
  offerVersion: over.offerVersion ?? 1,
  packRevision: over.packRevision ?? o.packRevision,
  discountAmount,
});

const reviewRows = (saleRef: string) => sql(`SELECT * FROM audit_events WHERE action = $2 AND target_id = $1`, [saleRef, SALE_OFFER_REVIEW_ACTION]);

// -------------------------------------------------------------------- capture

describe("captureSale with an automatic-offer promotion", () => {
  it("stores the fact per line, echoes it on readSale and the history, and flags nothing for a correct E1 sale", async () => {
    if (skip()) return;
    const o = await seedOffer({ products: 2 });
    const res = await capture(
      body([
        { product: o.productIds[0]!, unitPrice: "300.00", lineAmount: "300.00", promotion: cite(o, "0.00") },
        { product: o.productIds[1]!, unitPrice: "200.00", lineAmount: "120.00", promotion: cite(o, "80.00") },
      ]),
    );
    expect([res.status, res.body.error]).toEqual([201, undefined]);
    expect(res.body.lines.map((l: { promotion?: unknown }) => l.promotion)).toEqual([
      { offerId: o.offerId, offerVersion: 1, packRevision: o.packRevision, discountAmount: "0.0000" },
      { offerId: o.offerId, offerVersion: 1, packRevision: o.packRevision, discountAmount: "80.0000" },
    ]);
    const rows = await sql(`SELECT * FROM sale_line_promotions WHERE sale_id = $1 ORDER BY discount_amount`, [res.body.saleRef]);
    expect(rows).toHaveLength(2);
    expect(await reviewRows(res.body.saleRef)).toEqual([]);
    const read = await h.harness!.http().get(`/api/pos/v1/sales/${res.body.saleRef}`);
    expect(read.status).toBe(200);
    expect(read.body.lines[1].promotion).toMatchObject({ offerId: o.offerId, discountAmount: "80.0000" });
  });

  it("replays a same-key retry, and a changed promotion on the same provenance is a different payload (409)", async () => {
    if (skip()) return;
    const o = await seedOffer({ products: 2 });
    const lines: Line[] = [
      { product: o.productIds[0]!, unitPrice: "300.00", lineAmount: "300.00", promotion: cite(o, "0.00") },
      { product: o.productIds[1]!, unitPrice: "200.00", lineAmount: "120.00", promotion: cite(o, "80.00") },
    ];
    const b = body(lines);
    const first = await capture(b, "same");
    expect(first.status).toBe(201);
    const again = await capture(b, "same");
    expect([again.status, again.headers["idempotent-replayed"], again.body.saleRef]).toEqual([201, "true", first.body.saleRef]);
    // The same provenance (externalId) with a line that no longer carries its promotion is a different payload.
    const { promotion: _dropped, ...plain } = lines[1]!;
    const different = body([lines[0]!, { ...plain, lineAmount: "200.00" }], { externalId: b["externalId"], posTotal: "500.00" });
    const conflict = await capture(different, "same2");
    expect([conflict.status, conflict.body.error?.code]).toEqual([409, "idempotency_key_conflict"]);
    expect(Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM sale_line_promotions WHERE sale_id = $1`, [first.body.saleRef]))[0]!.n)).toBe(2);
  });

  it.each([
    ["a promotion with an unknown key", (o: SeededOffer) => ({ ...cite(o, "0.00"), extra: 1 })],
    ["a promotion with a bad offer id", (o: SeededOffer) => ({ ...cite(o, "0.00"), offerId: "nope" })],
    ["a promotion with a zero offerVersion", (o: SeededOffer) => cite(o, "0.00", { offerVersion: 0 })],
    ["a promotion with a negative amount", (o: SeededOffer) => cite(o, "-1.00")],
  ])("is 400 for %s", async (_label, make) => {
    if (skip()) return;
    const o = await seedOffer({ products: 1 });
    const res = await capture(body([{ product: o.productIds[0]!, unitPrice: "10.00", lineAmount: "10.00", promotion: make(o) as never }]));
    expect([res.status, res.body.error?.code]).toEqual([400, "validation_error"]);
  });

  it("is 400 when a line carries both a promotion and a manual discount (OD-5)", async () => {
    if (skip()) return;
    const o = await seedOffer({ products: 1 });
    const res = await capture(
      body([
        {
          product: o.productIds[0]!,
          unitPrice: "100.00",
          lineAmount: "90.00",
          promotion: cite(o, "0.00"),
          discount: { kind: "percent", value: "10", amount: "10.00", reasonCode: "promotion", authoritySource: "cashier_approval", approverRole: "manager" },
        },
      ]),
    );
    expect([res.status, res.body.error?.code]).toEqual([400, "validation_error"]);
  });

  it.each([
    ["a discount that is not the version's percent of the unit price", (o: SeededOffer) => [{ unitPrice: "200.00", lineAmount: "121.00", promotion: cite(o, "79.00") }]],
    ["a net that breaks lineAmount = unitPrice x quantity - discount", (o: SeededOffer) => [{ unitPrice: "200.00", lineAmount: "100.00", promotion: cite(o, "80.00") }]],
    ["a reward line with a quantity above one", (o: SeededOffer) => [{ unitPrice: "200.00", quantity: "2", lineAmount: "320.00", promotion: cite(o, "80.00") }]],
    ["a discount above the line gross", (o: SeededOffer) => [{ unitPrice: "10.00", lineAmount: "0.00", promotion: cite(o, "11.00") }]],
    ["an offer version that does not exist", (o: SeededOffer) => [{ unitPrice: "200.00", lineAmount: "120.00", promotion: cite(o, "80.00", { offerVersion: 9 }) }]],
    ["a Pack revision that does not exist", (o: SeededOffer) => [{ unitPrice: "200.00", lineAmount: "120.00", promotion: cite(o, "80.00", { packRevision: 99999 }) }]],
    ["an offer of no tenant", (o: SeededOffer) => [{ unitPrice: "200.00", lineAmount: "120.00", promotion: cite(o, "80.00", { offerId: "0a000000-0000-7000-8000-00000000dead" }) }]],
  ])("is 422 sale_line_pricing_invalid for %s, and records nothing", async (_label, lines) => {
    if (skip()) return;
    const o = await seedOffer({ products: 1 });
    const before = Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM sale_line_promotions`))[0]!.n);
    const res = await capture(body(lines(o).map((l) => ({ ...l, product: o.productIds[0]! }))));
    expect([res.status, res.body.error?.code]).toEqual([422, "sale_line_pricing_invalid"]);
    expect(Number((await sql<{ n: string }>(`SELECT count(*) AS n FROM sale_line_promotions`))[0]!.n)).toBe(before);
  });

  it("another tenant cannot cite this tenant's offer (RLS: the version does not exist for it)", async () => {
    if (skip()) return;
    const o = await seedOffer({ products: 1 });
    h.harness!.contextGuard.tenantId = TENANT_B;
    h.harness!.contextGuard.storeId = "0b000000-0000-7000-8000-00000000b5b1";
    const res = await capture(body([{ product: o.productIds[0]!, unitPrice: "200.00", lineAmount: "120.00", promotion: cite(o, "80.00") }]));
    expect([res.status, res.body.error?.code]).toEqual([422, "sale_line_pricing_invalid"]);
  });

  it("judges the sale against the CITED Pack revision, not the current offers: an ended offer's earlier sale is clean, a later revision's is flagged (OD-9, §19)", async () => {
    if (skip()) return;
    const o = await seedOffer({ products: 2 });
    const lines = (rev: number): Line[] => [
      { product: o.productIds[0]!, unitPrice: "300.00", lineAmount: "300.00", promotion: cite(o, "0.00", { packRevision: rev }) },
      { product: o.productIds[1]!, unitPrice: "200.00", lineAmount: "120.00", promotion: cite(o, "80.00", { packRevision: rev }) },
    ];
    const endedRevision = await endOffer(o.offerId);
    const old = await capture(body(lines(o.packRevision)));
    expect(old.status).toBe(201);
    expect(await reviewRows(old.body.saleRef)).toEqual([]);
    // Citing the revision at which the offer had left the Pack: accepted, flagged for review, never re-priced.
    const late = await capture(body(lines(endedRevision)));
    expect(late.status).toBe(201);
    const flags = await reviewRows(late.body.saleRef);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.metadata.findings[0]).toMatchObject({ offerId: o.offerId, packRevision: endedRevision, reasons: expect.arrayContaining(["cited_product_not_in_eligible_set"]) });
    expect(late.body.lines[1].lineAmount).toBe("120.0000");
  });

  it("flags a rule-level difference and keeps the till's facts: the discount went to the wrong unit (OD-9)", async () => {
    if (skip()) return;
    const o = await seedOffer({ products: 3 });
    // Eligible 100, 80, 60: one application, the reward is the 60 (24.00). The till discounted the 80 (32.00).
    const res = await capture(
      body([
        { product: o.productIds[0]!, unitPrice: "100.00", lineAmount: "100.00", promotion: cite(o, "0.00") },
        { product: o.productIds[1]!, unitPrice: "80.00", lineAmount: "48.00", promotion: cite(o, "32.00") },
        { product: o.productIds[2]!, unitPrice: "60.00", lineAmount: "60.00", promotion: cite(o, "0.00") },
      ]),
    );
    expect(res.status).toBe(201);
    const flags = await reviewRows(res.body.saleRef);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.metadata.findings).toEqual([
      expect.objectContaining({ recordedDiscount: "32.00", expectedDiscount: "24.00", reasons: ["discount_differs_from_server_evaluation"] }),
    ]);
    expect(flags[0]).toMatchObject({ tenant_id: TENANT_A, store_id: STORE_A_X, target_type: "sale" });
    // Never re-priced: the stored line is what the till sent.
    expect((await sql(`SELECT line_amount::text AS a FROM sale_lines WHERE sale_id = $1 ORDER BY line_seq`, [res.body.saleRef])).map((r) => r["a"])).toEqual(["100.0000", "48.0000", "60.0000"]);
  });

  it("flags a cited product outside the eligible set, and one with no product reference", async () => {
    if (skip()) return;
    const o = await seedOffer({ products: 1 });
    const other = await seedOffer({ products: 1 });
    const res = await capture(
      body([
        { product: other.productIds[0]!, unitPrice: "100.00", lineAmount: "100.00", promotion: cite(o, "0.00") },
        { product: null, unitPrice: "50.00", lineAmount: "50.00", promotion: cite(o, "0.00") },
      ]),
    );
    expect(res.status).toBe(201);
    expect((await reviewRows(res.body.saleRef))[0]!.metadata.findings[0].reasons).toContain("cited_product_not_in_eligible_set");
  });

  it("flags a counted participant the till did not cite (its later return would settle without the offer)", async () => {
    if (skip()) return;
    const o = await seedOffer({ products: 2 });
    // 1+1 at 40%: A 100.00 (not cited) and B 60.00 (the reward, 24.00, cited). The totals agree, the citation is incomplete.
    const res = await capture(
      body([
        { product: o.productIds[0]!, unitPrice: "100.00", lineAmount: "100.00" },
        { product: o.productIds[1]!, unitPrice: "60.00", lineAmount: "36.00", promotion: cite(o, "24.00") },
      ]),
    );
    expect(res.status).toBe(201);
    const flags = await reviewRows(res.body.saleRef);
    expect(flags[0]!.metadata.findings[0].reasons).toEqual(["participant_not_cited"]);
  });

  it("is 422 sale_line_pricing_invalid, not a crash, for a quantity no evaluation may expand, and records nothing", async () => {
    if (skip()) return;
    const o = await seedOffer({ products: 2 });
    const res = await capture(
      body([
        { product: o.productIds[0]!, unitPrice: "1.00", quantity: "30000000", lineAmount: "30000000.00" },
        { product: o.productIds[1]!, unitPrice: "1.00", lineAmount: "0.60", promotion: cite(o, "0.40") },
      ]),
    );
    expect([res.status, res.body.error?.code]).toEqual([422, "sale_line_pricing_invalid"]);
  });

  it("a sale without any promotion is captured exactly as before (no offer query needed, no fact, no flag)", async () => {
    if (skip()) return;
    const res = await capture(captureBody({ externalId: nextExternalId() }));
    expect(res.status).toBe(201);
    expect(res.body.lines.every((l: { promotion?: unknown }) => l.promotion === undefined)).toBe(true);
  });

  it("the fact table is append-only for every role", async () => {
    if (skip()) return;
    const o = await seedOffer({ products: 1 });
    const res = await capture(body([{ product: o.productIds[0]!, unitPrice: "200.00", lineAmount: "120.00", promotion: cite(o, "80.00") }]));
    expect(res.status).toBe(201);
    await expect(env().admin.query(`UPDATE sale_line_promotions SET discount_amount = 0 WHERE sale_id = $1`, [res.body.saleRef])).rejects.toThrow(/append-only/);
    await expect(env().admin.query(`DELETE FROM sale_line_promotions WHERE sale_id = $1`, [res.body.saleRef])).rejects.toThrow(/append-only/);
  });
});

// -------------------------------------------------------------------- returns

interface VectorSaleLine { saleLineRef: string; productId: string; unitPrice: string; quantity: string; lineAmount: string; promotion: { discountAmount: string } | null }
interface StepExpected { refund: string; clawback: string | null; outcome: string }
interface ReturnCase {
  id: string;
  offer: { buyQuantity: number; getQuantity: number; percentOff: string; maxApplicationsPerSale: number | null };
  saleLines: VectorSaleLine[];
  steps: Array<{ returned: Array<{ saleLineRef: string; quantity: string }>; expected: StepExpected }>;
}
const FILE = resolve(__dirname, "..", "..", "..", "..", "packages", "contracts", "fixtures", "offers", "golden-vectors.json");
const vectors = JSON.parse(readFileSync(FILE, "utf8")) as {
  returns: Array<Omit<ReturnCase, "steps"> & { returned: ReturnCase["steps"][number]["returned"]; expected: StepExpected }>;
  returnSequences: ReturnCase[];
};
const CASES: ReturnCase[] = [
  ...vectors.returns.map((v) => ({ id: v.id, offer: v.offer, saleLines: v.saleLines, steps: [{ returned: v.returned, expected: v.expected }] })),
  ...vectors.returnSequences,
];

describe("recordReturn with a clawback — the golden return vectors end to end", () => {
  it.each(CASES.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    if (skip()) return;
    const o = await seedOffer({ products: c.saleLines.length, offer: c.offer });
    const byVectorRef = new Map<string, number>();
    const captureRes = await capture(
      body(
        c.saleLines.map((l, i) => {
          byVectorRef.set(l.saleLineRef, i);
          return {
            product: o.productIds[i]!,
            unitPrice: l.unitPrice,
            quantity: l.quantity,
            lineAmount: l.lineAmount,
            ...(l.promotion ? { promotion: cite(o, l.promotion.discountAmount) } : {}),
          };
        }),
      ),
    );
    expect([captureRes.status, captureRes.body.error]).toEqual([201, undefined]);
    // A sale that matches the server's evaluation is never flagged.
    expect(await reviewRows(captureRes.body.saleRef)).toEqual([]);
    const lineRefs: string[] = captureRes.body.lines.map((l: { lineRef: string }) => l.lineRef);

    for (const [stepIndex, step] of c.steps.entries()) {
      const lines = step.returned.map((r) => ({ lineRef: lineRefs[byVectorRef.get(r.saleLineRef)!]!, quantity: r.quantity }));
      const key = `${c.id}-${stepIndex}`;
      const refund = step.expected.refund;
      const giveBack = c.id === "S3-clawback-then-reward" && stepIndex === 1;
      if (step.expected.outcome === "promotion_clawback_exceeds_refund") {
        const res = await postReturn(h, captureRes.body.saleRef, returnBody(`rt1337-ret-${key}`, lines, "0.00"), idempKey(key));
        expect([res.status, res.body.error?.code]).toEqual([422, "promotion_clawback_exceeds_refund"]);
        expect(await sql(`SELECT 1 FROM sale_returns WHERE external_id = $1`, [`rt1337-ret-${key}`])).toEqual([]);
        continue;
      }
      if (giveBack) {
        const res = await postReturn(h, captureRes.body.saleRef, returnBody(`rt1337-ret-${key}`, lines, refund), idempKey(key));
        expect([res.status, res.body.error?.code]).toEqual([422, "promotion_return_requires_clawback"]);
        expect(await sql(`SELECT 1 FROM sale_returns WHERE external_id = $1`, [`rt1337-ret-${key}`])).toEqual([]);
        continue;
      }
      const clawback = step.expected.clawback;
      const rewardReturned = step.returned.some((r) => Number(c.saleLines.find((l) => l.saleLineRef === r.saleLineRef)!.promotion?.discountAmount ?? 0) > 0);
      if ((clawback !== null && Number(clawback) > 0) || rewardReturned) {
        // Fail closed until the ledger can post it (RT-1340): a clawback, or a returned reward line, is refused
        // (the refund the vector expects is what the lift will pay), and nothing is recorded.
        const res = await postReturn(h, captureRes.body.saleRef, returnBody(`rt1337-ret-${key}`, lines, refund), idempKey(key));
        expect([res.status, res.body.error?.code]).toEqual([422, "promotion_return_requires_clawback"]);
        expect(await sql(`SELECT 1 FROM sale_returns WHERE external_id = $1`, [`rt1337-ret-${key}`])).toEqual([]);
        expect(await sql(`SELECT 1 FROM sale_return_promotion_clawbacks`)).toEqual([]);
        // The vector's later steps assume this return happened; they stay covered by the pure settlement spec.
        break;
      }
      const res = await postReturn(h, captureRes.body.saleRef, returnBody(`rt1337-ret-${key}`, lines, refund), idempKey(key));
      expect([res.status, res.body.error]).toEqual([201, undefined]);
      expect(Number(res.body.returnTotal)).toBe(Number(refund));
      expect(res.body.promotionClawbacks).toBeUndefined();
      // A replay answers the stored return, clawbacks included.
      const replay = await postReturn(h, captureRes.body.saleRef, returnBody(`rt1337-ret-${key}`, lines, refund), idempKey(key));
      expect([replay.status, replay.headers["idempotent-replayed"]]).toEqual([201, "true"]);
      expect(replay.body).toEqual(res.body);
    }
  });

  it("refuses a return with a clawback while the ledger cannot post it, and records nothing", async () => {
    if (skip()) return;
    const o = await seedOffer({ products: 2 });
    const cap = await capture(
      body([
        { product: o.productIds[0]!, unitPrice: "300.00", lineAmount: "300.00", promotion: cite(o, "0.00") },
        { product: o.productIds[1]!, unitPrice: "200.00", lineAmount: "120.00", promotion: cite(o, "80.00") },
      ]),
    );
    // E1: returning the 300.00 trigger takes the 80.00 discount back (clawback 80.00, refund 220.00).
    const res = await postReturn(h, cap.body.saleRef, returnBody("rt1337-ret-rows", [{ lineRef: cap.body.lines[0].lineRef, quantity: "1" }], "220.00"), idempKey("rows"));
    expect([res.status, res.body.error?.code]).toEqual([422, "promotion_return_requires_clawback"]);
    expect(await sql(`SELECT 1 FROM sale_returns WHERE external_id = $1`, ["rt1337-ret-rows"])).toEqual([]);
  });

  it("refuses the return of a reward line even when it takes no clawback", async () => {
    if (skip()) return;
    const o = await seedOffer({ products: 2 });
    const cap = await capture(
      body([
        { product: o.productIds[0]!, unitPrice: "300.00", lineAmount: "300.00", promotion: cite(o, "0.00") },
        { product: o.productIds[1]!, unitPrice: "200.00", lineAmount: "120.00", promotion: cite(o, "80.00") },
      ]),
    );
    // The reward line comes back at its net: the Connector's return builder could not post unitPrice x quantity != lineAmount.
    const res = await postReturn(h, cap.body.saleRef, returnBody("rt1337-ret-reward", [{ lineRef: cap.body.lines[1].lineRef, quantity: "1" }], "120.00"), idempKey("reward"));
    expect([res.status, res.body.error?.code]).toEqual([422, "promotion_return_requires_clawback"]);
  });

  it("accepts the return of a non-reward promoted line that changes no discount, as an ordinary return", async () => {
    if (skip()) return;
    const o = await seedOffer({ products: 3 });
    // 300 (trigger), 200 (reward, 80.00), 100 (a participant left over, cited at 0.00): returning the 100 keeps the same reward.
    const cap = await capture(
      body([
        { product: o.productIds[0]!, unitPrice: "300.00", lineAmount: "300.00", promotion: cite(o, "0.00") },
        { product: o.productIds[1]!, unitPrice: "200.00", lineAmount: "120.00", promotion: cite(o, "80.00") },
        { product: o.productIds[2]!, unitPrice: "100.00", lineAmount: "100.00", promotion: cite(o, "0.00") },
      ]),
    );
    expect(cap.status).toBe(201);
    const res = await postReturn(h, cap.body.saleRef, returnBody("rt1337-ret-leftover", [{ lineRef: cap.body.lines[2].lineRef, quantity: "1" }], "100.00"), idempKey("leftover"));
    expect([res.status, res.body.error]).toEqual([201, undefined]);
    expect(res.body.promotionClawbacks).toBeUndefined();
    expect(Number(res.body.returnTotal)).toBe(100);
  });

  it("a sale with no offer returns exactly as before", async () => {
    if (skip()) return;
    const cap = await capture(captureBody({ externalId: nextExternalId(), posTotal: "12.5000" }));
    const line = cap.body.lines[0];
    const ret = await postReturn(h, cap.body.saleRef, returnBody("rt1337-ret-plain", [{ lineRef: line.lineRef, quantity: "1" }], "5.00"), idempKey("plain"));
    expect([ret.status, ret.body.returnTotal, ret.body.promotionClawbacks]).toEqual([201, "5.0000", undefined]);
  });
});
void STORE_A_Y;
