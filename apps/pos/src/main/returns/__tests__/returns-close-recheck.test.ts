/**
 * RT-1498 close slice (review LOW-1) — the close re-checks, INSIDE its transaction and from a fresh read
 * of the journal, that the fresh server verdict still covers the return's last send and that the quiet
 * period is still shown. The checks before the transaction run synchronously just ahead of it, so the
 * transaction hook below is the only place a test can move the row or the clock in between.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createReturnsAudit } from '../returns-audit.js';
import { createReturnsCloseService } from '../returns-close-service.js';
import type { QuietPeriodCheck } from '../returns-quiet-period.js';
import {
  LINE_A,
  MANAGER_ACTOR,
  SALE_NUMBER,
  initReturnsSql,
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

const APPROVAL = '0190f5a2-7b3c-4d4e-8f90-0000000000ef';

/** A lost return, and a close service whose transaction hook runs `between` just before the body. */
async function closing(between: () => void, quiet: () => QuietPeriodCheck) {
  h = returnsHarness();
  seedSyncedSale(h.db);
  h.backend.onReturn = () => Promise.reject(new TypeError('ECONNREFUSED'));
  const res = await h.service.submit({
    saleNumber: SALE_NUMBER,
    lines: [{ lineRef: LINE_A, quantity: 1 }],
  });
  if (res.kind !== 'unconfirmed') throw new Error(res.kind);
  let seq = 0;
  const service = createReturnsCloseService({
    authorizer: { current: () => ({ kind: 'ok', actor: MANAGER_ACTOR }), recheck: () => null },
    isStopped: () => false,
    repo: h.repo,
    dispositions: h.dispositions,
    status: { readStatus: () => Promise.resolve({ kind: 'not_recorded' }) },
    availability: { note: () => undefined },
    quiet: { check: quiet },
    sends: { isSending: () => false },
    audit: createReturnsAudit({
      sink: h.auditSink,
      now: () => h.state.now,
      newEventId: () => `evt-recheck-${String((seq += 1))}`,
    }),
    views: () => [],
    transaction: <T>(fn: () => T): T => {
      between();
      return h.handle.transaction(fn)();
    },
    now: () => h.state.now,
    newDispositionId: () => '0192f5a2-3b4c-7d8e-9f01-0000000000d7',
  });
  return { service, returnId: res.ret.returnId };
}

const ELAPSED: QuietPeriodCheck = { kind: 'elapsed' };

describe('the close transaction re-checks the return and the quiet period', () => {
  it('refuses send_in_flight when a send ran between the read and the commit, and writes nothing', async () => {
    let id = '';
    const { service, returnId } = await closing(
      () => {
        h.repo.recordAttempt({ returnId: id, now: '2026-10-04T10:00:30.000Z' });
      },
      () => ELAPSED,
    );
    id = returnId;

    const res = await service.close({ returnId, approvalId: APPROVAL });

    expect(res).toMatchObject({ kind: 'refused', reason: 'send_in_flight' });
    expect(h.dispositions.listFor(returnId)).toEqual([]);
  });

  it.each([
    ['reconcile_too_soon', { kind: 'too_soon', notBefore: '2026-10-04T10:15:00.000Z' }],
    ['quiet_period_unproven', { kind: 'unproven', cause: 'clock_step' }],
  ] as const)('refuses %s when the period stops being shown', async (reason, later) => {
    let calls = 0;
    const { service, returnId } = await closing(
      () => undefined,
      // The two checks before the transaction see it elapsed; the one inside no longer does.
      () => (++calls <= 2 ? ELAPSED : later),
    );

    const res = await service.close({ returnId, approvalId: APPROVAL });

    expect(res).toMatchObject({ kind: 'refused', reason });
    expect(h.dispositions.listFor(returnId)).toEqual([]);
  });

  it('closes when nothing moved (the approval is the only thing missing: fail closed without one)', async () => {
    const { service, returnId } = await closing(
      () => undefined,
      () => ELAPSED,
    );
    // No approval service is composed: the spend refuses, after the re-checks passed.
    const res = await service.close({ returnId, approvalId: APPROVAL });
    expect(res).toMatchObject({ kind: 'refused', reason: 'approval_invalid' });
  });
});
