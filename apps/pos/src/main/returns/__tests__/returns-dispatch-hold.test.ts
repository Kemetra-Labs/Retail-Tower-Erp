/**
 * RT-1498 close slice — the dispatcher and the quiet period:
 *   • every attempt is anchored for the quiet period (the SAME stamp the journal records);
 *   • the dispatch COMMIT POINT also re-reads a `retry_hold` (a status read answered "not recorded"):
 *     a background or bar send is deferred while the hold is newer than the last attempt, even from a
 *     snapshot taken before the hold was written; the explicit per-row resend is not, and voids it;
 *   • `isSending` says whether a send of one return is in flight (a close is refused meanwhile).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createReturnsAudit } from '../returns-audit.js';
import { createReturnsClient } from '../returns-client.js';
import { createReturnsDispatcher } from '../returns-dispatch.js';
import type { JournalEntry } from '../returns-repository.js';
import {
  MANAGER_ACTOR,
  BASE_URL,
  LINE_A,
  NOW,
  SALE_NUMBER,
  initReturnsSql,
  returnsHarness,
  secondsAfterNow,
  seedSyncedSale,
  deferredFake,
  type ReturnResponder,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';
import { escalation } from './__helpers__/dispositions-fixture.js';

beforeAll(async () => {
  await initReturnsSql();
});

let h: ReturnsHarness;

afterEach(() => {
  h.close();
});

const ONE_A = { saleNumber: SALE_NUMBER, lines: [{ lineRef: LINE_A, quantity: 1 }] };
const lost: ReturnResponder = () => Promise.reject(new TypeError('ECONNREFUSED'));

function entryOf(returnId: string): JournalEntry {
  const entry = h.repo.read(returnId);
  if (entry === null) throw new Error('no journal row');
  return entry;
}

async function lostReturn(): Promise<string> {
  h = returnsHarness();
  seedSyncedSale(h.db);
  h.backend.onReturn = lost;
  const res = await h.service.submit(ONE_A);
  if (res.kind !== 'unconfirmed') throw new Error(`lostReturn: ${res.kind}`);
  return res.ret.returnId;
}

function standalone(extra: Partial<Parameters<typeof createReturnsDispatcher>[0]> = {}) {
  let seq = 0;
  return createReturnsDispatcher({
    authorizer: { recheck: () => null },
    isStopped: () => false,
    client: createReturnsClient({ baseUrl: BASE_URL, fetch: h.backend.fetch }),
    repo: h.repo,
    dispositions: h.dispositions,
    audit: createReturnsAudit({
      sink: h.auditSink,
      now: () => h.state.now,
      newEventId: () => `evt-hold-${String((seq += 1))}`,
    }),
    now: () => h.state.now,
    logger: { warn: () => undefined },
    transaction: <T>(fn: () => T): T => h.handle.transaction(fn)(),
    ...extra,
  });
}

/** A `retry_hold` written at `at` for `returnId`. */
function hold(returnId: string, at: string): void {
  h.dispositions.insert(
    escalation({
      returnId,
      kind: 'retry_hold',
      verdictSource: 'provenance_read',
      reason: 'not_recorded',
      approvalId: null,
      readVerdictAt: at,
      createdAt: at,
    }),
  );
}

describe('every attempt is anchored for the quiet period', () => {
  it('marks the attempt with the same stamp the journal records, once per send', async () => {
    h = returnsHarness();
    seedSyncedSale(h.db);
    h.backend.onReturn = lost;
    const marks: [string, string][] = [];
    const returnId = await (async () => {
      const res = await h.service.submit(ONE_A);
      if (res.kind !== 'unconfirmed') throw new Error(res.kind);
      return res.ret.returnId;
    })();
    marks.length = 0;
    h.state.now = secondsAfterNow(30);
    const dispatcher = standalone({
      quiet: { markAttempt: (id, stamp) => marks.push([id, stamp]) },
    });

    await dispatcher.send(entryOf(returnId), 'resend', MANAGER_ACTOR);

    expect(marks).toEqual([[returnId, secondsAfterNow(30)]]);
    expect(entryOf(returnId).lastAttemptAt).toBe(secondsAfterNow(30));
  });

  it('marks nothing for a send that never went out (a closed or held return)', async () => {
    const returnId = await lostReturn();
    hold(returnId, secondsAfterNow(10));
    const marks: string[] = [];
    h.state.now = secondsAfterNow(20);
    const dispatcher = standalone({ quiet: { markAttempt: (id) => marks.push(id) } });

    const out = await dispatcher.send(entryOf(returnId), 'resolve', MANAGER_ACTOR);

    expect(out).toMatchObject({ kind: 'deferred', by: 'disposition' });
    expect(marks).toEqual([]);
  });
});

describe('the commit point honours a retry_hold', () => {
  it.each(['submit', 'resolve'] as const)(
    'does not send on %s while the hold is newer than the last attempt, even from a stale snapshot',
    async (operation) => {
      const returnId = await lostReturn();
      const stale = entryOf(returnId);
      h.state.now = secondsAfterNow(60);
      hold(returnId, secondsAfterNow(60));
      const sentBefore = h.backend.returnCalls().length;
      h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);

      const out = await standalone().send(stale, operation, MANAGER_ACTOR);

      expect(out).toMatchObject({ kind: 'deferred', by: 'disposition' });
      expect(h.backend.returnCalls()).toHaveLength(sentBefore);
      expect(entryOf(returnId).attemptCount).toBe(1);
    },
  );

  it('the resolver pass and the bar leave a held row alone', async () => {
    const returnId = await lostReturn();
    h.state.now = secondsAfterNow(60);
    hold(returnId, secondsAfterNow(60));
    const sentBefore = h.backend.returnCalls().length;

    const pass = await h.service.resolve();

    expect(pass).toMatchObject({ kind: 'ok', confirmed: 0, refused: 0, unresolved: 0 });
    expect(h.backend.returnCalls()).toHaveLength(sentBefore);
  });

  it('the explicit resend is not held, and the attempt it records voids the hold', async () => {
    const returnId = await lostReturn();
    h.state.now = secondsAfterNow(60);
    hold(returnId, secondsAfterNow(60));
    h.state.now = secondsAfterNow(90);

    const res = await h.service.resend({ returnId });

    expect(res.kind).toBe('unconfirmed');
    expect(entryOf(returnId).attemptCount).toBe(2);
    expect(h.dispositions.hasEffectiveHold(returnId, entryOf(returnId).lastAttemptAt)).toBe(false);
    // With the hold void, the resolver sends again.
    h.state.now = secondsAfterNow(120);
    const sentBefore = h.backend.returnCalls().length;
    await h.service.resolve();
    expect(h.backend.returnCalls()).toHaveLength(sentBefore + 1);
  });

  it('a hold OLDER than the last attempt does not hold the send', async () => {
    const returnId = await lostReturn();
    h.state.now = NOW;
    hold(returnId, NOW); // equal to the attempt stamp: not newer
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
    const out = await standalone().send(entryOf(returnId), 'resolve', MANAGER_ACTOR);
    expect(out.kind).toBe('confirmed');
  });
});

describe('isSending', () => {
  it('is true while a send of that return is in flight, and only for it', async () => {
    const returnId = await lostReturn();
    const gate = deferredFake<Response>();
    h.backend.onReturn = () => gate.promise;
    const dispatcher = standalone();

    const sending = dispatcher.send(entryOf(returnId), 'resend', MANAGER_ACTOR);

    expect(dispatcher.isSending(returnId)).toBe(true);
    expect(dispatcher.isSending('another-return')).toBe(false);
    gate.resolve(new Response('{}', { status: 500 }));
    await sending;
    expect(dispatcher.isSending(returnId)).toBe(false);
  });
});
