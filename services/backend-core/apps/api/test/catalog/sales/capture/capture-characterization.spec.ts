/**
 * RT-1224 — characterization matrix for `SalesService.captureSale`.
 *
 * Written against main at 6c76cf941 BEFORE `captureSale` was decomposed
 * (RT-148 H-7), so the refactor is held to what the capture path does today.
 * One place for the cases the issue lists, each asserting the status, the
 * error code and every row the capture writes (sales, lines, tenders,
 * responsibilities, `sale.captured` outbox rows):
 *
 *   1. first capture: 201; stored payload_hash = the pinned golden literal;
 *      business_date in the store timezone; tender/responsibility counts; the
 *      nine receipt snapshot columns; one outbox row;
 *   2. identical replay (new Idempotency-Key): 200, the same sale, a new
 *      receipt never rewrites the stored one, no second outbox row;
 *   3. concurrent race: one 201 and one 200, one sale, one outbox row;
 *   4. cross-store replay: pinned as main answers it today (the capture
 *      mapper has no SaleNotFoundError case, so the filter's 500), the same
 *      for an identical and a different body, nothing written;
 *   5. body mismatch: 409 `idempotency_key_conflict` (RT-1206);
 *   6. tender mismatch and 7. responsibility mismatch: the stored hash EQUALS
 *      the replay's (seeded directly), so only `assertSameTenders` /
 *      `assertSameResponsibilities` can answer the 409. Over HTTP the RT-1206
 *      hash compare would catch the change first and hide a dropped check;
 *   8. a refused first capture leaves no row and no outbox row, and a replay
 *      is answered before any first-capture refusal (assertFirstCaptureAccepted
 *      ordering).
 */
import { sha256CanonicalHex } from "../../../../src/catalog/sales/payload-hash";
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  idempKey,
  STORE_A_X,
  STORE_A_Y,
  TENANT_A,
  DEVICE_USER_ID,
  type HarnessHandle,
} from "./__capture-harness";
import { APPROVER_MANAGER, HARNESS_REQUESTER } from "../__support__/void-approval-fixture";
import { GOLDEN_PAYER_REF, goldenVector } from "../__support__/capture-hash-golden";

const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
const h: HarnessHandle = { harness: null, dockerSkipped: false };
const skip = (): boolean => h.dockerSkipped || !h.harness;

const PLAIN = goldenVector("no tenders (tender-unknown sale)");
const TENDERS = goldenVector("split cash + card tenders with reference, tenderRef and sequence");
const CREDIT = goldenVector("cash + credit responsibility");

const RECEIPT = {
  saleNumber: "till-1-2026-05-02-000001",
  receiptNumber: "R-000001",
  terminalLabel: "till-1",
  operatorDisplayName: "Cashier One",
  settledAt: "2026-05-01T22:30:04.000Z",
  branchName: "Nile Branch",
  branchAddress: "1 Nile St, Cairo",
  taxRegistrationId: "123-456-789",
  changeGiven: "7.50",
};

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
  if (!h.harness) return;
  await h.harness.env.admin.query(
    `INSERT INTO payer_account (id, tenant_id, store_id, category, display_name, external_ref, status)
     VALUES ($1, $2, $3, 'corporate', 'RT-1224 corp', 'CUST-1224', 'active')`,
    [GOLDEN_PAYER_REF, TENANT_A, STORE_A_X],
  );
}, 180_000);
afterAll(async () => {
  delete process.env[TENDERS_FLAG];
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  process.env[TENDERS_FLAG] = "true";
});
afterEach(async () => {
  delete process.env[TENDERS_FLAG];
  if (!h.harness) return;
  const q = (sql: string) => h.harness!.env.admin.query(sql);
  const sales = "SELECT id FROM sales WHERE source_system = 'pos-1'";
  await q(`DELETE FROM sale_responsibilities WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_tenders WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_lines WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sales WHERE source_system = 'pos-1'`);
  await q(`UPDATE stores SET timezone = 'UTC' WHERE id = '${STORE_A_X}'`);
});

let keySeq = 0;
/** POST a capture under a fresh Idempotency-Key (a provenance re-delivery). */
function post(body: Readonly<Record<string, unknown>>) {
  keySeq += 1;
  return h.harness!.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(`rt1224k${keySeq}`)).send(body);
}

interface Written {
  sales: number;
  lines: number;
  tenders: number;
  responsibilities: number;
  captured: number;
}

/** Every row a capture of `externalId` wrote. */
async function written(externalId: string): Promise<Written> {
  const r = await h.harness!.env.admin.query<Record<keyof Written, string>>(
    `WITH s AS (SELECT id FROM sales WHERE source_system = 'pos-1' AND external_id = $1)
     SELECT (SELECT count(*) FROM s)::text AS sales,
            (SELECT count(*) FROM sale_lines WHERE sale_id IN (SELECT id FROM s))::text AS lines,
            (SELECT count(*) FROM sale_tenders WHERE sale_id IN (SELECT id FROM s))::text AS tenders,
            (SELECT count(*) FROM sale_responsibilities WHERE sale_id IN (SELECT id FROM s))::text AS responsibilities,
            (SELECT count(*) FROM outbox_events
              WHERE event_type = 'sale.captured' AND payload->>'sale_id' IN (SELECT id::text FROM s))::text AS captured`,
    [externalId],
  );
  const row = r.rows[0]!;
  return {
    sales: Number(row.sales),
    lines: Number(row.lines),
    tenders: Number(row.tenders),
    responsibilities: Number(row.responsibilities),
    captured: Number(row.captured),
  };
}

const NOTHING: Written = { sales: 0, lines: 0, tenders: 0, responsibilities: 0, captured: 0 };

/** The stored header columns the refactor must keep binding in the same places. */
async function header(externalId: string): Promise<Record<string, unknown>> {
  const r = await h.harness!.env.admin.query(
    `SELECT payload_hash, business_date::text AS business_date, tender_count, responsibility_count,
            device_id::text AS device_id, created_by::text AS created_by, sync_status,
            mismatch_flag, processed_at, pos_total::text AS pos_total,
            receipt_sale_number, receipt_number, receipt_terminal_label,
            receipt_operator_display_name, receipt_settled_at, receipt_branch_name,
            receipt_branch_address, receipt_tax_registration_id,
            receipt_change_given::text AS receipt_change_given
       FROM sales WHERE source_system = 'pos-1' AND external_id = $1`,
    [externalId],
  );
  return r.rows[0] as Record<string, unknown>;
}

/** The `error.code` and status of a refused response. */
const errorOf = (res: { status: number; body: { error?: { code?: string } } }) => ({
  status: res.status,
  code: res.body.error?.code,
});

// ===========================================================================
// 1-3. First capture, identical replay, concurrent race
// ===========================================================================
describe("RT-1224 characterization — first capture", () => {
  it("201: golden payload_hash, business_date in the store timezone, counts, receipt snapshot, one outbox row", async () => {
    if (skip()) return;
    // 22:30Z on 1 May is already 2 May in Cairo (UTC+3 in May 2026).
    await h.harness!.env.admin.query(`UPDATE stores SET timezone = 'Africa/Cairo' WHERE id = $1`, [STORE_A_X]);
    const ext = TENDERS.body["externalId"] as string;
    const res = await post({ ...TENDERS.body, receipt: RECEIPT });
    expect(res.status).toBe(201);
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(res.body).toMatchObject({ storeId: STORE_A_X, businessDate: "2026-05-02", posTotal: "12.5000" });

    expect(await written(ext)).toEqual({ sales: 1, lines: 2, tenders: 2, responsibilities: 0, captured: 1 });
    const row = await header(ext);
    expect(row).toMatchObject({
      payload_hash: TENDERS.sha256Hex,
      business_date: "2026-05-02",
      tender_count: 2,
      responsibility_count: 0,
      created_by: DEVICE_USER_ID,
      sync_status: "captured",
      mismatch_flag: false,
      processed_at: null,
      receipt_sale_number: RECEIPT.saleNumber,
      receipt_number: RECEIPT.receiptNumber,
      receipt_terminal_label: RECEIPT.terminalLabel,
      receipt_operator_display_name: RECEIPT.operatorDisplayName,
      receipt_branch_name: RECEIPT.branchName,
      receipt_branch_address: RECEIPT.branchAddress,
      receipt_tax_registration_id: RECEIPT.taxRegistrationId,
      receipt_change_given: "7.5000",
    });
    expect((row["receipt_settled_at"] as Date).toISOString()).toBe(RECEIPT.settledAt);
    expect(row["device_id"]).toEqual(expect.any(String));
  });

  it("a tender-unknown sale: golden hash, no tender rows, null receipt columns, advisory mismatch flag", async () => {
    if (skip()) return;
    const ext = PLAIN.body["externalId"] as string;
    // posTotal differs from the line sum: stored verbatim, flagged, never refused.
    const body = { ...PLAIN.body, posTotal: "12.5100" };
    const res = await post(body);
    expect(res.status).toBe(201);
    expect(res.body.mismatchFlag).toBe(true);
    expect(await written(ext)).toEqual({ sales: 1, lines: 2, tenders: 0, responsibilities: 0, captured: 1 });
    expect(await header(ext)).toMatchObject({
      payload_hash: sha256CanonicalHex(body),
      business_date: "2026-05-01",
      tender_count: 0,
      responsibility_count: 0,
      pos_total: "12.5100",
      mismatch_flag: true,
      receipt_sale_number: null,
      receipt_number: null,
      receipt_settled_at: null,
      receipt_change_given: null,
    });
  });

  it("the pinned plain vector is the stored hash for its exact body", async () => {
    if (skip()) return;
    const ext = PLAIN.body["externalId"] as string;
    expect((await post(PLAIN.body)).status).toBe(201);
    expect((await header(ext))["payload_hash"]).toBe(PLAIN.sha256Hex);
  });

  it("a credit sale: golden hash, responsibility_count, one responsibility row", async () => {
    if (skip()) return;
    h.harness!.contextGuard.userId = APPROVER_MANAGER;
    const ext = CREDIT.body["externalId"] as string;
    const res = await post(CREDIT.body);
    expect(res.status).toBe(201);
    expect(await written(ext)).toEqual({ sales: 1, lines: 2, tenders: 1, responsibilities: 1, captured: 1 });
    expect(await header(ext)).toMatchObject({
      payload_hash: CREDIT.sha256Hex,
      tender_count: 1,
      responsibility_count: 1,
      created_by: APPROVER_MANAGER,
    });
  });
});

describe("RT-1224 characterization — identical replay", () => {
  it("200 with the replay marker and the same sale; a new receipt never rewrites the stored one; no second outbox row", async () => {
    if (skip()) return;
    const ext = TENDERS.body["externalId"] as string;
    const first = await post({ ...TENDERS.body, receipt: RECEIPT });
    expect(first.status).toBe(201);
    const before = await header(ext);

    const again = await post({ ...TENDERS.body, receipt: { ...RECEIPT, saleNumber: "rewritten" } });
    expect(again.status).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body).toEqual(first.body);
    expect(await written(ext)).toEqual({ sales: 1, lines: 2, tenders: 2, responsibilities: 0, captured: 1 });
    expect(await header(ext)).toEqual(before);
  });
});

describe("RT-1224 characterization — concurrent race", () => {
  it("two simultaneous captures of one provenance: one 201, one 200, one sale, one outbox row", async () => {
    if (skip()) return;
    const ext = TENDERS.body["externalId"] as string;
    const [a, b] = await Promise.all([post(TENDERS.body), post(TENDERS.body)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.saleRef).toBe(b.body.saleRef);
    expect(await written(ext)).toEqual({ sales: 1, lines: 2, tenders: 2, responsibilities: 0, captured: 1 });
  });
});

// ===========================================================================
// 4-5. Cross-store replay, body mismatch
// ===========================================================================
describe("RT-1224 characterization — cross-store replay", () => {
  it("answers as main does today (500 internal_error, non-disclosing), the same for any body, nothing written", async () => {
    if (skip()) return;
    const ext = TENDERS.body["externalId"] as string;
    expect((await post(TENDERS.body)).status).toBe(201);
    const before = await header(ext);
    h.harness!.contextGuard.storeId = STORE_A_Y;
    const same = await post(TENDERS.body);
    const different = await post({ ...TENDERS.body, posTotal: "99.0000" });
    // Pinned, not endorsed: RT-1224 calls this the "cross-store 404", but the
    // capture error mapper has no SaleNotFoundError case (see the RT-1206
    // replay-payload-hash spec). The refactor must not change it either way.
    expect(errorOf(same)).toEqual({ status: 500, code: "internal_error" });
    expect(errorOf(different)).toEqual(errorOf(same));
    expect(JSON.stringify(different.body)).not.toContain(TENDERS.sha256Hex);
    expect(await written(ext)).toEqual({ sales: 1, lines: 2, tenders: 2, responsibilities: 0, captured: 1 });
    expect(await header(ext)).toEqual(before);
  });
});

describe("RT-1224 characterization — body mismatch (RT-1206)", () => {
  it("409 idempotency_key_conflict, the stored sale unchanged, no second outbox row", async () => {
    if (skip()) return;
    const ext = TENDERS.body["externalId"] as string;
    expect((await post(TENDERS.body)).status).toBe(201);
    const before = await header(ext);
    const res = await post({ ...TENDERS.body, occurredAt: "2026-05-01T22:30:01.000Z" });
    expect(errorOf(res)).toEqual({ status: 409, code: "idempotency_key_conflict" });
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(await written(ext)).toEqual({ sales: 1, lines: 2, tenders: 2, responsibilities: 0, captured: 1 });
    expect(await header(ext)).toEqual(before);
  });
});

// ===========================================================================
// 6-7. Tender and responsibility replay checks behind an EQUAL hash
// ===========================================================================

/**
 * Seed a sale directly (admin pool) whose stored payload_hash equals the hash
 * of `body`, with the given counts. Stands in for a stored sale whose tender
 * or responsibility rows no longer match its hash, so only the defence-in-depth
 * row compares can refuse the replay.
 */
async function seedSaleWithHash(
  body: Readonly<Record<string, unknown>>,
  counts: { tenders: number; responsibilities: number },
): Promise<string> {
  const r = await h.harness!.env.admin.query<{ id: string }>(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by, tender_count, responsibility_count)
     VALUES (gen_random_uuid(), $1, $2, 'USD', $3::numeric, $4::timestamptz,
             ($4::timestamptz AT TIME ZONE 'UTC')::date, 'pos-1', $5, $6, $7, $8, $9)
     RETURNING id::text AS id`,
    [
      TENANT_A,
      STORE_A_X,
      body["posTotal"],
      body["occurredAt"],
      body["externalId"],
      sha256CanonicalHex(body),
      DEVICE_USER_ID,
      counts.tenders,
      counts.responsibilities,
    ],
  );
  return r.rows[0]!.id;
}

async function seedTender(saleId: string, method: string, amount: string): Promise<void> {
  await h.harness!.env.admin.query(
    `INSERT INTO sale_tenders (id, sale_id, tenant_id, store_id, method, amount, currency_code)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::numeric, 'USD')`,
    [saleId, TENANT_A, STORE_A_X, method, amount],
  );
}

describe("RT-1224 characterization — tender mismatch behind an equal hash", () => {
  it("a stored tender count that differs → 409 idempotency_key_conflict, nothing written", async () => {
    if (skip()) return;
    const ext = TENDERS.body["externalId"] as string;
    await seedSaleWithHash(TENDERS.body, { tenders: 0, responsibilities: 0 });
    const res = await post(TENDERS.body);
    expect(errorOf(res)).toEqual({ status: 409, code: "idempotency_key_conflict" });
    expect(await written(ext)).toEqual({ ...NOTHING, sales: 1 });
  });

  it("stored tender rows that differ (same count) → 409 idempotency_key_conflict, nothing written", async () => {
    if (skip()) return;
    const body = { ...PLAIN.body, externalId: "rt1224-tender-rows", tenders: [{ method: "cash", amount: "12.5" }] };
    const saleId = await seedSaleWithHash(body, { tenders: 1, responsibilities: 0 });
    await seedTender(saleId, "cash", "12.4");
    const res = await post(body);
    expect(errorOf(res)).toEqual({ status: 409, code: "idempotency_key_conflict" });
    expect(await written("rt1224-tender-rows")).toEqual({ ...NOTHING, sales: 1, tenders: 1 });
  });

  it("matching stored tender rows → 200 replay (the control for the two cases above)", async () => {
    if (skip()) return;
    const body = { ...PLAIN.body, externalId: "rt1224-tender-ok", tenders: [{ method: "cash", amount: "12.5" }] };
    const saleId = await seedSaleWithHash(body, { tenders: 1, responsibilities: 0 });
    await seedTender(saleId, "cash", "12.5000");
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(res.body.saleRef).toBe(saleId);
  });
});

describe("RT-1224 characterization — responsibility mismatch behind an equal hash", () => {
  it("a stored responsibility count that differs → 409 idempotency_key_conflict", async () => {
    if (skip()) return;
    const ext = CREDIT.body["externalId"] as string;
    const saleId = await seedSaleWithHash(CREDIT.body, { tenders: 1, responsibilities: 0 });
    await seedTender(saleId, "cash", "2.5");
    const res = await post(CREDIT.body);
    expect(errorOf(res)).toEqual({ status: 409, code: "idempotency_key_conflict" });
    expect(await written(ext)).toEqual({ ...NOTHING, sales: 1, tenders: 1 });
  });

  it("a stored responsibility row that differs (same count) → 409 idempotency_key_conflict", async () => {
    if (skip()) return;
    const ext = CREDIT.body["externalId"] as string;
    const saleId = await seedSaleWithHash(CREDIT.body, { tenders: 1, responsibilities: 1 });
    await seedTender(saleId, "cash", "2.5");
    await h.harness!.env.admin.query(
      `INSERT INTO sale_responsibilities (id, tenant_id, store_id, sale_id, payer_id, amount, sequence)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 9.99, 1)`,
      [TENANT_A, STORE_A_X, saleId, GOLDEN_PAYER_REF],
    );
    const res = await post(CREDIT.body);
    expect(errorOf(res)).toEqual({ status: 409, code: "idempotency_key_conflict" });
    expect(await written(ext)).toEqual({ ...NOTHING, sales: 1, tenders: 1, responsibilities: 1 });
  });
});

// ===========================================================================
// 8. Refused first captures, and the replay-before-refusal ordering
// ===========================================================================
describe("RT-1224 characterization — a refused first capture leaves no row", () => {
  it.each([
    [
      "tenders that do not sum to posTotal",
      { ...PLAIN.body, externalId: "rt1224-refuse-sum", tenders: [{ method: "cash", amount: "12" }] },
      { status: 422, code: "sale_tender_mismatch" },
    ],
    [
      "a line that breaks the price invariant",
      {
        ...PLAIN.body,
        externalId: "rt1224-refuse-price",
        posTotal: "10.0000",
        lines: [{ lineName: "Widget", unitPrice: "3.3333", currencyCode: "USD", quantity: "3", lineAmount: "10.0000", unit: "ea" }],
      },
      { status: 422, code: "sale_line_pricing_invalid" },
    ],
    [
      "credit on the device path",
      { ...CREDIT.body, externalId: "rt1224-refuse-device", operatorUserId: HARNESS_REQUESTER },
      { status: 422, code: "sale_responsibility_offline_refused" },
    ],
  ])("%s → the refusal, no sale, line, tender, responsibility or outbox row", async (_name, body, expected) => {
    if (skip()) return;
    const res = await post(body);
    expect(errorOf(res)).toEqual(expected);
    expect(await written(body["externalId"] as string)).toEqual(NOTHING);
  });

  it("a refused first capture can be retried once corrected (nothing was kept)", async () => {
    if (skip()) return;
    const ext = "rt1224-refuse-retry";
    const bad = { ...PLAIN.body, externalId: ext, tenders: [{ method: "cash", amount: "12" }] };
    expect((await post(bad)).status).toBe(422);
    const good = { ...bad, tenders: [{ method: "cash", amount: "12.5" }] };
    expect((await post(good)).status).toBe(201);
    expect(await written(ext)).toEqual({ sales: 1, lines: 2, tenders: 1, responsibilities: 0, captured: 1 });
  });
});

describe("RT-1224 characterization — a replay is answered before any first-capture refusal", () => {
  it("a device-path re-delivery of a stored credit sale → 200 (replay before the offline 422)", async () => {
    if (skip()) return;
    h.harness!.contextGuard.userId = APPROVER_MANAGER;
    const ext = CREDIT.body["externalId"] as string;
    const first = await post(CREDIT.body);
    expect(first.status).toBe(201);
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    const res = await post({ ...CREDIT.body, operatorUserId: HARNESS_REQUESTER });
    expect(res.status).toBe(200);
    expect(res.body.saleRef).toBe(first.body.saleRef);
    expect(await written(ext)).toEqual({ sales: 1, lines: 2, tenders: 1, responsibilities: 1, captured: 1 });
  });
});
