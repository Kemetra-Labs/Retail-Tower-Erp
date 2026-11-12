/**
 * void-voucher-tender.spec.ts — RT-1343 item 3 (owner decision 2026-11-12): a
 * full void of a completed voucher-paid sale RESTORES the voucher.
 *
 * On the RT-77 capture harness, against a real RLS-forced Postgres:
 *   - the void reverses the redemption of the sale's `voucher` tender (reversed
 *     by the void's device) and the voucher is `active` again, with one
 *     `voucher.reversed` audit row naming the sale (the loop over several
 *     voucher tenders is a unit spec: more than one tender of a method needs
 *     tender refs and a deploy flag the harness does not set);
 *   - a replay of the void (the same provenance under a new Idempotency-Key)
 *     answers 200, reverses nothing again and audits nothing again;
 *   - fail closed: a voucher that is not `redeemed` under an open redemption
 *     fails the void, and nothing is recorded (no void, redemption unchanged);
 *   - the sale's tender rows are never mutated (append-only, §X).
 *
 * The HTTP reverse of a captured redemption is refused (409) in
 * `vouchers-pos.http.integration.spec.ts`.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  approvedVoid,
  HARNESS_DEVICE_ID,
  STORE_A_X,
  TENANT_A,
  type HarnessHandle,
} from "../capture/__capture-harness";
import { seedRedemption, voucherIdOf } from "../__support__/voucher-redemption-seed";

const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
const VOUCHER_FLAG = "POS_SALE_VOUCHER_TENDER_ENABLED";
const h: HarnessHandle = { harness: null, dockerSkipped: false };

const id = (n: string): string => `01343000-0000-7000-8000-0000000${n}`;
const ACTOR = id("0a0a1");
const BATCH = id("0a0b1");
const ATTEMPT = id("0a0f1");

const R_ONE = id("0e001");
const R_REPLAY = id("0e002");
const R_BROKEN = id("0e003");

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
  if (!h.harness) return;
  const base = { tenant: TENANT_A, store: STORE_A_X, device: HARNESS_DEVICE_ID, batch: BATCH, cashier: ACTOR, attempt: ATTEMPT };
  for (const r of [R_ONE, R_REPLAY, R_BROKEN]) await seedRedemption(h.harness.env.admin, { ...base, id: r });
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
  await q("DELETE FROM sale_voids WHERE source_system = 'pos-1'");
  // RT-577 (0054): the shared approval-use ledger the sale_voids trigger fills.
  await q("DELETE FROM sale_approval_uses");
  await q(`DELETE FROM sale_tenders WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_lines WHERE sale_id IN (${sales})`);
  await q("DELETE FROM sales WHERE source_system = 'pos-1'");
});

const skip = (): boolean => h.dockerSkipped || !h.harness;
const admin = () => h.harness!.env.admin;

// captureBody() posts posTotal 12.5000 USD: 2.50 cash + a 10.00 voucher.
const oneVoucher = (redemptionId: string) => [
  { method: "cash", amount: "2.5" },
  { method: "voucher", amount: "10", redemptionId },
];

async function capture(externalId: string, tenders: ReadonlyArray<object>): Promise<string> {
  const res = await h
    .harness!.http()
    .post("/api/pos/v1/sales")
    .set("Idempotency-Key", idempKey(`cap${externalId}`))
    .send(captureBody({ externalId, tenders }));
  expect(res.status).toBe(201);
  return res.body.saleRef as string;
}

async function voidSale(saleRef: string, externalId: string, key: string, body?: Record<string, unknown>) {
  return h
    .harness!.http()
    .post(`/api/pos/v1/sales/${saleRef}/void`)
    .set("Idempotency-Key", idempKey(key))
    .send(body ?? (await approvedVoid(h, saleRef, { body: { externalId } })));
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
  const r = await admin().query<{ actor_user_id: string; store_id: string; metadata: Record<string, unknown> }>(
    `SELECT actor_user_id, store_id, metadata FROM audit_events
      WHERE action = 'voucher.reversed' AND metadata->>'redemption_id' = $1`,
    [redemptionId],
  );
  return r.rows;
}

describe("RT-1343 item 3 — a full void restores the voucher", () => {
  it("reverses the redemption of the voucher tender, by the void's device; the voucher is active again", async () => {
    if (skip()) return;
    const saleRef = await capture("rt1343-void-one", oneVoucher(R_ONE));
    expect(await redemption(R_ONE)).toMatchObject({ reversed_at: null, status: "redeemed" });

    const res = await voidSale(saleRef, "rt1343-void-one-evt", "rt1343v1");
    expect(res.status).toBe(201);
    expect(res.body.kind).toBe("void");

    const after = await redemption(R_ONE);
    expect(after.status).toBe("active");
    expect(after.reversed_at).not.toBeNull();
    expect(after.reversed_by_device_id).toBe(HARNESS_DEVICE_ID);

    // One audit row, attributed to the redeem-time cashier, naming the voided sale and the device.
    const audits = await reversedAudits(R_ONE);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_user_id: ACTOR,
      store_id: STORE_A_X,
      metadata: {
        voucher_id: voucherIdOf(R_ONE),
        redemption_id: R_ONE,
        reversed_by_device_id: HARNESS_DEVICE_ID,
        sale_id: saleRef,
      },
    });

    // The sale is append-only: its tenders are untouched, still naming the (now reversed) redemption.
    const tenders = await admin().query<{ method: string; redemption_id: string | null }>(
      `SELECT method, redemption_id FROM sale_tenders WHERE sale_id = $1 ORDER BY method`,
      [saleRef],
    );
    expect(tenders.rows).toEqual([
      { method: "cash", redemption_id: null },
      { method: "voucher", redemption_id: R_ONE },
    ]);
  });

  it("a replay of the void (same provenance, new Idempotency-Key) reverses nothing again", async () => {
    if (skip()) return;
    const saleRef = await capture("rt1343-void-replay", oneVoucher(R_REPLAY));
    // One body, sent twice: a re-delivery carries the same provenance and the same approval.
    const body = await approvedVoid(h, saleRef, { body: { externalId: "rt1343-void-replay-evt" } });
    const first = await voidSale(saleRef, "rt1343-void-replay-evt", "rt1343r1", body);
    expect(first.status).toBe(201);
    const afterFirst = await redemption(R_REPLAY);
    expect(afterFirst.reversed_at).not.toBeNull();

    const again = await voidSale(saleRef, "rt1343-void-replay-evt", "rt1343r2", body);
    expect(again.status).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body.eventRef).toBe(first.body.eventRef);

    const afterAgain = await redemption(R_REPLAY);
    expect(afterAgain.reversed_at).toEqual(afterFirst.reversed_at);
    expect(afterAgain.status).toBe("active");
    expect(await reversedAudits(R_REPLAY)).toHaveLength(1);
    const voids = await admin().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_voids WHERE external_id = 'rt1343-void-replay-evt'`,
    );
    expect(voids.rows[0]?.n).toBe("1");
  });

  it("fails closed: a voucher that is not redeemed under an open redemption fails the void and records nothing", async () => {
    if (skip()) return;
    const saleRef = await capture("rt1343-void-broken", oneVoucher(R_BROKEN));
    // A broken invariant: the voucher is already `active` behind an open redemption (a `cancelled`
    // one needs cancelled_at and cancelled_by_user_id by the 0091 CHECK).
    await admin().query(`UPDATE vouchers SET status = 'active' WHERE id = $1`, [voucherIdOf(R_BROKEN)]);

    const res = await voidSale(saleRef, "rt1343-void-broken-evt", "rt1343b1");
    expect(res.status).toBe(500);

    const voids = await admin().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sale_voids WHERE external_id = 'rt1343-void-broken-evt'`,
    );
    expect(voids.rows[0]?.n).toBe("0");
    const after = await redemption(R_BROKEN);
    expect(after.reversed_at).toBeNull();
    expect(after.status).toBe("active");
    expect(await reversedAudits(R_BROKEN)).toHaveLength(0);
  });
});
