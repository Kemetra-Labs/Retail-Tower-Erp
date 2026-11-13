/**
 * RT-1343 item 2 — a credit `void` of a voucher-paid credit sale (owner
 * decision 2026-11-12: a full void RESTORES the voucher).
 *
 * `recordCreditSaleReversal` end to end against a real RLS-forced Postgres
 * (the capture harness). Contract: `pos-sales/sales.yaml` 1.24.0-draft,
 * `CreditReversalRefundTender.method` gains `voucher`; migration 0107.
 *   - a credit void mirrors the voucher tender with a `voucher` refund tender
 *     (201, response valid against the contract), reverses the redemption by
 *     the requesting device, and the voucher is `active` again, with one
 *     `voucher.reversed` audit row naming the sale and the void's operator;
 *   - a replay restores nothing again;
 *   - a cash refund in place of the voucher is 422
 *     `credit_reversal_refund_mismatch`, and the voucher stays spent;
 *   - a voucher refund tender carrying a `reference` is 400.
 */
import { resolve } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { loadOpenApiContracts } from "../../../../src/openapi/loader";
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  HARNESS_DEVICE_ID,
  STORE_A_X,
  TENANT_A,
  type HarnessHandle,
} from "../capture/__capture-harness";
import { seedRedemption, voucherIdOf } from "../__support__/voucher-redemption-seed";
import { APPROVER_MANAGER, APPROVER_OWNER, APPROVER_TENANT_ADMIN } from "../__support__/void-approval-fixture";

const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
const VOUCHER_FLAG = "POS_SALE_VOUCHER_TENDER_ENABLED";
const h: HarnessHandle = { harness: null, dockerSkipped: false };

const id = (n: string): string => `01343200-0000-7000-8000-0000000${n}`;
const PAYER = id("0a0a2");
const CASHIER = id("0a0a3");
const BATCH = id("0a0b2");
const ATTEMPT = id("0a0f2");
const R_VOID = id("0e101");
const R_MISMATCH = id("0e102");
const R_REPLAY = id("0e103");

const SALES_DIR = resolve(__dirname, "..", "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "pos-sales");

function reversalValidator(): ValidateFunction {
  const contract = loadOpenApiContracts({ dir: SALES_DIR }).find((c) => c.id === "sales");
  if (!contract) throw new Error("pos-sales/sales.yaml not found");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(contract.document as object), $id: "sales" });
  return ajv.compile({ $ref: "sales#/components/schemas/CreditSaleReversal" });
}
const validateReversal = reversalValidator();

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
  if (!h.harness) return;
  const admin = h.harness.env.admin;
  await admin.query(
    `INSERT INTO payer_account (id, tenant_id, store_id, category, display_name, external_ref, status)
     VALUES ($1, $2, $3, 'corporate', 'RT-1343 corp', 'CUST-1343', 'active')`,
    [PAYER, TENANT_A, STORE_A_X],
  );
  const base = { tenant: TENANT_A, store: STORE_A_X, device: HARNESS_DEVICE_ID, batch: BATCH, cashier: CASHIER, attempt: ATTEMPT };
  // The sale: 12.50 = a 2.50 voucher + 10.00 on credit.
  for (const r of [R_VOID, R_MISMATCH, R_REPLAY]) await seedRedemption(admin, { ...base, id: r, appliedMinor: 250 });
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
  if (h.harness) h.harness.contextGuard.userId = APPROVER_TENANT_ADMIN;
});
afterEach(async () => {
  delete process.env[TENDERS_FLAG];
  delete process.env[VOUCHER_FLAG];
  if (!h.harness) return;
  const sales = "SELECT id FROM sales WHERE source_system = 'pos-1'";
  for (const sql of [
    `DELETE FROM sale_credit_reversal_tenders`,
    `DELETE FROM sale_credit_reversals`,
    `DELETE FROM sale_approval_uses`,
    `DELETE FROM sale_voids WHERE sale_id IN (${sales})`,
    `DELETE FROM sale_responsibilities WHERE sale_id IN (${sales})`,
    `DELETE FROM sale_tenders WHERE sale_id IN (${sales})`,
    `DELETE FROM sale_lines WHERE sale_id IN (${sales})`,
    `DELETE FROM sales WHERE source_system = 'pos-1'`,
    `DELETE FROM outbox_events`,
  ]) {
    await h.harness.env.admin.query(sql);
  }
});

const skip = (): boolean => h.dockerSkipped || !h.harness;
const admin = () => h.harness!.env.admin;
let keySeq = 0;
const nextKey = (): string => idempKey(`rt1343c${(keySeq += 1)}`);
let approvalSeq = 0;
const nextApprovalId = (): string => `01343200-0000-7000-8000-${(0x5000000000 + (approvalSeq += 1)).toString(16).padStart(12, "0")}`;

type Body = Record<string, unknown>;

/** Capture the voucher + credit sale as the store manager (the seller), then restore the actor. */
async function captureVoucherCreditSale(externalId: string, redemptionId: string): Promise<string> {
  const harness = h.harness!;
  const actor = harness.contextGuard.userId;
  harness.contextGuard.userId = APPROVER_MANAGER;
  const body = captureBody({
    externalId,
    tenders: [{ method: "voucher", amount: "2.5", redemptionId }],
    responsibilities: [{ payerRef: PAYER, amount: "10", sequence: 1 }],
  });
  const res = await harness.http().post("/api/pos/v1/sales").set("Idempotency-Key", nextKey()).send(body);
  harness.contextGuard.userId = actor;
  if (res.status !== 201) throw new Error(`capture failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.saleRef as string;
}

async function creditVoidBody(saleRef: string, externalId: string, refundTenders: ReadonlyArray<Body>): Promise<Body> {
  const r = await admin().query<{ amount: string; business_date: string }>(
    `SELECT pos_total::text AS amount, business_date::text AS business_date FROM sales WHERE id = $1`,
    [saleRef],
  );
  const facts = r.rows[0]!;
  return {
    sourceSystem: "pos-1",
    externalId,
    kind: "void",
    refundTenders,
    reason: "customer cancelled the order",
    businessDate: facts.business_date,
    approval: {
      approvalId: nextApprovalId(),
      action: "sale.void",
      saleRef,
      amount: facts.amount,
      requesterUserId: h.harness!.contextGuard.userId,
      approverUserId: APPROVER_OWNER,
      policyVersion: "rt114-2026-10-07",
      approvedAt: new Date().toISOString(),
    },
  };
}

function post(saleRef: string, body: Body, key = nextKey()) {
  return h.harness!.http().post(`/api/pos/v1/sales/${saleRef}/credit-reversals`).set("Idempotency-Key", key).send(body);
}

async function redemption(redemptionId: string) {
  const r = await admin().query<{ reversed_at: Date | null; reversed_by_device_id: string | null; status: string }>(
    `SELECT r.reversed_at, r.reversed_by_device_id, v.status
       FROM voucher_redemptions r JOIN vouchers v ON v.tenant_id = r.tenant_id AND v.id = r.voucher_id
      WHERE r.id = $1`,
    [redemptionId],
  );
  return r.rows[0]!;
}

async function reversedAudits(redemptionId: string) {
  const r = await admin().query<{ actor_user_id: string; metadata: Record<string, unknown> }>(
    `SELECT actor_user_id, metadata FROM audit_events WHERE action = 'voucher.reversed' AND metadata->>'redemption_id' = $1`,
    [redemptionId],
  );
  return r.rows;
}

const VOUCHER_REFUND = [{ method: "voucher", amount: "2.5" }];

describe("RT-1343 item 2 — a credit void of a voucher-paid credit sale restores the voucher", () => {
  it("mirrors the voucher tender, reverses the redemption by the requesting device, and audits the void's operator", async () => {
    if (skip()) return;
    const saleRef = await captureVoucherCreditSale("rt1343-cv-1", R_VOID);
    expect(await redemption(R_VOID)).toMatchObject({ reversed_at: null, status: "redeemed" });

    const res = await post(saleRef, await creditVoidBody(saleRef, "rt1343-cv-1-evt", VOUCHER_REFUND));
    expect(res.status).toBe(201);
    expect(validateReversal(res.body)).toBe(true);
    expect(res.body).toMatchObject({
      saleRef,
      kind: "void",
      refundableAmount: "2.5000",
      refundTenders: [{ method: "voucher", amount: "2.5000" }],
    });

    const after = await redemption(R_VOID);
    expect(after.status).toBe("active");
    expect(after.reversed_at).not.toBeNull();
    expect(after.reversed_by_device_id).toBe(HARNESS_DEVICE_ID);
    const audits = await reversedAudits(R_VOID);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id: APPROVER_TENANT_ADMIN,
      metadata: { voucher_id: voucherIdOf(R_VOID), redemption_id: R_VOID, reversed_by_device_id: HARNESS_DEVICE_ID, sale_id: saleRef },
    });
  });

  it("a replay (same provenance and payload) answers 200 and restores nothing again", async () => {
    if (skip()) return;
    const saleRef = await captureVoucherCreditSale("rt1343-cv-2", R_REPLAY);
    const body = await creditVoidBody(saleRef, "rt1343-cv-2-evt", VOUCHER_REFUND);
    expect((await post(saleRef, body)).status).toBe(201);
    const first = await redemption(R_REPLAY);

    const again = await post(saleRef, body);
    expect(again.status).toBe(200);
    expect(await redemption(R_REPLAY)).toEqual(first);
    expect(await reversedAudits(R_REPLAY)).toHaveLength(1);
  });

  it("refuses a cash refund in place of the voucher (422 credit_reversal_refund_mismatch); the voucher stays spent", async () => {
    if (skip()) return;
    const saleRef = await captureVoucherCreditSale("rt1343-cv-3", R_MISMATCH);
    const res = await post(saleRef, await creditVoidBody(saleRef, "rt1343-cv-3-evt", [{ method: "cash", amount: "2.5" }]));
    expect({ status: res.status, code: res.body.error?.code }).toEqual({ status: 422, code: "credit_reversal_refund_mismatch" });
    expect(await redemption(R_MISMATCH)).toMatchObject({ reversed_at: null, status: "redeemed" });
    const voids = await admin().query(`SELECT 1 FROM sale_voids WHERE sale_id = $1`, [saleRef]);
    expect(voids.rows).toHaveLength(0);
  });

  it("refuses a voucher refund tender carrying a reference with 400", async () => {
    if (skip()) return;
    const saleRef = await captureVoucherCreditSale("rt1343-cv-4", R_MISMATCH);
    const res = await post(
      saleRef,
      await creditVoidBody(saleRef, "rt1343-cv-4-evt", [{ method: "voucher", amount: "2.5", reference: "AB12" }]),
    );
    expect(res.status).toBe(400);
    expect(await redemption(R_MISMATCH)).toMatchObject({ reversed_at: null, status: "redeemed" });
  });
});
