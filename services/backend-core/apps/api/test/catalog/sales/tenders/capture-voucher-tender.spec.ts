/**
 * RT-1114 (RT-1098 R-4a) — the `voucher` tender end to end against a real
 * RLS-forced Postgres, on the RT-77 capture harness.
 *
 *   - acceptance 2: with the voucher gate OFF (the default) a voucher tender is
 *     a 400 and nothing is recorded;
 *   - gate on: a voucher tender naming a live redemption of this tenant and
 *     store, for exactly its amount, is recorded with its `redemption_id`, read
 *     back as `redemptionId`, and the response validates against `Sale`;
 *   - acceptance 1: Σ tenders = posTotal still holds exactly (422
 *     `sale_tender_mismatch`), and a voucher tender whose redemption is
 *     unknown, of another store, of another tenant, reversed, already used by
 *     another sale, in another currency or for another amount is one 422
 *     `sale_voucher_tender_invalid`, with nothing recorded;
 *   - a replay compares the redemption too: the same body replays (200), a
 *     different `redemptionId` is a 409;
 *   - the posting feed's sale_post carries the voucher tender and its
 *     `redemptionId` (acceptance 2: never offered without its tenders).
 */
import { resolve } from "node:path";

import { runWithTenantContext } from "@data-pulse-2/db";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { buildWorkItem } from "../../../../src/catalog/erpnext-posting/posting-work-item.projection";
import { loadOpenApiContracts } from "../../../../src/openapi/loader";
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  HARNESS_DEVICE_ID,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
  type HarnessHandle,
} from "../capture/__capture-harness";

const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
const VOUCHER_FLAG = "POS_SALE_VOUCHER_TENDER_ENABLED";
const h: HarnessHandle = { harness: null, dockerSkipped: false };

const id = (n: string): string => `01140000-0000-7000-8000-0000000${n}`;
const DEVICE_A_Y = id("0d0a2");
const DEVICE_B_X = id("0d0b1");
const ACTOR = id("0a0a1");
const BATCH = id("0a0b1");
const ATTEMPT = id("0a0f1");
const MISSING = id("0f0f9");

/** Each a redemption of its own voucher (decision 1A: one open redemption per voucher). */
const R_OK = id("0e001");
const R_REPLAY = id("0e002");
const R_USED = id("0e003");
const R_FEED = id("0e004");
const R_REVERSED = id("0e005");
const R_OTHER_STORE = id("0e006");
const R_OTHER_TENANT = id("0e007");
const R_OTHER_CURRENCY = id("0e008");
const R_OTHER_AMOUNT = id("0e009");

const SALES_DIR = resolve(__dirname, "..", "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "pos-sales");

function saleValidator(): ValidateFunction {
  const contract = loadOpenApiContracts({ dir: SALES_DIR }).find((c) => c.id === "sales");
  if (!contract) throw new Error("pos-sales/sales.yaml not found");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(contract.document as object), $id: "sales" });
  return ajv.compile({ $ref: "sales#/components/schemas/Sale" });
}
const validateSale = saleValidator();

function expectValidSale(body: unknown): void {
  const ok = validateSale(body);
  expect(validateSale.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

interface RedemptionSeed {
  readonly id: string;
  readonly tenant: string;
  readonly store: string;
  readonly device: string;
  readonly currency?: string;
  readonly appliedMinor?: number;
  readonly reversed?: boolean;
}

/** A voucher, its consumed intent and its redemption, written as the superuser. */
async function seedRedemption(seed: RedemptionSeed): Promise<void> {
  const a = h.harness!.env.admin;
  const voucher = seed.id.replace(/0e(\d{3})$/, "0c$1");
  const intent = seed.id.replace(/0e(\d{3})$/, "0d$1");
  const hex = seed.id.slice(-2);
  const applied = seed.appliedMinor ?? 1000;
  await a.query(
    `INSERT INTO vouchers (id, tenant_id, batch_id, code_hash, amount_minor, currency_code, applies_to_all_stores, issued_by_user_id, status)
     VALUES ($1, $2, $3, decode(repeat($4, 32), 'hex'), $5, $6, true, $7, $8)`,
    [voucher, seed.tenant, BATCH, hex, applied, seed.currency ?? "USD", ACTOR, seed.reversed ? "active" : "redeemed"],
  );
  await a.query(
    `INSERT INTO voucher_redemption_intents
       (id, tenant_id, store_id, voucher_id, payment_attempt_id, applied_amount_minor, forfeited_amount_minor,
        token_hash, operator_user_id, device_id, expires_at, consumed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, decode(repeat($7, 32), 'hex'), $8, $9, now() + interval '4 minutes', now())`,
    [intent, seed.tenant, seed.store, voucher, ATTEMPT, applied, hex, ACTOR, seed.device],
  );
  await a.query(
    `INSERT INTO voucher_redemptions
       (id, tenant_id, store_id, voucher_id, intent_id, payment_attempt_id, applied_amount_minor, forfeited_amount_minor,
        operator_user_id, device_id, reversed_at, reversed_by_device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9,
             CASE WHEN $10 THEN now() END, CASE WHEN $10 THEN $9::uuid END)`,
    [seed.id, seed.tenant, seed.store, voucher, intent, ATTEMPT, applied, ACTOR, seed.device, seed.reversed === true],
  );
}

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
  if (!h.harness) return;
  const a = h.harness.env.admin;
  await a.query(
    `INSERT INTO devices (id, tenant_id, store_id, token_hash)
     VALUES ($1, $2, $3, decode(repeat('e2', 32), 'hex')), ($4, $5, $6, decode(repeat('e3', 32), 'hex'))`,
    [DEVICE_A_Y, TENANT_A, STORE_A_Y, DEVICE_B_X, TENANT_B, STORE_B_X],
  );
  const inA = { tenant: TENANT_A, store: STORE_A_X, device: HARNESS_DEVICE_ID };
  for (const r of [R_OK, R_REPLAY, R_USED, R_FEED]) await seedRedemption({ id: r, ...inA });
  await seedRedemption({ id: R_REVERSED, ...inA, reversed: true });
  await seedRedemption({ id: R_OTHER_STORE, tenant: TENANT_A, store: STORE_A_Y, device: DEVICE_A_Y });
  await seedRedemption({ id: R_OTHER_TENANT, tenant: TENANT_B, store: STORE_B_X, device: DEVICE_B_X });
  await seedRedemption({ id: R_OTHER_CURRENCY, ...inA, currency: "EGP" });
  await seedRedemption({ id: R_OTHER_AMOUNT, ...inA, appliedMinor: 900 });
}, 180_000);
afterAll(async () => {
  delete process.env[TENDERS_FLAG];
  delete process.env[VOUCHER_FLAG];
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  process.env[TENDERS_FLAG] = "true";
  process.env[VOUCHER_FLAG] = "true";
});
afterEach(async () => {
  delete process.env[TENDERS_FLAG];
  delete process.env[VOUCHER_FLAG];
  if (!h.harness) return;
  const q = (sql: string) => h.harness!.env.admin.query(sql);
  const sales = "SELECT id FROM sales WHERE source_system = 'pos-1'";
  await q(`DELETE FROM sale_tenders WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_lines WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sales WHERE source_system = 'pos-1'`);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

// captureBody() posts posTotal 12.5000 USD: 2.50 cash + a 10.00 voucher.
const tenders = (redemptionId: string, voucherAmount = "10") => [
  { method: "cash", amount: "2.5" },
  { method: "voucher", amount: voucherAmount, redemptionId },
];

function post(body: Record<string, unknown>, key: string) {
  return h.harness!.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(key)).send(body);
}

async function salesWith(externalId: string): Promise<number> {
  const r = await h.harness!.env.admin.query(`SELECT 1 FROM sales WHERE external_id = $1`, [externalId]);
  return r.rowCount ?? 0;
}

const code = (res: { body: { error?: { code?: string }; code?: string } }): string | undefined =>
  res.body.error?.code ?? res.body.code;

describe("RT-1114 — acceptance 2: the voucher gate is off by default", () => {
  it("refuses a voucher tender with 400 while POS_SALE_VOUCHER_TENDER_ENABLED is unset, and records nothing", async () => {
    if (skip()) return;
    delete process.env[VOUCHER_FLAG];
    const res = await post(captureBody({ externalId: "rt1114-off", tenders: tenders(R_OK) }), "rt1114off");
    expect(res.status).toBe(400);
    expect(await salesWith("rt1114-off")).toBe(0);
  });
});

describe("RT-1114 — a valid voucher tender (gate on)", () => {
  it("is recorded with its redemption and read back as redemptionId", async () => {
    if (skip()) return;
    const res = await post(captureBody({ externalId: "rt1114-ok", tenders: tenders(R_OK) }), "rt1114ok");
    expect(res.status).toBe(201);
    expect(res.body.tenders).toEqual([
      { method: "cash", amount: "2.5000" },
      { method: "voucher", amount: "10.0000", redemptionId: R_OK },
    ]);
    expectValidSale(res.body);
    const rows = await h.harness!.env.admin.query<{ method: string; redemption_id: string | null }>(
      `SELECT method, redemption_id FROM sale_tenders WHERE sale_id = $1 ORDER BY method`,
      [res.body.saleRef],
    );
    expect(rows.rows).toEqual([
      { method: "cash", redemption_id: null },
      { method: "voucher", redemption_id: R_OK },
    ]);

    const read = await h.harness!.http().get(`/api/pos/v1/sales/${res.body.saleRef}`);
    expect(read.status).toBe(200);
    expect(read.body.tenders).toEqual(res.body.tenders);
    expectValidSale(read.body);
  });

  it("acceptance 1: Σ tenders = posTotal still holds exactly (422 sale_tender_mismatch)", async () => {
    if (skip()) return;
    const res = await post(captureBody({ externalId: "rt1114-sum", tenders: tenders(R_OK, "9.99") }), "rt1114sum");
    expect(res.status).toBe(422);
    expect(code(res)).toBe("sale_tender_mismatch");
    expect(await salesWith("rt1114-sum")).toBe(0);
  });

  it("a replay of the same body is the same sale (200); a different redemptionId is a 409", async () => {
    if (skip()) return;
    const body = captureBody({ externalId: "rt1114-rep", tenders: tenders(R_REPLAY) });
    const first = await post(body, "rt1114rep1");
    expect(first.status).toBe(201);
    const again = await post(body, "rt1114rep2");
    expect(again.status).toBe(200);
    expect(again.body.saleRef).toBe(first.body.saleRef);
    const changed = await post(captureBody({ externalId: "rt1114-rep", tenders: tenders(R_OK) }), "rt1114rep3");
    expect(changed.status).toBe(409);
  });
});

describe("RT-1114 — acceptance 1: a voucher tender without a valid redemption is refused", () => {
  it.each([
    ["does not exist", MISSING],
    ["is of another store of the tenant", R_OTHER_STORE],
    ["is of another tenant", R_OTHER_TENANT],
    ["is reversed", R_REVERSED],
    ["is for a voucher in another currency", R_OTHER_CURRENCY],
    ["was applied for another amount", R_OTHER_AMOUNT],
  ])("a redemption that %s → 422 sale_voucher_tender_invalid, nothing recorded", async (label, redemption) => {
    if (skip()) return;
    const ext = `rt1114-bad-${label.replace(/\W+/g, "-")}`;
    const res = await post(captureBody({ externalId: ext, tenders: tenders(redemption) }), ext.slice(-20));
    expect(res.status).toBe(422);
    expect(code(res)).toBe("sale_voucher_tender_invalid");
    expect(await salesWith(ext)).toBe(0);
  });

  it("a redemption that already pays another sale's tender → 422, and the first sale is unchanged", async () => {
    if (skip()) return;
    const first = await post(captureBody({ externalId: "rt1114-used-1", tenders: tenders(R_USED) }), "rt1114used1");
    expect(first.status).toBe(201);
    const second = await post(captureBody({ externalId: "rt1114-used-2", tenders: tenders(R_USED) }), "rt1114used2");
    expect(second.status).toBe(422);
    expect(code(second)).toBe("sale_voucher_tender_invalid");
    expect(await salesWith("rt1114-used-2")).toBe(0);
    expect(await salesWith("rt1114-used-1")).toBe(1);
  });
});

describe("RT-1114 — the posting feed carries the voucher tender", () => {
  it("offers the sale_post with its voucher tender and redemptionId", async () => {
    if (skip()) return;
    const cap = await post(captureBody({ externalId: "rt1114-feed", tenders: tenders(R_FEED) }), "rt1114feed");
    expect(cap.status).toBe(201);
    const saleRef = cap.body.saleRef as string;
    const item = await runWithTenantContext(
      h.harness!.env.app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      (client) =>
        buildWorkItem(client, {
          id: "01140000-0000-7000-8000-0000000b1114",
          kind: "sale_post",
          saleId: saleRef,
          sourceRefId: saleRef,
          sourceSystem: "pos-1",
          externalId: "rt1114-provenance",
          payloadHash: "a".repeat(64),
          sequence: "1",
        }),
    );
    expect(item!.sale.tenders).toEqual([
      { method: "cash", amount: "2.5000" },
      { method: "voucher", amount: "10.0000", redemptionId: R_FEED },
    ]);
  });
});
