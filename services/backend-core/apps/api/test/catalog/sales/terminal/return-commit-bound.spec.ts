/**
 * return-commit-bound.spec.ts — Jira RT-1548 slice 2, BR-7, against a real
 * RLS-forced Postgres (db-integration, Testcontainers): a `recordReturn`
 * request issues no COMMIT later than 60 s after receipt, and a request that
 * runs out of budget while it waits on the sale row lock never commits, so a
 * later `readReturnStatusByProvenance` says `not_recorded`.
 *
 * Two proofs, because a 60 s wait cannot sit in a test:
 *   1. the REAL Postgres cancel: a short budget (the same `CommitDeadline`
 *      with 800 ms) and the real clock, a lock held by another connection:
 *      `lock_timeout` set by the runtime ends the wait, nothing is committed;
 *   2. the WHOLE request path with a fake clock: the receipt is stamped by the
 *      middleware, the clock then jumps 61 s while the request waits on the
 *      lock, and the request is refused after the lock frees, in the contract's
 *      existing `SystemFailure` shape, recording nothing.
 */
import {
  resetHarness,
  startCaptureHarness,
  stopCaptureHarness,
  type HarnessHandle,
} from "../capture/__capture-harness";
import {
  CommitDeadline,
  type DeadlineClock,
  RETURN_COMMIT_BUDGET_MS,
  ReturnDeadlineExceededError,
} from "../../../../src/catalog/sales/return-commit-deadline";
import { SaleReturnsService } from "../../../../src/catalog/sales/sale-returns.service";
import { DEVICE_USER_ID, STORE_A_X, TENANT_A } from "../capture/__capture-harness";
import {
  captureOneLine,
  cleanReturnsFixtures,
  disableReturns,
  enableReturns,
  postReturn,
  returnBody,
} from "./__returns-support";

class FakeClock implements DeadlineClock {
  t = 10_000;
  now(): number {
    return this.t;
  }
}

const clock = new FakeClock();
const h: HarnessHandle = { harness: null, dockerSkipped: false };
const READ_FLAG = "POS_RETURN_STATUS_READ_ENABLED";

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness({ returnDeadlineClock: clock }));
}, 180_000);
afterAll(async () => {
  delete process.env[READ_FLAG];
  disableReturns();
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  enableReturns();
  process.env[READ_FLAG] = "true";
});
afterEach(async () => {
  await cleanReturnsFixtures(h);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

/** Hold the sale row lock on a separate admin connection, as a long transaction on the sale would. */
async function holdSaleLock(saleRef: string): Promise<() => Promise<void>> {
  const c = await h.harness!.env.admin.connect();
  await c.query("BEGIN");
  await c.query("SELECT 1 FROM sales WHERE id = $1 FOR UPDATE", [saleRef]);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await c.query("ROLLBACK");
    c.release();
  };
}

async function waitForLockWaiter(): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const r = await h.harness!.env.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE OF s%'`,
    );
    if (Number(r.rows[0]!.n) > 0) return;
    await new Promise((r2) => setTimeout(r2, 25));
  }
  throw new Error("the recordReturn never started waiting on the sale lock");
}

const returnRows = async (saleRef: string): Promise<number> =>
  Number(
    (await h.harness!.env.admin.query<{ n: string }>("SELECT count(*)::text AS n FROM sale_returns WHERE sale_id = $1", [saleRef]))
      .rows[0]!.n,
  );

const statusOf = (saleRef: string, externalId: string) =>
  h
    .harness!.http()
    .get(`/api/pos/v1/sales/${saleRef}/returns/by-provenance/status`)
    .query({ sourceSystem: "pos-1", externalId });

describe("RT-1548 BR-7 — the real Postgres cancels a lock wait that outlives the budget", () => {
  it("the budget expires while recordReturn waits on the sale lock: ReturnDeadlineExceededError, nothing committed, a later read says not_recorded", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "bd-lock", quantity: "1", lineAmount: "5.0000" });
    const service = h.harness!.app.get(SaleReturnsService);
    const release = await holdSaleLock(s.saleRef);
    const started = Date.now();
    try {
      // Same CommitDeadline as production, a short budget, the real (monotonic) clock.
      const deadline = CommitDeadline.startingNow(undefined, 800);
      const refused = await service
        .recordReturn({
          tenantId: TENANT_A,
          storeId: STORE_A_X,
          actorUserId: DEVICE_USER_ID,
          saleRef: s.saleRef,
          body: returnBody("bd-lock-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000") as never,
          deadline,
        })
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ReturnDeadlineExceededError);
      // The wait ended by itself at about the budget: the lock was still held.
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(600);
      expect(waited).toBeLessThan(15_000);
    } finally {
      await release();
    }
    expect(await returnRows(s.saleRef)).toBe(0);
    const read = await statusOf(s.saleRef, "bd-lock-r");
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ status: "not_recorded" });
  });

  it("a request that is refused leaves the key free: the same request, retried with a fresh budget, is recorded (nothing was stored)", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "bd-retry", quantity: "1", lineAmount: "5.0000" });
    const service = h.harness!.app.get(SaleReturnsService);
    const body = returnBody("bd-retry-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000") as never;
    const release = await holdSaleLock(s.saleRef);
    try {
      await expect(
        service.recordReturn({
          tenantId: TENANT_A,
          storeId: STORE_A_X,
          actorUserId: DEVICE_USER_ID,
          saleRef: s.saleRef,
          body,
          deadline: CommitDeadline.startingNow(undefined, 500),
        }),
      ).rejects.toBeInstanceOf(ReturnDeadlineExceededError);
    } finally {
      await release();
    }
    const again = await service.recordReturn({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      actorUserId: DEVICE_USER_ID,
      saleRef: s.saleRef,
      body,
    });
    expect(again.created).toBe(true);
    expect((await statusOf(s.saleRef, "bd-retry-r")).body.status).toBe("recorded");
  });

  it("a request inside its budget commits normally (the bound is not a blanket refusal)", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "bd-ok", quantity: "1", lineAmount: "5.0000" });
    const service = h.harness!.app.get(SaleReturnsService);
    const res = await service.recordReturn({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      actorUserId: DEVICE_USER_ID,
      saleRef: s.saleRef,
      body: returnBody("bd-ok-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000") as never,
      deadline: CommitDeadline.startingNow(undefined, RETURN_COMMIT_BUDGET_MS),
    });
    expect(res.created).toBe(true);
    expect(await returnRows(s.saleRef)).toBe(1);
  });

  it("the timeouts are transaction-local: they do not leak to the next use of the pooled connection", async () => {
    if (skip()) return;
    const pool = h.harness!.env.app;
    const settings = async (): Promise<unknown> =>
      (await pool.query("SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt")).rows[0];
    const before = await settings();
    const s = await captureOneLine(h, { externalId: "bd-leak", quantity: "1", lineAmount: "5.0000" });
    const service = h.harness!.app.get(SaleReturnsService);
    await service.recordReturn({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      actorUserId: DEVICE_USER_ID,
      saleRef: s.saleRef,
      body: returnBody("bd-leak-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000") as never,
    });
    // The app pool's next sessions start with their own defaults again, whichever pooled connection they get.
    for (let i = 0; i < 3; i += 1) expect(await settings()).toEqual(before);
  });
});

describe("RT-1548 BR-7 — the whole request path, receipt stamped at the door (fake clock)", () => {
  it("the clock jumps past the budget while the request waits on the lock: after the lock frees it is refused (500 SystemFailure shape), nothing is committed, and a read says not_recorded", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "bd-http", quantity: "1", lineAmount: "5.0000" });
    const release = await holdSaleLock(s.saleRef);
    let inFlight: Promise<{ status: number; body: { error?: { code?: string; message?: string; request_id?: string } } }> | undefined;
    try {
      inFlight = postReturn(h, s.saleRef, returnBody("bd-http-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"), "bdhttp").then(
        (r) => ({ status: r.status, body: r.body }),
      );
      await waitForLockWaiter(); // the request was received (and stamped) before this point
      clock.t += RETURN_COMMIT_BUDGET_MS + 1_000; // 61 s pass while it waits
    } finally {
      await release();
    }
    const res = await inFlight!;
    expect(res.status).toBe(500);
    // The contract's existing SystemFailure: the cause is never returned.
    expect(res.body.error?.code).toBe("internal_error");
    expect(res.body.error?.message).toBe("Internal Server Error");
    expect(res.body.error?.request_id).toEqual(expect.any(String));

    expect(await returnRows(s.saleRef)).toBe(0);
    const read = await statusOf(s.saleRef, "bd-http-r");
    expect(read.body).toEqual({ status: "not_recorded" });
  });

  it("the refusal stored nothing under the Idempotency-Key: the same request retried is recorded (201)", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "bd-http2", quantity: "1", lineAmount: "5.0000" });
    const body = returnBody("bd-http2-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000");
    const release = await holdSaleLock(s.saleRef);
    let first: Promise<number> | undefined;
    try {
      first = postReturn(h, s.saleRef, body, "bdhttp2").then((r) => r.status);
      await waitForLockWaiter();
      clock.t += RETURN_COMMIT_BUDGET_MS + 1_000;
    } finally {
      await release();
    }
    expect(await first!).toBe(500);
    const retried = await postReturn(h, s.saleRef, body, "bdhttp2");
    expect(retried.status).toBe(201);
    expect((await statusOf(s.saleRef, "bd-http2-r")).body.status).toBe("recorded");
  });

  it("a request received and finished within the budget is a normal 201 (the receipt stamp does not disturb the route)", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "bd-http3", quantity: "1", lineAmount: "5.0000" });
    const res = await postReturn(h, s.saleRef, returnBody("bd-http3-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"), "bdhttp3");
    expect(res.status).toBe(201);
    const replay = await postReturn(h, s.saleRef, returnBody("bd-http3-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"), "bdhttp3b");
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(res.body);
  });
});
