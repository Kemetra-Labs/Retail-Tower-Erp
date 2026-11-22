/**
 * RT-1543 — a completed payout is reported to Backend-Core as a refund execution, exactly once.
 *
 *   • a NEW return sends one `allocationRef` on its refund tender, fixed at journal time, so a lost
 *     answer and a resend carry the identical bytes;
 *   • a return journaled before this build replays its exact stored bytes and reports nothing;
 *   • `drawer`, `manual` and `no_drawer` payouts each record exactly one execution, and still
 *     exactly one after an unknown answer plus a resend, and after a restart;
 *   • a payout that failed, was refused or is unknown records nothing;
 *   • an answer that does not name this execution is never success.
 *
 * Over the real composed domain on sql.js, with a fake drawer, printer and Backend-Core.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PosSalesSales } from '../../../shared/api-types.js';
import type { DrawerKickResult } from '../../drawer/drawer-kick-transport.js';
import {
  LINE_A,
  MANAGER_ACTOR,
  RETURN_REF,
  SALE_NUMBER,
  SALE_REF,
  SHIFT_REF,
  confirmedReturn,
  deferredFake,
  errorBody,
  initReturnsSql,
  jsonResponse,
  returnsHarness,
  seedSyncedSale,
  secondsAfterNow,
  NOW,
  SCOPE,
  type RecordedCall,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';

type ExecutionRequest = PosSalesSales.components['schemas']['RecordRefundExecutionRequest'];

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXEC_URL = /\/api\/pos\/v1\/sales\/[^/]+\/returns\/[^/]+\/executions$/;

beforeAll(async () => {
  await initReturnsSql();
});

let h: ReturnsHarness;

beforeEach(() => {
  h = returnsHarness();
  seedSyncedSale(h.db);
});

afterEach(() => {
  h.close();
});

const NO_DRAWER = (): Promise<DrawerKickResult> =>
  Promise.resolve({ ok: false, failure_reason: 'no_drawer_configured' });
const DRAWER_FAULT = (): Promise<DrawerKickResult> =>
  Promise.resolve({ ok: false, failure_reason: 'os_error' });

type Row = Record<string, unknown>;

function rows(sql: string, params: unknown[] = []): Row[] {
  const res = h.db.exec(sql, params as never[])[0];
  if (res === undefined) return [];
  return res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]])));
}

function executionRows(): Row[] {
  return rows('SELECT * FROM return_refund_executions ORDER BY created_at, execution_id');
}

function bodyOf(call: RecordedCall | undefined): ExecutionRequest {
  return JSON.parse(call?.body ?? '{}') as ExecutionRequest;
}

/** Wait for the post-payout send (not awaited by `payout`) to settle. */
async function settle(domain: Pick<ReturnsHarness, 'resolver'> = h): Promise<void> {
  await domain.resolver.drain(1_000);
}

const networkFault = (): Promise<Response> => Promise.reject(new TypeError('network down'));

describe('a NEW return carries its allocation ref, fixed at journal time', () => {
  it('sends one allocationRef (UUIDv7) on the refund tender; a lost answer and a resend send the same bytes', async () => {
    h.backend.onReturn = networkFault;
    const first = await h.service.submit({
      saleNumber: SALE_NUMBER,
      lines: [{ lineRef: LINE_A, quantity: 1 }],
    });
    expect(first.kind).toBe('unconfirmed');
    const stored = String(rows('SELECT request_body_json AS b FROM return_journal')[0]?.['b']);
    const tenders = (JSON.parse(stored) as { refundTenders: { allocationRef?: string }[] })
      .refundTenders;
    expect(tenders).toHaveLength(1);
    expect(tenders[0]?.allocationRef).toMatch(UUID_V7);
    expect(h.backend.returnCalls()[0]?.body).toBe(stored);

    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
    const resolved = await h.service.resolve();
    expect(resolved).toMatchObject({ kind: 'ok', confirmed: 1 });
    const bodies = h.backend.returnCalls().map((c) => c.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[1]).toBe(stored);
  });
});

describe('a return journaled before this build (legacy bytes)', () => {
  const LEGACY_BODY =
    '{"sourceSystem":"pos-pulse","externalId":"pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000001",' +
    `"lines":[{"lineRef":"${LINE_A}","quantity":"1"}],"refundTenders":[{"method":"cash","amount":"15.00"}]}`;

  function journalLegacy(): string {
    h.repo.insert({
      returnId: 'legacy-1',
      scope: SCOPE,
      saleId: 'sale-1',
      saleNumber: SALE_NUMBER,
      serverSaleRef: SALE_REF,
      externalId: 'pos-pulse-return:0190f5a2-7b3c-7d4e-8f90-000000000001',
      operatorId: MANAGER_ACTOR.operatorId,
      operatorSessionId: MANAGER_ACTOR.operatorSessionId,
      currencyCode: 'EGP',
      quotedTotalMinor: 1500,
      requestBodyJson: LEGACY_BODY,
      lines: [{ lineRef: LINE_A, quantity: 1 }],
      now: NOW,
    });
    return 'legacy-1';
  }

  it('is replayed byte for byte, with no allocationRef added', async () => {
    journalLegacy();
    const res = await h.service.resolve();
    expect(res).toMatchObject({ kind: 'ok', confirmed: 1 });
    expect(h.backend.returnCalls()).toHaveLength(1);
    expect(h.backend.returnCalls()[0]?.body).toBe(LEGACY_BODY);
    expect(h.backend.returnCalls()[0]?.body).not.toContain('allocationRef');
  });

  it('pays out without enqueueing or sending any execution', async () => {
    const returnId = journalLegacy();
    await h.service.resolve();
    const paid = await h.service.payout({ returnId, action: 'start' });
    expect(paid.kind).toBe('paid_out');
    await settle();
    await h.service.resolve();
    expect(executionRows()).toEqual([]);
    expect(h.backend.executionCalls()).toEqual([]);
  });
});

describe('a completed payout records exactly one execution', () => {
  it('drawer: one POST with the pinned body, key, envelope and path; the row is recorded', async () => {
    const returnId = await confirmedReturn(h.service);
    const allocationRef = (
      JSON.parse(String(rows('SELECT request_body_json AS b FROM return_journal')[0]?.['b'])) as {
        refundTenders: { allocationRef: string }[];
      }
    ).refundTenders[0]?.allocationRef;
    const res = await h.service.payout({ returnId, action: 'start' });
    expect(res).toMatchObject({ kind: 'paid_out', method: 'drawer' });
    await settle();

    expect(h.backend.executionCalls()).toHaveLength(1);
    const call = h.backend.executionCalls()[0];
    expect(call?.url).toBe(
      `https://backend.example.invalid/api/pos/v1/sales/${SALE_REF}/returns/${RETURN_REF}/executions`,
    );
    expect(call?.url).toMatch(EXEC_URL);
    expect(call?.headers['Authorization']).toBe('Bearer opaque-operator-envelope');
    const body = bodyOf(call);
    expect(call?.headers['Idempotency-Key']).toBe(body.externalId);
    expect(body.externalId).toBe(`pos-pulse-refund-exec:${body.executionRef}`);
    expect(body).toEqual({
      sourceSystem: 'pos-pulse',
      externalId: body.externalId,
      executionRef: expect.stringMatching(UUID_V7) as string,
      allocationRef,
      amount: '15.00',
      outcome: 'settled',
      evidence: { method: 'drawer', paidAt: NOW, shiftRef: SHIFT_REF },
    });
    const [row] = executionRows();
    expect(executionRows()).toHaveLength(1);
    expect(row).toMatchObject({ state: 'recorded', return_id: returnId, return_ref: RETURN_REF });
    expect(row?.['request_body_json']).toBe(call?.body);
    expect(h.backend.executions.size).toBe(1);
  });

  it('manual after a drawer fault: nothing while the payout is unfinished, then one execution', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = DRAWER_FAULT;
    const first = await h.service.payout({ returnId, action: 'start' });
    expect(first.kind).toBe('drawer_failed');
    await settle();
    expect(executionRows()).toEqual([]);
    expect(h.backend.executionCalls()).toEqual([]);

    const manual = await h.service.payout({ returnId, action: 'manual' });
    expect(manual).toMatchObject({ kind: 'paid_out', method: 'manual' });
    await settle();
    expect(h.backend.executionCalls()).toHaveLength(1);
    expect(bodyOf(h.backend.executionCalls()[0]).evidence.method).toBe('manual');
    expect(executionRows()).toHaveLength(1);
  });

  it('no_drawer: one execution, reported as manual evidence', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = NO_DRAWER;
    const res = await h.service.payout({ returnId, action: 'start' });
    expect(res).toMatchObject({ kind: 'paid_out', method: 'no_drawer' });
    await settle();
    expect(h.backend.executionCalls()).toHaveLength(1);
    expect(bodyOf(h.backend.executionCalls()[0]).evidence.method).toBe('manual');
  });

  it('uses the payout commit paidAt and the open shift at that moment', async () => {
    const returnId = await confirmedReturn(h.service);
    h.state.now = secondsAfterNow(90);
    await h.service.payout({ returnId, action: 'start' });
    await settle();
    const body = bodyOf(h.backend.executionCalls()[0]);
    expect(body.evidence.paidAt).toBe(secondsAfterNow(90));
    expect(rows('SELECT paid_at FROM return_payouts')[0]?.['paid_at']).toBe(secondsAfterNow(90));
  });

  it('a double click and a refused repeat enqueue one row only', async () => {
    const returnId = await confirmedReturn(h.service);
    const [a, b] = await Promise.all([
      h.service.payout({ returnId, action: 'start' }),
      h.service.payout({ returnId, action: 'start' }),
    ]);
    expect(a.kind).toBe('paid_out');
    expect(b.kind).toBe('paid_out');
    const again = await h.service.payout({ returnId, action: 'start' });
    expect(again.kind).toBe('refused');
    await settle();
    expect(executionRows()).toHaveLength(1);
    expect(h.backend.executionCalls()).toHaveLength(1);
  });
});

describe('a failed, refused or unknown payout records nothing', () => {
  it('drawer fault (the kick may have opened it): no row, no POST', async () => {
    const returnId = await confirmedReturn(h.service);
    h.drawer.answer = DRAWER_FAULT;
    const res = await h.service.payout({ returnId, action: 'start' });
    expect(res.kind).toBe('drawer_failed');
    await settle();
    await h.service.resolve();
    expect(executionRows()).toEqual([]);
    expect(h.backend.executionCalls()).toEqual([]);
  });

  it('a payout refused for an unconfirmed return: no row, no POST', async () => {
    h.backend.onReturn = networkFault;
    const submitted = await h.service.submit({
      saleNumber: SALE_NUMBER,
      lines: [{ lineRef: LINE_A, quantity: 1 }],
    });
    const returnId = submitted.ret?.returnId ?? '';
    const res = await h.service.payout({ returnId, action: 'start' });
    expect(res.kind).toBe('refused');
    await settle();
    expect(executionRows()).toEqual([]);
    expect(h.backend.executionCalls()).toEqual([]);
  });

  it('no open shift while shift cash-up is on: the payout is refused, nothing is outboxed (RT-1543 follow-up)', async () => {
    h.state.shiftRef = null;
    const returnId = await confirmedReturn(h.service);
    const res = await h.service.payout({ returnId, action: 'start' });
    expect(res).toMatchObject({ kind: 'refused', reason: 'payout_no_open_shift' });
    await settle();
    expect(executionRows()).toEqual([]);
    expect(h.backend.executionCalls()).toEqual([]);
    expect(h.drawer.kicks).toBe(0);
  });

  it('no shift open at the commit and none recorded at the claim: the payout still completes, no execution is invented, a warning is logged (the claim-time shift is covered in returns-payout-claim-shift.test.ts)', async () => {
    const returnId = await confirmedReturn(h.service);
    // The fake shift records name no shift at the claim either; the kick is the only await between
    // the check and the commit.
    h.drawer.onKick = () => {
      h.state.shiftRef = null;
    };
    const res = await h.service.payout({ returnId, action: 'start' });
    expect(res.kind).toBe('paid_out');
    await settle();
    expect(executionRows()).toEqual([]);
    expect(h.backend.executionCalls()).toEqual([]);
    expect(h.warnings).toContain('returns:execution_no_open_shift');
  });
});

describe('retries and restarts never record a second execution', () => {
  it('an unknown answer (500) leaves the row unknown; the resend sends identical bytes and records once', async () => {
    h.backend.onExecution = () => Promise.resolve(jsonResponse(500, errorBody('internal_error')));
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    await settle();
    expect(executionRows()[0]).toMatchObject({ state: 'unknown', attempt_count: 1 });
    expect(h.backend.executions.size).toBe(0);

    h.backend.onExecution = (call, backend) => backend.recordExecutionIdempotently(call);
    await h.service.resolve();
    const calls = h.backend.executionCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toBe(calls[0]?.body);
    expect(calls[1]?.headers['Idempotency-Key']).toBe(calls[0]?.headers['Idempotency-Key']);
    expect(executionRows()).toHaveLength(1);
    expect(executionRows()[0]).toMatchObject({ state: 'recorded', attempt_count: 2 });
    expect(h.backend.executions.size).toBe(1);

    await h.service.resolve();
    expect(h.backend.executionCalls()).toHaveLength(2);
  });

  it('a payout whose send never got an answer is sent after a restart, once, with the same bytes', async () => {
    h.backend.onExecution = networkFault;
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    await settle();
    expect(executionRows()[0]).toMatchObject({ state: 'unknown' });
    const stored = String(executionRows()[0]?.['request_body_json']);

    h.backend.onExecution = (call, backend) => backend.recordExecutionIdempotently(call);
    const restarted = h.restart();
    await restarted.service.resolve();
    expect(h.backend.executionCalls()).toHaveLength(2);
    expect(h.backend.executionCalls()[1]?.body).toBe(stored);
    expect(executionRows()).toHaveLength(1);
    expect(executionRows()[0]).toMatchObject({ state: 'recorded' });
    expect(h.backend.executions.size).toBe(1);
  });

  it('an answer lost AFTER the server recorded it is confirmed by the replay, not recorded twice', async () => {
    let first = true;
    h.backend.onExecution = (call, backend) => {
      const answer = backend.recordExecutionIdempotently(call);
      if (!first) return answer;
      first = false;
      return Promise.reject(new TypeError('connection reset after the server answered'));
    };
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    await settle();
    expect(executionRows()[0]).toMatchObject({ state: 'unknown' });
    expect(h.backend.executions.size).toBe(1);

    await h.service.resolve();
    expect(executionRows()[0]).toMatchObject({ state: 'recorded' });
    expect(h.backend.executions.size).toBe(1);
  });
});

describe('what Backend-Core answers', () => {
  it.each([
    [409, 'conflict', 'conflict'],
    [422, 'refund_execution_exceeds_allocation', 'exceeds_allocation'],
  ])(
    '%i (%s) is a final refusal: logged, never re-sent, never success',
    async (status, code, reason) => {
      h.backend.onExecution = () => Promise.resolve(jsonResponse(status, errorBody(code)));
      const returnId = await confirmedReturn(h.service);
      await h.service.payout({ returnId, action: 'start' });
      await settle();
      expect(executionRows()[0]).toMatchObject({ state: 'refused', refusal_reason: reason });
      await h.service.resolve();
      await h.resolver.tick();
      expect(h.backend.executionCalls()).toHaveLength(1);
      expect(h.warnings).toContain('returns:execution_refused');
    },
  );

  it.each([
    [400, 'validation_error'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    // The real unmatched-route (and no-such-return) body: `{ error: { code: "not_found" } }`.
    [404, 'not_found'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ])('%i (%s) is unknown, never success and never final', async (status, code) => {
    h.backend.onExecution = () => Promise.resolve(jsonResponse(status, errorBody(code)));
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    await settle();
    expect(executionRows()[0]).toMatchObject({ state: 'unknown' });
  });

  it('a 400 from a till clock ahead of the server is retried and recorded once the clock agrees', async () => {
    h.backend.onExecution = () => Promise.resolve(jsonResponse(400, errorBody('validation_error')));
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    await settle();
    expect(executionRows()[0]).toMatchObject({ state: 'unknown' });

    h.backend.onExecution = (call, backend) => backend.recordExecutionIdempotently(call);
    await h.service.resolve();
    expect(executionRows()[0]).toMatchObject({ state: 'recorded', attempt_count: 2 });
    expect(h.backend.executions.size).toBe(1);
  });

  it('a 201 that names another execution is not success', async () => {
    h.backend.onExecution = (call, backend) => {
      const real = backend.recordExecutionIdempotently(call);
      return real
        .json()
        .then((body: Record<string, unknown>) =>
          jsonResponse(201, { ...body, executionRef: '0190f5a2-7b3c-7d4e-8f90-0000000000ee' }),
        );
    };
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    await settle();
    expect(executionRows()[0]).toMatchObject({ state: 'unknown' });
    expect(h.warnings).toContain('returns:execution_confirmation_mismatch');
  });

  it('a 201 with an unreadable body is unknown', async () => {
    h.backend.onExecution = () => Promise.resolve(jsonResponse(201, { ok: true }));
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    await settle();
    expect(executionRows()[0]).toMatchObject({ state: 'unknown' });
  });
});

describe('shutdown, restart and the background tick', () => {
  it('a send in flight at stop writes nothing; the next start sends the same bytes once', async () => {
    const answer = deferredFake<undefined>();
    h.backend.onExecution = (call, backend) => {
      const recorded = backend.recordExecutionIdempotently(call);
      return answer.promise.then(() => recorded);
    };
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    expect(executionRows()[0]).toMatchObject({ state: 'pending', attempt_count: 1 });

    h.stop();
    answer.resolve(undefined);
    await settle();
    // The answer arrived after stop: the row is exactly as the attempt left it.
    expect(executionRows()[0]).toMatchObject({ state: 'pending', attempt_count: 1 });

    h.backend.onExecution = (call, backend) => backend.recordExecutionIdempotently(call);
    const restarted = h.restart();
    await restarted.service.resolve();
    expect(h.lives.deadTouches).toBe(0);
    const calls = h.backend.executionCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toBe(calls[0]?.body);
    expect(executionRows()[0]).toMatchObject({ state: 'recorded', attempt_count: 2 });
    expect(h.backend.executions.size).toBe(1);
  });

  it('a crash after the server recorded it but before any answer: the replay confirms it once', async () => {
    let first = true;
    h.backend.onExecution = (call, backend) => {
      const recorded = backend.recordExecutionIdempotently(call);
      if (!first) return recorded;
      first = false;
      return new Promise<Response>(() => undefined);
    };
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    expect(executionRows()[0]).toMatchObject({ state: 'pending', attempt_count: 1 });

    const restarted = h.restart();
    await restarted.service.resolve();
    expect(h.backend.executionCalls()).toHaveLength(2);
    expect(executionRows()).toHaveLength(1);
    expect(executionRows()[0]).toMatchObject({ state: 'recorded' });
    expect(h.backend.executions.size).toBe(1);
    expect(h.lives.deadTouches).toBe(0);
  });

  it('the post-payout send and an on-demand resolve share one send of the same execution', async () => {
    const answer = deferredFake<undefined>();
    h.backend.onExecution = (call, backend) => {
      const recorded = backend.recordExecutionIdempotently(call);
      return answer.promise.then(() => recorded);
    };
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    const resolving = h.service.resolve();
    await Promise.resolve();
    answer.resolve(undefined);
    await resolving;
    await settle();
    expect(h.backend.executionCalls()).toHaveLength(1);
    expect(executionRows()[0]).toMatchObject({ state: 'recorded', attempt_count: 1 });
  });

  it('the background tick waits out an unknown execution backoff, then re-sends it', async () => {
    h.backend.onExecution = () => Promise.resolve(jsonResponse(503, errorBody('unavailable')));
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    await settle();
    expect(executionRows()[0]).toMatchObject({ state: 'unknown', attempt_count: 1 });

    h.backend.onExecution = (call, backend) => backend.recordExecutionIdempotently(call);
    await h.resolver.tick();
    expect(h.backend.executionCalls()).toHaveLength(1);
    expect(executionRows()[0]).toMatchObject({ state: 'unknown' });

    h.state.now = secondsAfterNow(30);
    await h.resolver.tick();
    expect(h.backend.executionCalls()).toHaveLength(2);
    expect(executionRows()[0]).toMatchObject({ state: 'recorded' });
  });

  it('the resolve summary keeps its three return counts and reports the open executions apart', async () => {
    h.backend.onExecution = () => Promise.resolve(jsonResponse(503, errorBody('unavailable')));
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    await settle();
    expect(await h.service.resolve()).toEqual({
      kind: 'ok',
      confirmed: 0,
      refused: 0,
      unresolved: 0,
      executionsOpen: 1,
    });

    h.backend.onExecution = (call, backend) => backend.recordExecutionIdempotently(call);
    expect(await h.service.resolve()).toMatchObject({ unresolved: 0, executionsOpen: 0 });
  });

  it('a final refusal is not an open execution', async () => {
    h.backend.onExecution = () => Promise.resolve(jsonResponse(409, errorBody('conflict')));
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    await settle();
    expect(await h.service.resolve()).toMatchObject({ executionsOpen: 0 });
  });

  it('logs the cause and the attempt of each unknown answer, with no amount, body or envelope', async () => {
    h.backend.onExecution = () => Promise.resolve(jsonResponse(503, errorBody('unavailable')));
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    await settle();
    await h.service.resolve();
    const unknowns = h.logs.filter((l) => l.msg === 'returns:execution_unknown');
    expect(unknowns).toHaveLength(2);
    const [row] = executionRows();
    expect(unknowns.map((l) => l.obj)).toEqual([
      { execution_id: row?.['execution_id'], attempt: 1, cause: 'server_5xx' },
      { execution_id: row?.['execution_id'], attempt: 2, cause: 'server_5xx' },
    ]);
    const text = JSON.stringify(unknowns);
    expect(text).not.toContain('15.00');
    expect(text).not.toContain('opaque-operator-envelope');
    expect(text).not.toContain('allocationRef');
  });

  it('logs a lost answer with its transport cause', async () => {
    h.backend.onExecution = networkFault;
    const returnId = await confirmedReturn(h.service);
    await h.service.payout({ returnId, action: 'start' });
    await settle();
    expect(h.logs.find((l) => l.msg === 'returns:execution_unknown')?.obj).toMatchObject({
      attempt: 1,
      cause: 'network',
    });
  });
});

describe('a till that cannot report (shift cash-up off)', () => {
  const body = (): { refundTenders: { allocationRef?: string }[] } =>
    JSON.parse(String(rows('SELECT request_body_json AS b FROM return_journal')[0]?.['b'])) as {
      refundTenders: { allocationRef?: string }[];
    };

  it('sends a NEW return with no allocationRef: the pre-RT-1543 bytes, nothing enqueued', async () => {
    h.state.shiftCashup = false;
    const returnId = await confirmedReturn(h.service);
    expect(body().refundTenders).toEqual([{ method: 'cash', amount: '15.00' }]);
    expect(h.backend.returnCalls()[0]?.body).not.toContain('allocationRef');
    const paid = await h.service.payout({ returnId, action: 'start' });
    expect(paid.kind).toBe('paid_out');
    await settle();
    await h.service.resolve();
    expect(executionRows()).toEqual([]);
    expect(h.backend.executionCalls()).toEqual([]);
    // No shift is expected here, so the no-open-shift warning is not raised either.
    expect(h.warnings).not.toContain('returns:execution_no_open_shift');
  });

  it('a return of a till that turns it off after journaling still reports the execution it was journaled with', async () => {
    const returnId = await confirmedReturn(h.service);
    expect(body().refundTenders[0]?.allocationRef).toMatch(UUID_V7);
    h.state.shiftCashup = false;
    await h.service.payout({ returnId, action: 'start' });
    await settle();
    expect(executionRows()).toHaveLength(1);
    expect(h.backend.executionCalls()).toHaveLength(1);
  });

  it('turned off after journaling and no shift open: the payout is unchanged, nothing is reported, the warning stays', async () => {
    const returnId = await confirmedReturn(h.service);
    expect(body().refundTenders[0]?.allocationRef).toMatch(UUID_V7);
    h.state.shiftCashup = false;
    h.state.shiftRef = null;
    const paid = await h.service.payout({ returnId, action: 'start' });
    expect(paid.kind).toBe('paid_out');
    await settle();
    expect(executionRows()).toEqual([]);
    expect(h.warnings).toContain('returns:execution_no_open_shift');
  });
});
