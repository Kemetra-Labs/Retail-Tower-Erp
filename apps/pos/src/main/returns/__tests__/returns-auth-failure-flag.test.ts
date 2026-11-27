/**
 * RT-1498 — the automatic `auth_failure` flag (RT-196 §3.6, OD-196-6, owner-approved RT-196 c12801).
 *
 * A return whose resends keep answering a pre-replay 401/403 cannot be read or resolved from this till
 * (a revoked device, a session that cannot authenticate). After 3 consecutive such resends spanning at
 * least the quiet period, the dispatcher hands it to support by itself:
 *   • `needs_support` with `verdict_source = auth_failure`, `reason = auth_failure`, no approval, no
 *     actor, written in the same transaction as the unknown transition and its cause audit;
 *   • it only restricts: background and bar resends stop, the sale stays blocked, nothing is paid;
 *   • a 404 (the returns gate off, U-2), a timeout or any other cause breaks the streak;
 *   • the span is measured on the persisted `attempt_unknown` audit times (they survive a restart);
 *   • a later explicit resend that the server records still confirms it (support is not terminal).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseHandle } from '../../db/client.js';
import { createReturnsAudit } from '../returns-audit.js';
import { createAuthFailureStreak } from '../returns-causes.js';
import { createReturnsClient } from '../returns-client.js';
import { createReturnsDispatcher } from '../returns-dispatch.js';
import { RETURN_QUIET_PERIOD_MS } from '../returns-quiet-period.js';
import {
  BASE_URL,
  LINE_A,
  MANAGER_ACTOR,
  SALE_ID,
  SALE_NUMBER,
  categories,
  elapse,
  errorBody,
  initReturnsSql,
  jsonResponse,
  returnsHarness,
  seedSyncedSale,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';

beforeAll(async () => {
  await initReturnsSql();
});

let h: ReturnsHarness;

afterEach(() => {
  h.close();
});

const ONE_A = { saleNumber: SALE_NUMBER, lines: [{ lineRef: LINE_A, quantity: 1 }] };
/** Far enough apart that every background tick finds the return due again. */
const STEP = 8 * 60_000;

function harness(): ReturnsHarness {
  h = returnsHarness();
  seedSyncedSale(h.db);
  return h;
}

/** A return whose first send was lost: unknown, one attempt (a network cause, not an auth one). */
async function unknownReturn(): Promise<string> {
  h.backend.onReturn = () => Promise.reject(new TypeError('ECONNREFUSED'));
  const res = await h.service.submit(ONE_A);
  if (res.kind !== 'unconfirmed') throw new Error(`unknownReturn: ${res.kind}`);
  return res.ret.returnId;
}

/** One background resend, `STEP` after the previous one, answered with `status`. */
async function resendAnswering(status: number): Promise<void> {
  elapse(h, STEP);
  h.backend.onReturn = () => jsonResponse(status, errorBody(status === 404 ? 'not_found' : 'x'));
  await h.resolver.resolveOnce(MANAGER_ACTOR);
}

async function resendLost(): Promise<void> {
  elapse(h, STEP);
  h.backend.onReturn = () => Promise.reject(new TypeError('ETIMEDOUT'));
  await h.resolver.resolveOnce(MANAGER_ACTOR);
}

function kinds(returnId: string): string[] {
  return h.dispositions.listFor(returnId).map((d) => d.kind);
}

describe('the automatic auth_failure flag (OD-196-6)', () => {
  it('three consecutive pre-replay 401/403 resends spanning the quiet period hand it to support', async () => {
    harness();
    const returnId = await unknownReturn();
    await resendAnswering(401);
    await resendAnswering(403);
    expect(kinds(returnId)).toEqual([]);

    await resendAnswering(401);

    expect(h.dispositions.listFor(returnId)).toEqual([
      expect.objectContaining({
        kind: 'needs_support',
        verdictSource: 'auth_failure',
        reason: 'auth_failure',
        approvalId: null,
        actorOperatorId: null,
      }),
    ]);
    expect(categories(h.audits).slice(-2)).toEqual([
      'sale.return.attempt_unknown',
      'sale.return.needs_support',
    ]);
    expect(h.audits.at(-1)?.payload).toEqual({
      return_id: returnId,
      approval_id: null,
      verdict_source: 'auth_failure',
      reason: 'auth_failure',
    });
    // It only restricts: still unknown, the sale still blocked, nothing paid or confirmed.
    expect(h.repo.read(returnId)?.state).toBe('unknown');
    expect(h.repo.hasUnresolvedForSale(SALE_ID)).toBe(true);
  });

  it('background resends stop once it is flagged; an explicit resend the server records confirms it', async () => {
    harness();
    const returnId = await unknownReturn();
    for (const status of [401, 401, 401]) await resendAnswering(status);
    expect(h.dispositions.stateOf(returnId)).toBe('needs_support');
    const sent = h.backend.returnCalls().length;

    await resendAnswering(401);
    expect(h.backend.returnCalls()).toHaveLength(sent);

    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
    expect((await h.service.resend({ returnId })).kind).toBe('confirmed');
  });

  it('three failures inside the quiet period do not flag it; the next one past the period does', async () => {
    harness();
    const returnId = await unknownReturn();
    const short = Math.floor(RETURN_QUIET_PERIOD_MS / 3) - 60_000;
    for (let i = 0; i < 3; i += 1) {
      elapse(h, short);
      h.backend.onReturn = () => jsonResponse(401, errorBody('x'));
      await h.service.resend({ returnId });
    }
    expect(kinds(returnId)).toEqual([]);

    // The streak keeps counting from its first failure: the next one, later, spans the period.
    elapse(h, 3 * 60_000 + short);
    await h.service.resend({ returnId });
    expect(kinds(returnId)).toEqual(['needs_support']);
  });

  it('two auth failures, however far apart, do not flag it', async () => {
    harness();
    const returnId = await unknownReturn();
    elapse(h, RETURN_QUIET_PERIOD_MS * 2);
    await resendAnswering(401);
    elapse(h, RETURN_QUIET_PERIOD_MS * 2);
    await resendAnswering(403);
    expect(kinds(returnId)).toEqual([]);
  });

  it.each([
    ['a 404 (the gate is off, U-2)', () => resendAnswering(404)],
    ['a lost answer (timeout)', () => resendLost()],
  ])('%s between auth failures breaks the streak', async (_name, breaker) => {
    harness();
    const returnId = await unknownReturn();
    await resendAnswering(401);
    await resendAnswering(401);
    await breaker();
    await resendAnswering(401);
    await resendAnswering(401);
    expect(kinds(returnId)).toEqual([]);

    await resendAnswering(401);
    expect(kinds(returnId)).toEqual(['needs_support']);
  });

  it('is raised over an earlier retry_hold (the 0070 rules accept it)', async () => {
    harness();
    const returnId = await unknownReturn();
    h.backend.onStatus = () => jsonResponse(200, { status: 'not_recorded' });
    await h.service.readStatus({ returnId });
    expect(kinds(returnId)).toEqual(['retry_hold']);

    for (let i = 0; i < 3; i += 1) {
      elapse(h, STEP);
      h.backend.onReturn = () => jsonResponse(401, errorBody('x'));
      await h.service.resend({ returnId });
    }

    expect(kinds(returnId)).toEqual(['retry_hold', 'needs_support']);
    expect(h.dispositions.listFor(returnId).at(-1)).toMatchObject({
      verdictSource: 'auth_failure',
      reason: 'auth_failure',
    });
  });

  it('a return already handed to support gets no second disposition', async () => {
    harness();
    const returnId = await unknownReturn();
    for (const status of [401, 401, 401]) await resendAnswering(status);
    for (let i = 0; i < 2; i += 1) {
      elapse(h, STEP);
      h.backend.onReturn = () => jsonResponse(401, errorBody('x'));
      await h.service.resend({ returnId });
    }
    expect(kinds(returnId)).toEqual(['needs_support']);
    expect(categories(h.audits).filter((c) => c === 'sale.return.needs_support')).toHaveLength(1);
  });
});

describe('the auth-failure run: adjacent attempt numbers, monotonic span (createAuthFailureStreak)', () => {
  type Row = { cause: string | null; attempt_no: unknown };
  /** A database handle whose one query answers `rows` (newest first, as the SQL orders them). */
  function dbAnswering(rows: Row[]): DatabaseHandle {
    return { prepare: () => ({ all: () => rows }) } as unknown as DatabaseHandle;
  }
  const MIN = 60_000;
  const QUIET = RETURN_QUIET_PERIOD_MS;

  /** A streak over `rows` whose attempts `marked` (attempt → minute) were sent by this process. */
  function streak(rows: Row[], marked: Record<number, number>) {
    let now = 0;
    const s = createAuthFailureStreak(dbAnswering(rows), QUIET, () => now);
    for (const [attempt, minute] of Object.entries(marked)) {
      now = minute * MIN;
      s.markAttempt('r', Number(attempt));
    }
    return s;
  }
  const auth = (attempt_no: unknown): Row => ({ cause: 'pre_replay_401', attempt_no });

  it('needs three adjacent auth failures, marked here, spanning the period', () => {
    const rows = [auth(5), auth(4), auth(3), { cause: 'network', attempt_no: 2 }];
    expect(streak(rows, { 3: 0, 4: 8, 5: 15 }).reached('r', 5)).toBe(true);
    expect(streak(rows, { 3: 0, 4: 8, 5: 14 }).reached('r', 5)).toBe(false);
    expect(streak(rows.slice(1), { 3: 0, 4: 15 }).reached('r', 4)).toBe(false);
  });

  it('a gap in the attempt numbers (a lost audit) ends the run', () => {
    const rows = [auth(6), auth(5), auth(3), auth(2)];
    expect(streak(rows, { 2: 0, 3: 8, 5: 16, 6: 24 }).reached('r', 6)).toBe(false);
  });

  it('the run must end at the journal current attempt', () => {
    const rows = [auth(4), auth(3), auth(2)];
    expect(streak(rows, { 2: 0, 3: 8, 4: 16 }).reached('r', 5)).toBe(false);
  });

  it.each([
    ['a string', '3'],
    ['null', null],
  ])('an attempt number that is %s ends the run', (_n, bad) => {
    const rows = [auth(4), auth(bad), auth(2)];
    expect(streak(rows, { 2: 0, 3: 8, 4: 16 }).reached('r', 4)).toBe(false);
  });

  it('attempts this process did not mark (sent before a restart) prove no span', () => {
    const rows = [auth(5), auth(4), auth(3)];
    expect(streak(rows, { 4: 0, 5: 16 }).reached('r', 5)).toBe(false);
  });

  it('an unknown cause code ends the run', () => {
    const rows = [auth(4), auth(3), { cause: 'something_new', attempt_no: 2 }, auth(1)];
    expect(streak(rows, { 1: 0, 2: 8, 3: 16, 4: 24 }).reached('r', 4)).toBe(false);
  });
});

describe('the flag needs elapsed time this process can show', () => {
  it('a forward wall-clock step does not stand in for the period', async () => {
    harness();
    const returnId = await unknownReturn();
    for (let i = 0; i < 3; i += 1) {
      h.state.mono += 60_000; // one real minute...
      h.state.now = new Date(Date.parse(h.state.now) + STEP).toISOString(); // ...the clock says 8
      h.backend.onReturn = () => jsonResponse(401, errorBody('x'));
      await h.service.resend({ returnId });
    }
    expect(kinds(returnId)).toEqual([]);
  });

  it('after a restart, failures sent before it do not count; three new ones over the period do', async () => {
    harness();
    const returnId = await unknownReturn();
    await resendAnswering(401);
    await resendAnswering(401);
    const restarted = h.restart();
    for (let i = 0; i < 2; i += 1) {
      elapse(h, STEP);
      h.backend.onReturn = () => jsonResponse(401, errorBody('x'));
      await restarted.service.resend({ returnId });
    }
    expect(kinds(returnId)).toEqual([]);
    elapse(h, STEP);
    await restarted.service.resend({ returnId });
    expect(kinds(returnId)).toEqual(['needs_support']);
  });

  it('a missing attempt audit (lost write) breaks the run', async () => {
    harness();
    const returnId = await unknownReturn();
    await resendAnswering(401);
    // The audit of attempt 3 is lost (its write fails): the run can only start after it.
    h.state.failAudit = (e) => e.action_category === 'sale.return.attempt_unknown';
    await resendAnswering(401);
    h.state.failAudit = null;
    expect(h.repo.read(returnId)?.attemptCount).toBe(3);
    await resendAnswering(401);
    await resendAnswering(401);
    expect(kinds(returnId)).toEqual([]);
    await resendAnswering(401);
    expect(kinds(returnId)).toEqual(['needs_support']);
  });
});

describe('a failing auth-failure check never loses the attempt', () => {
  it('logs, raises nothing, and keeps the cause audit of the attempt', async () => {
    harness();
    const returnId = await unknownReturn();
    const warnings: string[] = [];
    let seq = 0;
    const dispatcher = createReturnsDispatcher({
      authorizer: { recheck: () => null },
      isStopped: () => false,
      client: createReturnsClient({ baseUrl: BASE_URL, fetch: h.backend.fetch }),
      repo: h.repo,
      dispositions: h.dispositions,
      authFailures: {
        markAttempt: () => undefined,
        reached: () => {
          throw new Error('db busy');
        },
      },
      audit: createReturnsAudit({
        sink: h.auditSink,
        now: () => h.state.now,
        newEventId: () => `evt-auth-${String((seq += 1))}`,
      }),
      now: () => h.state.now,
      logger: { warn: (_obj, msg) => warnings.push(msg) },
      transaction: <T>(fn: () => T): T => h.handle.transaction(fn)(),
    });
    h.backend.onReturn = () => jsonResponse(401, errorBody('x'));
    const entry = h.repo.read(returnId);
    if (entry === null) throw new Error('no journal row');

    await dispatcher.send(entry, 'resend', MANAGER_ACTOR);

    expect(warnings).toContain('returns:auth_failure_check_failed');
    expect(kinds(returnId)).toEqual([]);
    expect(h.audits.at(-1)).toMatchObject({
      action_category: 'sale.return.attempt_unknown',
      payload: { cause: 'pre_replay_401', operation: 'resend' },
    });
  });
});
