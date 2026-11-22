/**
 * return-status-read.spec.ts — Jira RT-1548 slice 2: `readReturnStatusByProvenance`
 * (`GET /api/pos/v1/sales/{saleRef}/returns/by-provenance/status`) against a
 * real RLS-forced Postgres (db-integration, Testcontainers).
 *
 *   - an ordinary return reads `recorded` / `creditLinked: false` with the exact
 *     `recordReturn` projection; an unknown key on a readable sale is
 *     `not_recorded`; a key recorded on ANOTHER sale is `not_recorded` here;
 *   - a credit-sale reversal reads `recorded` / `creditLinked: true`, a zero
 *     cash refund included (an empty `refundTenders`), and every answer
 *     validates against the contract's `ReturnProvenanceStatus`;
 *   - another store, another tenant, an unknown and a malformed sale are one
 *     404, never a verdict; either gate off is the same 404;
 *   - the read records nothing, audits `pos_sales.return_read` ref-only, and
 *     never waits on the sale lock a `recordReturn` holds.
 */
import { resolve } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { loadOpenApiContracts } from "../../../../src/openapi/loader";
import {
  captureBody,
  idempKey,
  resetHarness,
  SpyAuditEnqueuer,
  startCaptureHarness,
  stopCaptureHarness,
  STORE_A_X,
  STORE_A_Y,
  TENANT_A,
  TENANT_B,
  type HarnessHandle,
} from "../capture/__capture-harness";
import { APPROVER_MANAGER, APPROVER_OWNER, APPROVER_TENANT_ADMIN } from "../__support__/void-approval-fixture";
import {
  captureOneLine,
  cleanReturnsFixtures,
  disableReturns,
  enableReturns,
  postReturn,
  returnBody,
} from "./__returns-support";

const spy = new SpyAuditEnqueuer();
const h: HarnessHandle = { harness: null, dockerSkipped: false };
const READ_FLAG = "POS_RETURN_STATUS_READ_ENABLED";
const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
const PAYER = "0a000000-0000-7000-8000-0000005481a1";

const SALES_DIR = resolve(__dirname, "..", "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "pos-sales");

function statusValidator(): ValidateFunction {
  const contract = loadOpenApiContracts({ dir: SALES_DIR }).find((c) => c.id === "sales");
  if (!contract) throw new Error("pos-sales/sales.yaml not found");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(contract.document as object), $id: "sales" });
  return ajv.compile({ $ref: "sales#/components/schemas/ReturnProvenanceStatus" });
}
const validateStatus = statusValidator();

function expectValidVerdict(body: unknown): void {
  const ok = validateStatus(body);
  expect(validateStatus.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness({ auditEnqueuer: spy }));
  if (!h.harness) return;
  await h.harness.env.admin.query(
    `INSERT INTO payer_account (id, tenant_id, store_id, category, display_name, external_ref, status)
     VALUES ($1, $2, $3, 'corporate', 'RT-1548 corp', 'CUST-1548', 'active')`,
    [PAYER, TENANT_A, STORE_A_X],
  );
}, 180_000);
afterAll(async () => {
  delete process.env[READ_FLAG];
  delete process.env[TENDERS_FLAG];
  disableReturns();
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  spy.reset();
  enableReturns();
  process.env[READ_FLAG] = "true";
  process.env[TENDERS_FLAG] = "true";
});
afterEach(async () => {
  if (!h.harness) return;
  const q = (sql: string) => h.harness!.env.admin.query(sql);
  await q("DELETE FROM sale_credit_reversal_tenders");
  await q("DELETE FROM sale_credit_reversals");
  await q("DELETE FROM sale_responsibilities");
  await cleanReturnsFixtures(h);
  await q("DELETE FROM outbox_events");
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

const status = (saleRef: string, key: { sourceSystem: string; externalId: string } | null) =>
  h
    .harness!.http()
    .get(`/api/pos/v1/sales/${saleRef}/returns/by-provenance/status`)
    .query(key ?? {});
const KEY = (externalId: string) => ({ sourceSystem: "pos-1", externalId });

const returnsRows = async (saleRef: string): Promise<number> =>
  Number(
    (await h.harness!.env.admin.query<{ n: string }>("SELECT count(*)::text AS n FROM sale_returns WHERE sale_id = $1", [saleRef]))
      .rows[0]!.n,
  );

const readAudits = () => spy.calls.filter((c) => c.action === "pos_sales.return_read");

// ---------------------------------------------------------------------------
// Ordinary returns
// ---------------------------------------------------------------------------
describe("RT-1548 readReturnStatusByProvenance — ordinary returns", () => {
  it("a return recorded by recordReturn reads recorded, creditLinked false, with the exact SaleReturn", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "st-ord", quantity: "2", lineAmount: "10.0000" });
    const posted = await postReturn(h, s.saleRef, returnBody("st-ord-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"), "stord1");
    expect(posted.status).toBe(201);
    const res = await status(s.saleRef, KEY("st-ord-r"));
    expect(res.status).toBe(200);
    expectValidVerdict(res.body);
    expect(res.body).toEqual({ status: "recorded", saleReturn: posted.body, creditLinked: false });
    expect(res.body).not.toHaveProperty("settlement");
  });

  it("an unknown key on a readable sale reads not_recorded, and the body holds only the status", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "st-none", quantity: "1", lineAmount: "5.0000" });
    const res = await status(s.saleRef, KEY("never-sent"));
    expect(res.status).toBe(200);
    expectValidVerdict(res.body);
    expect(res.body).toEqual({ status: "not_recorded" });
  });

  it("a key recorded on ANOTHER sale reads not_recorded for this sale, exactly like a key recorded nowhere", async () => {
    if (skip()) return;
    const a = await captureOneLine(h, { externalId: "st-x-a", quantity: "1", lineAmount: "5.0000" });
    const b = await captureOneLine(h, { externalId: "st-x-b", quantity: "1", lineAmount: "5.0000" });
    expect((await postReturn(h, a.saleRef, returnBody("st-x-key", [{ lineRef: a.lineRef, quantity: "1" }], "5.0000"), "stx1")).status).toBe(201);
    const onOther = await status(b.saleRef, KEY("st-x-key"));
    const nowhere = await status(b.saleRef, KEY("st-x-nowhere"));
    expect(onOther.status).toBe(200);
    expect(onOther.body).toEqual({ status: "not_recorded" });
    expect(onOther.body).toEqual(nowhere.body);
    // ...and the owning sale still reads it as recorded.
    expect((await status(a.saleRef, KEY("st-x-key"))).body.status).toBe("recorded");
  });

  it("reads change and record nothing", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "st-ro", quantity: "1", lineAmount: "5.0000" });
    const outboxBefore = await h.harness!.env.admin.query("SELECT count(*) FROM outbox_events");
    await status(s.saleRef, KEY("st-ro-key"));
    await status(s.saleRef, KEY("st-ro-key"));
    expect(await returnsRows(s.saleRef)).toBe(0);
    expect(await h.harness!.env.admin.query("SELECT count(*) FROM outbox_events")).toMatchObject({ rows: outboxBefore.rows });
  });

  it("a missing or incomplete query is the contract's 400", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "st-400", quantity: "1", lineAmount: "5.0000" });
    expect((await status(s.saleRef, null)).status).toBe(400);
    expect((await status(s.saleRef, { sourceSystem: "pos-1", externalId: "" })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Scope: a 404 is never a verdict
// ---------------------------------------------------------------------------
describe("RT-1548 readReturnStatusByProvenance — scope and gates", () => {
  async function recordedSale(tag: string): Promise<{ saleRef: string }> {
    const s = await captureOneLine(h, { externalId: `sc-${tag}`, quantity: "1", lineAmount: "5.0000" });
    expect((await postReturn(h, s.saleRef, returnBody(`sc-${tag}-r`, [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"), `sc${tag}`)).status).toBe(201);
    return s;
  }

  it("another store, another tenant, an unknown sale and a malformed sale ref are ONE 404, never a verdict", async () => {
    if (skip()) return;
    const s = await recordedSale("scope");
    const key = KEY("sc-scope-r");
    const inScope = await status(s.saleRef, key);
    expect(inScope.body.status).toBe("recorded");

    h.harness!.contextGuard.storeId = STORE_A_Y;
    const otherStore = await status(s.saleRef, key);
    resetHarness(h);
    h.harness!.contextGuard.tenantId = TENANT_B;
    const otherTenant = await status(s.saleRef, key);
    resetHarness(h);
    const unknown = await status("0a000000-0000-7000-8000-0000000fffff", key);
    const malformed = await status("not-a-uuid", key);

    for (const res of [otherStore, otherTenant, unknown, malformed]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
      expect(res.body).not.toHaveProperty("status");
    }
    expect(otherStore.body.error.message).toBe(unknown.body.error.message);
    expect(otherTenant.body.error.message).toBe(unknown.body.error.message);
  });

  it("an out-of-scope read of a key that is NOT recorded is still the 404, not not_recorded", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "sc-nr", quantity: "1", lineAmount: "5.0000" });
    h.harness!.contextGuard.storeId = STORE_A_Y;
    const res = await status(s.saleRef, KEY("sc-nr-never"));
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty("status");
  });

  it.each([
    ["g1", "POS_RETURNS_ENABLED is off", () => disableReturns()],
    ["g2", "the status-read rollout gate POS_RETURN_STATUS_READ_ENABLED is off", () => delete process.env[READ_FLAG]],
  ])("(%s) %s: 404 not_found, no verdict, the same body as an unknown sale", async (tag, _name, switchOff) => {
    if (skip()) return;
    const s = await recordedSale(tag);
    const key = KEY(`sc-${tag}-r`);
    expect((await status(s.saleRef, key)).status).toBe(200);
    switchOff();
    const off = await status(s.saleRef, key);
    const unknown = await status("0a000000-0000-7000-8000-0000000fffff", key);
    expect(off.status).toBe(404);
    expect(off.body).not.toHaveProperty("status");
    expect(off.body.error.code).toBe("not_found");
    expect(off.body.error.message).toBe(unknown.body.error.message);
  });

  it("the older read readReturnByProvenance is unchanged: not behind either gate", async () => {
    if (skip()) return;
    const s = await recordedSale("older");
    disableReturns();
    delete process.env[READ_FLAG];
    const res = await h
      .harness!.http()
      .get(`/api/pos/v1/sales/${s.saleRef}/returns/by-provenance`)
      .query(KEY("sc-older-r"));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Credit-sale reversals
// ---------------------------------------------------------------------------
interface CreditSale {
  readonly saleRef: string;
  readonly lineRefs: string[];
}

/** A credit sale captured as the store manager: cash `cash` + credit `credit` over two lines (5 and 7.5). */
async function captureCreditSale(externalId: string, opts: { cash?: string; credit: string }): Promise<CreditSale> {
  const harness = h.harness!;
  const actor = harness.contextGuard.userId;
  harness.contextGuard.userId = APPROVER_MANAGER;
  const lines = [
    { lineName: "Widget", unitPrice: "5.0000", lineAmount: "5.0000" },
    { lineName: "Gadget", unitPrice: "7.5000", lineAmount: "7.5000" },
  ];
  const body = captureBody({
    externalId,
    posTotal: "12.5000",
    lines: lines.map((l) => ({ ...l, currencyCode: "USD", quantity: "1", unit: "ea" })),
    ...(opts.cash === undefined ? {} : { tenders: [{ method: "cash", amount: opts.cash }] }),
    responsibilities: [{ payerRef: PAYER, amount: opts.credit, sequence: 1 }],
  });
  const res = await harness.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(`st${externalId}`)).send(body);
  harness.contextGuard.userId = actor;
  if (res.status !== 201) throw new Error(`capture failed: ${res.status} ${JSON.stringify(res.body)}`);
  const byName = new Map((res.body.lines as Array<{ lineRef: string; lineName: string }>).map((l) => [l.lineName, l.lineRef]));
  return { saleRef: res.body.saleRef, lineRefs: lines.map((l) => byName.get(l.lineName)!) };
}

/** A Manager/Admin credit return of line 0; with `refund` it pays cash out under a second approval. */
async function creditReturn(sale: CreditSale, externalId: string, refund?: string) {
  const harness = h.harness!;
  harness.contextGuard.userId = APPROVER_TENANT_ADMIN;
  const body: Record<string, unknown> = {
    sourceSystem: "pos-1",
    externalId,
    kind: "return",
    lines: [{ lineRef: sale.lineRefs[0], quantity: "1" }],
    refundTenders: refund === undefined ? [] : [{ method: "cash", amount: refund }],
    reason: "customer returned the goods",
    ...(refund === undefined
      ? {}
      : {
          approval: {
            approvalId: `0a000000-0000-7000-8000-${(0x5481000000 + Math.floor(Math.random() * 0xffffff)).toString(16).padStart(12, "0")}`,
            action: "sale.credit_return",
            saleRef: sale.saleRef,
            amount: refund,
            requesterUserId: APPROVER_TENANT_ADMIN,
            approverUserId: APPROVER_OWNER,
            policyVersion: "rt114-2026-10-07",
            approvedAt: new Date().toISOString(),
          },
        }),
  };
  return harness
    .http()
    .post(`/api/pos/v1/sales/${sale.saleRef}/credit-reversals`)
    .set("Idempotency-Key", idempKey(`cr${externalId}`))
    .send(body);
}

describe("RT-1548 readReturnStatusByProvenance — credit-sale reversals (BR-4)", () => {
  it("a credit return that refunds cash reads recorded with creditLinked true (neither a 404 nor not_recorded)", async () => {
    if (skip()) return;
    const sale = await captureCreditSale("st-cr-cash", { cash: "2.5", credit: "10" });
    const made = await creditReturn(sale, "st-cr-cash-r", "1");
    expect(made.status).toBe(201);
    resetHarness(h);
    const res = await status(sale.saleRef, KEY("st-cr-cash-r"));
    expect(res.status).toBe(200);
    expectValidVerdict(res.body);
    expect(res.body.status).toBe("recorded");
    expect(res.body.creditLinked).toBe(true);
    expect(res.body.saleReturn).toMatchObject({ saleRef: sale.saleRef, sourceSystem: "pos-1", externalId: "st-cr-cash-r" });
    expect(res.body.saleReturn.refundTenders).toEqual([{ method: "cash", amount: "1.0000" }]);
    // The older read still treats the same key as absent: that is the gap this read closes.
    const older = await h.harness!.http().get(`/api/pos/v1/sales/${sale.saleRef}/returns/by-provenance`).query(KEY("st-cr-cash-r"));
    expect(older.status).toBe(404);
  });

  it("a credit return with a ZERO cash refund reads recorded, creditLinked true, with an empty refundTenders (the zero-refund shape)", async () => {
    if (skip()) return;
    const sale = await captureCreditSale("st-cr-zero", { credit: "12.5" }); // fully on credit: nothing was collected
    const made = await creditReturn(sale, "st-cr-zero-r");
    expect(made.status).toBe(201);
    resetHarness(h);
    const res = await status(sale.saleRef, KEY("st-cr-zero-r"));
    expect(res.status).toBe(200);
    expectValidVerdict(res.body); // SaleReturn (minItems 1) would reject this; ReturnStatusZeroRefundReturn must accept it
    expect(res.body.status).toBe("recorded");
    expect(res.body.creditLinked).toBe(true);
    expect(res.body.saleReturn.refundTenders).toEqual([]);
  });

  it("a credit return recorded under a key on ANOTHER sale reads not_recorded for this sale", async () => {
    if (skip()) return;
    const a = await captureCreditSale("st-cr-a", { credit: "12.5" });
    const b = await captureCreditSale("st-cr-b", { credit: "12.5" });
    expect((await creditReturn(a, "st-cr-shared")).status).toBe(201);
    resetHarness(h);
    const res = await status(b.saleRef, KEY("st-cr-shared"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "not_recorded" });
  });

  it("an ordinary return of a cash sale is creditLinked false, so the POS can tell the two apart", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "st-cr-ord", quantity: "1", lineAmount: "5.0000" });
    await postReturn(h, s.saleRef, returnBody("st-cr-ord-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"), "stcrord");
    expect((await status(s.saleRef, KEY("st-cr-ord-r"))).body.creditLinked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
describe("RT-1548 readReturnStatusByProvenance — audit (BR-5)", () => {
  it("recorded audits one pos_sales.return_read with the sale ref and the return ref only", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "st-aud-1", quantity: "1", lineAmount: "5.0000" });
    const posted = await postReturn(h, s.saleRef, returnBody("st-aud-1-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"), "staud1");
    spy.reset();
    expect((await status(s.saleRef, KEY("st-aud-1-r"))).status).toBe(200);
    expect(readAudits()).toHaveLength(1);
    expect(readAudits()[0]!.metadata).toEqual({ sale_ref: s.saleRef, return_ref: posted.body.returnRef });
  });

  it("not_recorded audits one pos_sales.return_read with the sale ref alone", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "st-aud-2", quantity: "1", lineAmount: "5.0000" });
    spy.reset();
    expect((await status(s.saleRef, KEY("st-aud-2-never"))).status).toBe(200);
    expect(readAudits()).toHaveLength(1);
    expect(readAudits()[0]!.metadata).toEqual({ sale_ref: s.saleRef });
  });

  it("a 404 and a 400 audit nothing", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "st-aud-3", quantity: "1", lineAmount: "5.0000" });
    spy.reset();
    await status("not-a-uuid", KEY("x"));
    await status(s.saleRef, null);
    delete process.env[READ_FLAG];
    await status(s.saleRef, KEY("x"));
    expect(readAudits()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrency: a read during an in-flight recordReturn
// ---------------------------------------------------------------------------
describe("RT-1548 readReturnStatusByProvenance — a read during an in-flight recordReturn", () => {
  /** Hold the sale row lock on a separate admin connection, as a long recordReturn transaction would. */
  async function holdSaleLock(saleRef: string): Promise<() => Promise<void>> {
    const c = await h.harness!.env.admin.connect();
    await c.query("BEGIN");
    await c.query("SELECT 1 FROM sales WHERE id = $1 FOR UPDATE", [saleRef]);
    return async () => {
      await c.query("ROLLBACK");
      c.release();
    };
  }

  async function waitForLockWaiter(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const r = await h.harness!.env.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE OF s%'`,
      );
      if (Number(r.rows[0]!.n) > 0) return;
      await new Promise((r2) => setTimeout(r2, 25));
    }
    throw new Error("the recordReturn never started waiting on the sale lock");
  }

  it("the read answers at once (it never waits on the sale lock), says not_recorded, and a later read says recorded", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "st-conc", quantity: "1", lineAmount: "5.0000" });
    const release = await holdSaleLock(s.saleRef);
    let inFlight: Promise<number> | undefined;
    try {
      // `.then` is what makes supertest send the request now rather than at the first await.
      inFlight = postReturn(h, s.saleRef, returnBody("st-conc-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"), "stconc").then(
        (r) => r.status,
      );
      await waitForLockWaiter();
      const during = await status(s.saleRef, KEY("st-conc-r"));
      expect(during.status).toBe(200);
      // A point-in-time answer: nothing is committed yet. It is NOT proof about a request received less than 60 s ago.
      expect(during.body).toEqual({ status: "not_recorded" });
    } finally {
      await release();
    }
    expect(await inFlight!).toBe(201);
    const after = await status(s.saleRef, KEY("st-conc-r"));
    expect(after.body.status).toBe("recorded");
  });
});
