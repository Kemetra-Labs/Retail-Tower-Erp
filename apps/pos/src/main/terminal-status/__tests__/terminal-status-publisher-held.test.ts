/**
 * RT-887 — the publisher carries the aggregate's `held` count (the discount-held
 * subset of `pending`) to the snapshot when there is one, and adds nothing
 * when there is none, so a terminal with no held sale publishes exactly the
 * RT-603 snapshot.
 */
import { describe, expect, it } from 'vitest';

import { createTerminalStatusPublisher } from '../terminal-status-publisher.js';
import type { TerminalSyncAggregate } from '../sync-aggregate.js';

const AGGREGATE: TerminalSyncAggregate = {
  pending: 3,
  heldPreviousPairing: 0,
  deadLetter: 0,
  oldestPendingAt: '2026-10-17T09:00:00.000Z',
  paused: null,
  lastSuccessAt: null,
};

function publisherWith(aggregate: TerminalSyncAggregate) {
  const publisher = createTerminalStatusPublisher({
    readConnection: () => ({
      connection: 'online',
      connectionSince: '2026-10-17T09:59:00.000Z',
      lastContactAt: '2026-10-17T09:59:59.000Z',
    }),
    isDeviceGated: () => false,
    send: () => undefined,
    now: () => Date.parse('2026-10-17T10:00:00.000Z'),
    monotonicNow: () => 0,
    logger: { warn: () => undefined },
  });
  publisher.setSyncReader(() => Promise.resolve(aggregate));
  return publisher;
}

describe('RT-887 terminal status publisher — held', () => {
  it('carries a held count to the snapshot', async () => {
    const snap = await publisherWith({ ...AGGREGATE, held: 2 }).read();
    expect(snap.sync).toEqual({ ...AGGREGATE, held: 2 });
  });

  it('adds no `held` key when the aggregate has none', async () => {
    const snap = await publisherWith(AGGREGATE).read();
    expect(snap.sync).toEqual(AGGREGATE);
    expect(snap.sync).not.toHaveProperty('held');
  });

  it('a zero held count is the same as none', async () => {
    const snap = await publisherWith({ ...AGGREGATE, held: 0 }).read();
    expect(snap.sync).not.toHaveProperty('held');
  });
});
