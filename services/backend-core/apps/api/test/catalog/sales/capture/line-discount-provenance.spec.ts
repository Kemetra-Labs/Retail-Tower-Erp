/**
 * RT-1571 (RT-285 F-7, RT-740 lineage; migration 0134, sales.yaml 1.30.0-draft) — the manual discount stored
 * on the sale line, end to end against a real RLS-forced Postgres (the capture harness: real SalesController
 * and SalesService, real IdempotencyInterceptor, `env.app` under RLS).
 *
 * Acceptance (RT-1571; F-7 in docs/decisions/rt-285-checkout-attribution.md §8):
 *   - finalize: a captured line's discount is stored exactly as sent (kind, value, amount, reason, authority
 *     source, approver role, approver id when sent) and returned on `captureSale` and `readSale`; the
 *     responses validate against `Sale`;
 *   - the payload hash is unchanged: the stored `payload_hash` is the hash of the body as before RT-1571;
 *   - old payload compatibility: a sale without a discount stores none and reads exactly as before; a line
 *     captured before 0134 (no stored discount) reads with no `discount` ("not recorded");
 *   - retries: a provenance replay under a new key returns the first capture's facts, and a replay that
 *     changes the discount is still 409 with the stored facts untouched (no retroactive rewrite);
 *   - late sync and processing: a sale rung days earlier and a sale the worker marked synced keep the facts;
 *   - returns: a partial and a full return leave the line's discount intact on the read;
 *   - history and console detail (one loader): the same facts WITHOUT the approver's user id (least
 *     disclosure), validating against `SaleHistoryLine`;
 *   - operator and approver stay separate: `sales.created_by` is the authenticated principal, the approver's
 *     id is its own column, never merged;
 *   - RLS: another tenant cannot read the stored discount.
 *
 * Docker policy: missing Docker is a HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
 */
import { resolve } from "node:path";

import { runWithTenantContext } from "@data-pulse-2/db";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { sha256CanonicalHex } from "../../../../src/common/hashing/payload-hash";
import { CaptureSaleRequestWithTendersSchema } from "../../../../src/catalog/sales/dto/capture-sale-request.dto";
import { loadDetail } from "../../../../src/catalog/sales/history/sale-history.reads";
import { splitSaleAttribution } from "../../../../src/catalog/sales/sale-attribution";
import { loadOpenApiContracts } from "../../../../src/openapi/loader";
import { cleanReturnsFixtures, disableReturns, enableReturns, postReturn, returnBody } from "../terminal/__returns-support";
import {
  captureBody,
  DEVICE_USER_ID,
  idempKey,
  resetHarness,
  startCaptureHarness,
  stopCaptureHarness,
  STORE_A_X,
  TENANT_A,
  TENANT_B,
  type HarnessHandle,
} from "./__capture-harness";

const h: HarnessHandle = { harness: null, dockerSkipped: false };
const skip = (): boolean => h.dockerSkipped || !h.harness;

const APPROVER = "0a000000-0000-7000-8000-000000157121";
const PREFIX = "rt1571-";

const PERCENT = {
  kind: "percent",
  value: "10",
  amount: "9.00",
  reasonCode: "loyal_or_contract_customer",
  authoritySource: "cashier_approval",
  approverRole: "manager",
  approverUserId: APPROVER,
} as const;
const AMOUNT = {
  kind: "amount",
  value: "5.00",
  amount: "5.00",
  reasonCode: "near_expiry_or_damaged",
  authoritySource: "manager_session",
  approverRole: "admin",
} as const;

/** What readSale returns for PERCENT and AMOUNT: money at the stored scale, the percent as a whole number. */
const PERCENT_READ = { ...PERCENT, amount: "9.0000" };
const AMOUNT_READ = { ...AMOUNT, value: "5.0000", amount: "5.0000" };

/** A two-line EGP sale: 2 × 45.00 at 10% (net 81.00) and 1 × 20.00 less 5.00 (net 15.00); total 96.00. */
function discountedSale(externalId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return captureBody({
    externalId: `${PREFIX}${externalId}`,
    currencyCode: "EGP",
    posTotal: "96.00",
    lines: [
      { lineName: "Panadol", unitPrice: "45.00", currencyCode: "EGP", quantity: "2", lineAmount: "81.00", unit: "box", discount: PERCENT },
      { lineName: "Gauze", unitPrice: "20.00", currencyCode: "EGP", quantity: "1", lineAmount: "15.00", unit: "ea", discount: AMOUNT },
    ],
    ...extra,
  });
}

const CONTRACTS = resolve(__dirname, "..", "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "pos-sales");

function validatorOf(id: string, schema: string): ValidateFunction {
  const contract = loadOpenApiContracts({ dir: CONTRACTS }).find((c) => c.id === id);
  if (!contract) throw new Error(`pos-sales/${id}.yaml not found`);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(contract.document as object), $id: id });
  return ajv.compile({ $ref: `${id}#/components/schemas/${schema}` });
}
const validateSale = validatorOf("sales", "Sale");
const validateHistoryLine = validatorOf("sale-history", "SaleHistoryLine");

function expectValid(v: ValidateFunction, body: unknown): void {
  const ok = v(body);
  expect(v.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

function post(body: Record<string, unknown>, key: string) {
  return h.harness!.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(key)).send(body);
}

function read(saleRef: string) {
  return h.harness!.http().get(`/api/pos/v1/sales/${saleRef}`);
}

interface StoredDiscount {
  readonly kind: string | null;
  readonly value: string | null;
  readonly amount: string | null;
  readonly reason: string | null;
  readonly source: string | null;
  readonly role: string | null;
  readonly approver: string | null;
}

async function stored(externalId: string): Promise<StoredDiscount[]> {
  const r = await h.harness!.env.admin.query<StoredDiscount>(
    `SELECT sl.discount_kind AS kind, sl.discount_value::text AS value, sl.discount_amount::text AS amount,
            sl.discount_reason_code AS reason, sl.discount_authority_source AS source,
            sl.discount_approver_role AS role, sl.discount_approver_user_id::text AS approver
       FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
      WHERE s.external_id = $1 ORDER BY sl.line_seq`,
    [`${PREFIX}${externalId}`],
  );
  return r.rows;
}

const NONE: StoredDiscount = { kind: null, value: null, amount: null, reason: null, source: null, role: null, approver: null };
const PERCENT_ROW: StoredDiscount = {
  kind: "percent",
  value: "10.0000",
  amount: "9.0000",
  reason: "loyal_or_contract_customer",
  source: "cashier_approval",
  role: "manager",
  approver: APPROVER,
};
const AMOUNT_ROW: StoredDiscount = {
  kind: "amount",
  value: "5.0000",
  amount: "5.0000",
  reason: "near_expiry_or_damaged",
  source: "manager_session",
  role: "admin",
  approver: null,
};

async function historyLines(saleRef: string, tenantId = TENANT_A) {
  const loaded = await runWithTenantContext(h.harness!.env.app, { tenantId, isPlatformAdmin: false }, (c) =>
    loadDetail(c, { tenantId, storeId: STORE_A_X, visibility: { kind: "store" } }, saleRef),
  );
  return loaded?.projection.lines ?? null;
}

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  disableReturns();
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));
afterEach(async () => {
  disableReturns();
  await cleanReturnsFixtures(h);
  if (!h.harness) return;
  const sales = `SELECT id FROM sales WHERE external_id LIKE '${PREFIX}%'`;
  await h.harness.env.admin.query(`DELETE FROM sale_lines WHERE sale_id IN (${sales})`);
  await h.harness.env.admin.query(`DELETE FROM sales WHERE external_id LIKE '${PREFIX}%'`);
});

describe("RT-1571 — finalize: the discount is stored as sent and read back", () => {
  it("stores both lines' discounts and returns them on captureSale and readSale", async () => {
    if (skip()) return;
    const res = await post(discountedSale("store"), "rt1571store");
    expect(res.status).toBe(201);
    expectValid(validateSale, res.body);
    expect(res.body.lines.map((l: { discount?: unknown }) => l.discount)).toEqual([PERCENT_READ, AMOUNT_READ]);
    expect(res.body.lines.map((l: { lineAmount: string }) => l.lineAmount)).toEqual(["81.0000", "15.0000"]);
    expect(await stored("store")).toEqual([PERCENT_ROW, AMOUNT_ROW]);

    const again = await read(res.body.saleRef);
    expect(again.status).toBe(200);
    expectValid(validateSale, again.body);
    expect(again.body.lines).toEqual(res.body.lines);
  });

  it("keeps the payload hash of the body as it was before RT-1571 (the discount was always hashed)", async () => {
    if (skip()) return;
    const body = discountedSale("hash");
    const res = await post(body, "rt1571hash");
    expect(res.status).toBe(201);
    const { body: hashed } = splitSaleAttribution(CaptureSaleRequestWithTendersSchema.parse(body));
    const r = await h.harness!.env.admin.query<{ payload_hash: string }>(
      `SELECT payload_hash FROM sales WHERE external_id = $1`,
      [`${PREFIX}hash`],
    );
    expect(r.rows[0]!.payload_hash).toBe(sha256CanonicalHex(hashed));
  });

  it("keeps the operator and the approver as separate facts", async () => {
    if (skip()) return;
    const res = await post(discountedSale("actors"), "rt1571actors");
    expect(res.status).toBe(201);
    const r = await h.harness!.env.admin.query<{ created_by: string; approver: string }>(
      `SELECT s.created_by::text AS created_by, sl.discount_approver_user_id::text AS approver
         FROM sales s JOIN sale_lines sl ON sl.sale_id = s.id
        WHERE s.external_id = $1 AND sl.line_seq = 1`,
      [`${PREFIX}actors`],
    );
    expect(r.rows[0]).toEqual({ created_by: DEVICE_USER_ID, approver: APPROVER });
  });
});

describe("RT-1571 — old payloads and old sales", () => {
  it("a sale without a discount stores none and reads without one, exactly as before", async () => {
    if (skip()) return;
    const res = await post(captureBody({ externalId: `${PREFIX}plain` }), "rt1571plain");
    expect(res.status).toBe(201);
    expectValid(validateSale, res.body);
    for (const line of res.body.lines) expect(line).not.toHaveProperty("discount");
    expect(await stored("plain")).toEqual([NONE, NONE]);
    for (const line of (await historyLines(res.body.saleRef))!) expect(line).not.toHaveProperty("discount");
  });

  it("a discounted line captured before 0134 (nothing stored) reads with no discount: not recorded", async () => {
    if (skip()) return;
    const res = await post(discountedSale("legacy"), "rt1571legacy");
    expect(res.status).toBe(201);
    // Stand in for a pre-0134 row: the net was kept, the discount facts were not.
    await h.harness!.env.admin.query(
      `UPDATE sale_lines SET discount_kind = NULL, discount_value = NULL, discount_amount = NULL,
              discount_reason_code = NULL, discount_authority_source = NULL, discount_approver_role = NULL,
              discount_approver_user_id = NULL
        WHERE sale_id = $1`,
      [res.body.saleRef],
    );
    const legacy = await read(res.body.saleRef);
    expect(legacy.status).toBe(200);
    expectValid(validateSale, legacy.body);
    expect(legacy.body.lines[0]).not.toHaveProperty("discount");
    expect(legacy.body.lines[0].lineAmount).toBe("81.0000");
    expect((await historyLines(res.body.saleRef))![0]).not.toHaveProperty("discount");
  });
});

describe("RT-1571 — retries never rewrite the stored discount", () => {
  it("a provenance replay under a new key returns the first capture's discount", async () => {
    if (skip()) return;
    const first = await post(discountedSale("replay"), "rt1571replay1");
    expect(first.status).toBe(201);
    const replay = await post(discountedSale("replay"), "rt1571replay2");
    expect(replay.status).toBe(200);
    expect(replay.body.saleRef).toBe(first.body.saleRef);
    expect(replay.body.lines).toEqual(first.body.lines);
    expect(await stored("replay")).toEqual([PERCENT_ROW, AMOUNT_ROW]);
  });

  it("a same-key retry is the stored response", async () => {
    if (skip()) return;
    const first = await post(discountedSale("samekey"), "rt1571samekey");
    expect(first.status).toBe(201);
    const retry = await post(discountedSale("samekey"), "rt1571samekey");
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(await stored("samekey")).toEqual([PERCENT_ROW, AMOUNT_ROW]);
  });

  it("a replay that changes the reason or the approver is 409 and the stored facts stay", async () => {
    if (skip()) return;
    const first = await post(discountedSale("changed"), "rt1571changed1");
    expect(first.status).toBe(201);
    const changed = discountedSale("changed");
    (changed["lines"] as Array<Record<string, unknown>>)[0]!["discount"] = {
      ...PERCENT,
      reasonCode: "price_correction",
      approverUserId: DEVICE_USER_ID,
    };
    const replay = await post(changed, "rt1571changed2");
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("idempotency_key_conflict");
    const sameKey = await post(changed, "rt1571changed1");
    expect(sameKey.status).toBe(409);
    expect(await stored("changed")).toEqual([PERCENT_ROW, AMOUNT_ROW]);
  });
});

describe("RT-1571 — late sync and processing", () => {
  it("a sale rung days before it synced keeps its discount", async () => {
    if (skip()) return;
    const res = await post(discountedSale("late", { occurredAt: "2026-04-20T08:00:00.000Z" }), "rt1571late");
    expect(res.status).toBe(201);
    expect(await stored("late")).toEqual([PERCENT_ROW, AMOUNT_ROW]);
  });

  it("a sale the worker has marked synced still reads its discount", async () => {
    if (skip()) return;
    const res = await post(discountedSale("synced"), "rt1571synced");
    expect(res.status).toBe(201);
    // The off-request drain advances only the header's sync status; the line facts are never written again.
    await h.harness!.env.admin.query(`UPDATE sales SET sync_status = 'synced', processed_at = now() WHERE id = $1`, [
      res.body.saleRef,
    ]);
    const after = await read(res.body.saleRef);
    expect(after.body.syncStatus).toBe("synced");
    expect(after.body.lines.map((l: { discount?: unknown }) => l.discount)).toEqual([PERCENT_READ, AMOUNT_READ]);
  });
});

describe("RT-1571 — returns", () => {
  beforeEach(() => enableReturns());

  it("a partial and then a full return leave the line's discount on the read", async () => {
    if (skip()) return;
    const cap = await post(discountedSale("ret"), "rt1571ret");
    expect(cap.status).toBe(201);
    const lineRef = cap.body.lines[0].lineRef as string;
    const half = await postReturn(h, cap.body.saleRef, returnBody(`${PREFIX}ret-r1`, [{ lineRef, quantity: "1" }], "40.50"), "rt1571retr1");
    expect(half.status).toBe(201);
    const rest = await postReturn(h, cap.body.saleRef, returnBody(`${PREFIX}ret-r2`, [{ lineRef, quantity: "1" }], "40.50"), "rt1571retr2");
    expect(rest.status).toBe(201);
    const after = await read(cap.body.saleRef);
    expect(after.status).toBe(200);
    expectValid(validateSale, after.body);
    expect(after.body.lines[0]).toMatchObject({ returnedQuantity: "2.000000", discount: PERCENT_READ });
    expect(await stored("ret")).toEqual([PERCENT_ROW, AMOUNT_ROW]);
    const history = await historyLines(cap.body.saleRef);
    expect(history![0]!.returnedQuantity).toBe("2.000000");
    expect(history![0]!.discount?.reasonCode).toBe("loyal_or_contract_customer");
  });
});

describe("RT-1571 — history and console detail (least disclosure)", () => {
  it("return the discount without the approver's user id, validating against SaleHistoryLine", async () => {
    if (skip()) return;
    const res = await post(discountedSale("history"), "rt1571history");
    expect(res.status).toBe(201);
    const lines = (await historyLines(res.body.saleRef))!;
    const { approverUserId: _id, ...percentWithoutId } = PERCENT_READ;
    expect(lines.map((l) => l.discount)).toEqual([percentWithoutId, AMOUNT_READ]);
    for (const line of lines) {
      expectValid(validateHistoryLine, line);
      expect(JSON.stringify(line)).not.toContain(APPROVER);
    }
  });
});

describe("RT-1571 — tenant isolation", () => {
  it("another tenant cannot read the stored discount, nor the sale's history", async () => {
    if (skip()) return;
    const res = await post(discountedSale("rls"), "rt1571rls");
    expect(res.status).toBe(201);
    const probe = (tenantId: string) =>
      runWithTenantContext(h.harness!.env.app, { tenantId, isPlatformAdmin: false }, (c) =>
        c.query(`SELECT 1 FROM sale_lines WHERE discount_approver_user_id = $1`, [APPROVER]),
      );
    expect((await probe(TENANT_B)).rowCount).toBe(0);
    expect((await probe(TENANT_A)).rowCount).toBe(1);
    expect(await historyLines(res.body.saleRef, TENANT_B)).toBeNull();
  });
});
