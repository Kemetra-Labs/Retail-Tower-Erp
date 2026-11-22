/**
 * RT-1498 S4 — a send the dispatcher holds because of the ROW's disposition (a close or
 * needs_support written after the pass took its snapshot) says nothing about the actor, so the
 * resolver pass goes on to its next row. A send deferred because the ACTOR lost authorization
 * still stops the pass, as before.
 */
import { describe, expect, it } from 'vitest';

import type { AuthSnapshot } from '../returns-auth.js';
import type { DispatchOutcome, ReturnsDispatcher } from '../returns-dispatch.js';
import type { JournalEntry } from '../returns-repository.js';
import { createReturnsResolver } from '../returns-resolver.js';
import { MANAGER_ACTOR, NOW, SCOPE } from './__helpers__/returns-fixture.js';

function row(n: number): JournalEntry {
  return {
    returnId: `r${String(n)}`,
    scope: SCOPE,
    saleId: `sale-${String(n)}`,
    saleNumber: `SN-${String(n)}`,
    serverSaleRef: '0190f5a2-7b3c-7d4e-8f90-a1b2c3d4e5f6',
    externalId: `pos-pulse-return:${String(n)}`,
    operatorId: 'op',
    operatorSessionId: 'sess',
    currencyCode: 'EGP',
    quotedTotalMinor: 1500,
    requestBodyJson: '{}',
    lines: [],
    state: 'unknown',
    returnRef: null,
    returnTotalMinor: null,
    refusalReason: null,
    attemptCount: 1,
    lastAttemptAt: null,
    createdAt: NOW,
    confirmedAt: null,
  };
}

function resolverFor(rows: JournalEntry[], answer: (entry: JournalEntry) => DispatchOutcome) {
  const sent: string[] = [];
  const dispatcher: ReturnsDispatcher = {
    send: (entry) => {
      sent.push(entry.returnId);
      return Promise.resolve(answer(entry));
    },
  };
  const resolver = createReturnsResolver({
    repo: { listUnresolved: () => rows },
    dispatcher,
    authorizer: {
      current: () => ({ kind: 'refused', reason: 'no_session', actor: null }),
      recheck: () => null,
    },
    now: () => NOW,
  });
  return { resolver, sent };
}

const SNAPSHOT: AuthSnapshot = MANAGER_ACTOR;

describe('a resolver pass and a send held by the row’s disposition', () => {
  it('goes on to the next row, and counts the held one as unresolved', async () => {
    const rows = [row(1), row(2)];
    const { resolver, sent } = resolverFor(rows, (entry) =>
      entry.returnId === 'r1'
        ? { kind: 'deferred', entry, by: 'disposition' }
        : { kind: 'confirmed', entry, replayed: false },
    );

    const summary = await resolver.resolveOnce(SNAPSHOT);

    expect(sent).toEqual(['r1', 'r2']);
    expect(summary).toMatchObject({ confirmed: 1, refused: 0, unresolved: 1 });
  });

  it('still stops when the actor lost authorization', async () => {
    const rows = [row(1), row(2)];
    const { resolver, sent } = resolverFor(rows, (entry) => ({ kind: 'deferred', entry }));

    const summary = await resolver.resolveOnce(SNAPSHOT);

    expect(sent).toEqual(['r1']);
    expect(summary).toMatchObject({ confirmed: 0, refused: 0, unresolved: 2 });
  });
});
