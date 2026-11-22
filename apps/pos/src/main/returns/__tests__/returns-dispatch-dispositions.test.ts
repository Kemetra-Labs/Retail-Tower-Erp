/**
 * RT-1498 S4 — the dispatcher and the return dispositions (RT-196 design §3.4):
 *   • a 2xx that does not match the journaled return, or cannot be read (U-3 / U-4), writes exactly
 *     one automatic `needs_support` (source `send_response`, no approval, no actor) in the SAME
 *     transaction as the unknown transition, with its audit; a later one writes no second row;
 *   • the resolver and the bar skip a needs_support row; the explicit per-row resend does not, and
 *     a matching answer still confirms it;
 *   • the dispatch COMMIT POINT re-reads the disposition: a closed row is never sent, by any
 *     operation, even from a stale snapshot; a needs_support row is not sent by a background or bar
 *     send, only by the explicit resend.
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
  categories,
  initReturnsSql,
  jsonResponse,
  returnsHarness,
  saleReturnFor,
  seedSyncedSale,
  type ReturnResponder,
  type ReturnsHarness,
} from './__helpers__/returns-fixture.js';
import { closing, escalation, seedResolveApproval } from './__helpers__/dispositions-fixture.js';

beforeAll(async () => {
  await initReturnsSql();
});

let h: ReturnsHarness;

afterEach(() => {
  h.close();
});

const ONE_A = { saleNumber: SALE_NUMBER, lines: [{ lineRef: LINE_A, quantity: 1 }] };

function harness(): ReturnsHarness {
  h = returnsHarness();
  seedSyncedSale(h.db);
  return h;
}

const lost: ReturnResponder = () => Promise.reject(new TypeError('ECONNREFUSED'));
const mismatch: ReturnResponder = (call) =>
  jsonResponse(201, {
    ...saleReturnFor(JSON.parse(call.body ?? '{}') as never),
    returnTotal: '14.0000',
  });
const unreadable: ReturnResponder = () => jsonResponse(201, { ok: true });

async function submitWith(respond: ReturnResponder): Promise<string> {
  h.backend.onReturn = respond;
  const res = await h.service.submit(ONE_A);
  if (res.kind !== 'unconfirmed') throw new Error(`submitWith: ${res.kind}`);
  return res.ret.returnId;
}

function entryOf(returnId: string): JournalEntry {
  const entry = h.repo.read(returnId);
  if (entry === null) throw new Error('no journal row');
  return entry;
}

let eventSeq = 0;

/** A second dispatcher over the same journal, as a stale resolver pass would hold. */
function standaloneDispatcher() {
  return createReturnsDispatcher({
    authorizer: { recheck: () => null },
    isStopped: () => false,
    client: createReturnsClient({ baseUrl: BASE_URL, fetch: h.backend.fetch }),
    repo: h.repo,
    dispositions: h.dispositions,
    audit: createReturnsAudit({
      sink: h.auditSink,
      now: () => NOW,
      newEventId: () => `evt-${String((eventSeq += 1))}`,
    }),
    now: () => NOW,
    logger: { warn: () => undefined },
    transaction: <T>(fn: () => T): T => h.handle.transaction(fn)(),
  });
}

describe('an answer the till cannot match raises needs_support by itself (U-3, U-4)', () => {
  it.each([
    ['a confirmation that names another total', mismatch],
    ['a 2xx body that cannot be read', unreadable],
  ])(
    '%s writes one needs_support / send_response with no approval and no actor',
    async (_n, respond) => {
      harness();
      const returnId = await submitWith(respond);

      expect(h.dispositions.listFor(returnId)).toEqual([
        expect.objectContaining({
          returnId,
          kind: 'needs_support',
          verdictSource: 'send_response',
          reason: 'mismatch',
          approvalId: null,
          actorOperatorId: null,
          readVerdictAt: null,
        }),
      ]);
      expect(entryOf(returnId).state).toBe('unknown');
      // It only restricts: the sale stays blocked (OD-196-4) and nothing is payout-ready.
      expect(h.repo.hasUnresolvedForSale('sale-1')).toBe(true);
      expect(categories(h.audits)).toEqual([
        'sale.return.attempted',
        'sale.return.attempt_unknown',
        'sale.return.needs_support',
      ]);
      expect(h.audits.at(-1)?.payload).toEqual({
        return_id: returnId,
        approval_id: null,
        verdict_source: 'send_response',
        reason: 'mismatch',
      });
    },
  );

  it('a lost answer (a timeout) raises nothing: it is only unknown', async () => {
    harness();
    const returnId = await submitWith(lost);
    expect(h.dispositions.listFor(returnId)).toEqual([]);
    expect(categories(h.audits)).toEqual(['sale.return.attempted', 'sale.return.attempt_unknown']);
  });

  it('a second mismatching answer writes no second needs_support and no second audit', async () => {
    harness();
    const returnId = await submitWith(mismatch);
    const again = await h.service.resend({ returnId });

    expect(again.kind).toBe('unconfirmed');
    expect(h.dispositions.listFor(returnId)).toHaveLength(1);
    expect(categories(h.audits).filter((c) => c === 'sale.return.needs_support')).toHaveLength(1);
  });

  it('commits with the unknown transition or not at all: a failed audit leaves no disposition', async () => {
    harness();
    h.state.failAudit = (event) => event.action_category === 'sale.return.needs_support';
    const returnId = await submitWith(mismatch);
    h.state.failAudit = null;

    // The local commit failed as one unit: the row is still unknown (never left pending) and no
    // half-written disposition remains.
    expect(entryOf(returnId).state).toBe('unknown');
    expect(h.dispositions.listFor(returnId)).toEqual([]);
  });
});

describe('who resends a needs_support row', () => {
  it('the resolver and the bar skip it: nothing is sent', async () => {
    harness();
    const returnId = await submitWith(mismatch);
    const sentBefore = h.backend.returnCalls().length;

    const pass = await h.service.resolve();

    expect(pass).toMatchObject({ kind: 'ok', confirmed: 0, refused: 0, unresolved: 0 });
    expect(h.backend.returnCalls()).toHaveLength(sentBefore);
    expect(entryOf(returnId).state).toBe('unknown');
  });

  it('the explicit per-row resend still sends it, and a matching answer confirms it', async () => {
    harness();
    const returnId = await submitWith(mismatch);
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);

    const res = await h.service.resend({ returnId });

    expect(res.kind).toBe('confirmed');
    expect(entryOf(returnId).state).toBe('confirmed');
    // The needs_support record stays as history; the row is no longer unresolved.
    expect(h.dispositions.listFor(returnId)).toHaveLength(1);
    expect(h.repo.hasUnresolvedForSale('sale-1')).toBe(false);
  });
});

describe('the dispatch commit point re-reads the disposition', () => {
  it.each(['submit', 'resolve', 'resend'] as const)(
    'never sends a CLOSED return, on %s, even from a stale snapshot',
    async (operation) => {
      harness();
      const returnId = await submitWith(lost);
      const stale = entryOf(returnId);
      seedResolveApproval(h.db, { returnId, disposition: 'close', amountMinor: 1500 });
      h.dispositions.insert(closing({ returnId }));
      const sentBefore = h.backend.returnCalls().length;
      h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);

      const out = await standaloneDispatcher().send(stale, operation, MANAGER_ACTOR);

      expect(out).toMatchObject({ kind: 'deferred', by: 'disposition' });
      expect(h.backend.returnCalls()).toHaveLength(sentBefore);
      expect(entryOf(returnId)).toMatchObject({ state: 'unknown', attemptCount: 1 });
    },
  );

  it.each(['submit', 'resolve'] as const)(
    'does not send a needs_support return on %s, even from a snapshot taken before it was raised',
    async (operation) => {
      harness();
      const returnId = await submitWith(lost);
      const stale = entryOf(returnId);
      seedResolveApproval(h.db, { returnId, disposition: 'escalate', amountMinor: 1500 });
      h.dispositions.insert(escalation({ returnId }));
      const sentBefore = h.backend.returnCalls().length;

      const out = await standaloneDispatcher().send(stale, operation, MANAGER_ACTOR);

      expect(out).toMatchObject({ kind: 'deferred', by: 'disposition' });
      expect(h.backend.returnCalls()).toHaveLength(sentBefore);
    },
  );

  it('sends a needs_support return on the explicit resend', async () => {
    harness();
    const returnId = await submitWith(lost);
    const stale = entryOf(returnId);
    seedResolveApproval(h.db, { returnId, disposition: 'escalate', amountMinor: 1500 });
    h.dispositions.insert(escalation({ returnId }));
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);

    const out = await standaloneDispatcher().send(stale, 'resend', MANAGER_ACTOR);

    expect(out.kind).toBe('confirmed');
  });

  it('a return with no disposition is sent as before', async () => {
    harness();
    const returnId = await submitWith(lost);
    h.backend.onReturn = (call, backend) => backend.recordIdempotently(call);
    const out = await standaloneDispatcher().send(entryOf(returnId), 'resolve', MANAGER_ACTOR);
    expect(out.kind).toBe('confirmed');
  });
});
