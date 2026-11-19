/**
 * RT-1490 — one drain of the unknown-item capture queue, on the real store.
 *
 *   • no envelope (no operator signed in) or no pairing → nothing is sent and
 *     every row stays queued (never dropped);
 *   • 2xx → sent; a final 4xx (400, 409 key conflict) → refused, never resent;
 *   • 5xx / 429 → the row stays pending with backoff and the drain stops (one
 *     request per tick to a failing server); the resend carries the SAME key;
 *   • 401 / 403 → the drain stops and no row is charged (the envelope is at
 *     fault), so the rows go as soon as a good envelope is there;
 *   • offline (no answer) → the flush stops at once, the row is untouched, and
 *     the next flush after reconnect sends it with the same key;
 *   • a stop latched mid-flush sends no more rows.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqlJsDatabase } from 'sql.js';

import {
  freshCatalogueDb,
  handleFor,
  initCatalogueSql,
} from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import type { CaptureSendInput, CaptureSendOutcome } from '../capture-client.js';
import { drainUnknownItemCaptures, type CaptureDrainDeps } from '../capture-drain.js';
import { bindUnknownItemCaptureStore, type CaptureScope } from '../capture-store.js';

const SCOPE: CaptureScope = {
  tenantId: 'tenant-1',
  branchId: 'branch-1',
  terminalId: 'terminal-1',
};
const ID_1 = '0192f5a2-3b4c-7d8e-9f01-000000000001';
const ID_2 = '0192f5a2-3b4c-7d8e-9f01-000000000002';
const T0 = '2026-11-19T10:00:00.000Z';
const BACKOFF = { baseMs: 5_000, maxMs: 300_000 };

let db: SqlJsDatabase;

beforeAll(async () => {
  await initCatalogueSql();
});

beforeEach(() => {
  db = freshCatalogueDb();
});

afterEach(() => {
  db.close();
});

function seed(captureId: string, barcode: string) {
  bindUnknownItemCaptureStore(handleFor(db)).enqueue({
    captureId,
    scope: SCOPE,
    barcode,
    day: '2026-11-19',
    at: T0,
  });
}

function state(): unknown[][] {
  return (
    db.exec(
      'SELECT capture_id, state, attempts, last_status, next_attempt_at FROM unknown_item_captures ORDER BY capture_id',
    )[0]?.values ?? []
  );
}

/** A fake client answering from a queue of outcomes, recording each send. */
function fakeClient(answers: CaptureSendOutcome[]) {
  const sent: CaptureSendInput[] = [];
  return {
    sent,
    send(input: CaptureSendInput): Promise<CaptureSendOutcome> {
      sent.push(input);
      return Promise.resolve(answers.shift() ?? { kind: 'accepted', status: 201 });
    },
  };
}

function deps(
  client: ReturnType<typeof fakeClient>,
  o: Partial<CaptureDrainDeps> = {},
): CaptureDrainDeps {
  return {
    store: bindUnknownItemCaptureStore(handleFor(db)),
    client,
    scope: () => SCOPE,
    getEnvelope: () => 'env-1',
    now: () => new Date(T0),
    isStopped: () => false,
    backoff: BACKOFF,
    ...o,
  };
}

describe('RT-1490 — unknown item capture drain', () => {
  it('sends nothing and keeps the row queued with no operator envelope', async () => {
    seed(ID_1, '111');
    const client = fakeClient([]);
    expect(await drainUnknownItemCaptures(deps(client, { getEnvelope: () => null }))).toEqual({
      kind: 'idle',
    });
    expect(client.sent).toEqual([]);
    expect(state()).toEqual([[ID_1, 'pending', 0, null, T0]]);
  });

  it('sends nothing while unpaired', async () => {
    seed(ID_1, '111');
    const client = fakeClient([]);
    expect(await drainUnknownItemCaptures(deps(client, { scope: () => null }))).toEqual({
      kind: 'idle',
    });
    expect(client.sent).toEqual([]);
  });

  it('is idle with nothing due', async () => {
    expect(await drainUnknownItemCaptures(deps(fakeClient([])))).toEqual({ kind: 'idle' });
  });

  it('marks a 2xx sent, with the row key and barcode on the wire', async () => {
    seed(ID_1, '111');
    const client = fakeClient([{ kind: 'accepted', status: 201 }]);
    expect(await drainUnknownItemCaptures(deps(client))).toEqual({ kind: 'progress' });
    expect(client.sent).toEqual([{ captureId: ID_1, barcode: '111', envelope: 'env-1' }]);
    expect(state()).toEqual([[ID_1, 'sent', 0, 201, T0]]);
  });

  it.each([400, 409, 422])('refuses a final %i for good and never resends it', async (status) => {
    seed(ID_1, '111');
    const client = fakeClient([{ kind: 'refused', status }]);
    await drainUnknownItemCaptures(deps(client));
    expect(state()).toEqual([[ID_1, 'refused', 0, status, T0]]);
    await drainUnknownItemCaptures(deps(client));
    expect(client.sent).toHaveLength(1);
  });

  it('keeps a 5xx pending with backoff, then resends it with the same key', async () => {
    seed(ID_1, '111');
    const client = fakeClient([
      { kind: 'retry', status: 503 },
      { kind: 'accepted', status: 200 },
    ]);
    expect(await drainUnknownItemCaptures(deps(client))).toEqual({ kind: 'retry' });
    expect(state()).toEqual([[ID_1, 'pending', 1, 503, '2026-11-19T10:00:05.000Z']]);

    // Not due before its backoff ends.
    await drainUnknownItemCaptures(
      deps(client, { now: () => new Date('2026-11-19T10:00:04.000Z') }),
    );
    expect(client.sent).toHaveLength(1);

    await drainUnknownItemCaptures(
      deps(client, { now: () => new Date('2026-11-19T10:00:05.000Z') }),
    );
    expect(client.sent.map((s) => s.captureId)).toEqual([ID_1, ID_1]);
    expect(state()[0]?.[1]).toBe('sent');
  });

  it('doubles the per-row backoff on each retry', async () => {
    seed(ID_1, '111');
    const client = fakeClient([
      { kind: 'retry', status: 429 },
      { kind: 'retry', status: 500 },
    ]);
    await drainUnknownItemCaptures(deps(client));
    await drainUnknownItemCaptures(
      deps(client, { now: () => new Date('2026-11-19T10:00:05.000Z') }),
    );
    expect(state()).toEqual([[ID_1, 'pending', 2, 500, '2026-11-19T10:00:15.000Z']]);
  });

  it('stops at the first retryable answer: only that row is charged', async () => {
    seed(ID_1, '111');
    seed(ID_2, '222');
    const client = fakeClient([{ kind: 'retry', status: 503 }]);
    expect(await drainUnknownItemCaptures(deps(client))).toEqual({ kind: 'retry' });
    expect(client.sent).toHaveLength(1);
    expect(state()).toEqual([
      [ID_1, 'pending', 1, 503, '2026-11-19T10:00:05.000Z'],
      [ID_2, 'pending', 0, null, T0],
    ]);
  });

  it.each([401, 403])(
    'a %i stops the drain and charges no row; the next envelope sends them',
    async (status) => {
      seed(ID_1, '111');
      seed(ID_2, '222');
      const client = fakeClient([{ kind: 'unauthorized', status }]);
      expect(await drainUnknownItemCaptures(deps(client))).toEqual({ kind: 'retry' });
      expect(client.sent).toHaveLength(1);
      expect(state()).toEqual([
        [ID_1, 'pending', 0, null, T0],
        [ID_2, 'pending', 0, null, T0],
      ]);

      expect(await drainUnknownItemCaptures(deps(client, { getEnvelope: () => 'env-2' }))).toEqual({
        kind: 'progress',
      });
      expect(client.sent.map((s) => [s.captureId, s.envelope])).toEqual([
        [ID_1, 'env-1'],
        [ID_1, 'env-2'],
        [ID_2, 'env-2'],
      ]);
    },
  );

  it('offline: stops at the first unanswered send, leaves the rows, drains on reconnect', async () => {
    seed(ID_1, '111');
    seed(ID_2, '222');
    const client = fakeClient([{ kind: 'unreachable' }]);
    expect(await drainUnknownItemCaptures(deps(client))).toEqual({ kind: 'undelivered' });
    expect(client.sent).toHaveLength(1);
    expect(state()).toEqual([
      [ID_1, 'pending', 0, null, T0],
      [ID_2, 'pending', 0, null, T0],
    ]);

    // Reconnected: both go, with the keys they were minted with.
    expect(await drainUnknownItemCaptures(deps(client))).toEqual({ kind: 'progress' });
    expect(client.sent.map((s) => s.captureId)).toEqual([ID_1, ID_1, ID_2]);
    expect(state().map((r) => r[1])).toEqual(['sent', 'sent']);
  });

  it('sends no more rows once stopped', async () => {
    seed(ID_1, '111');
    seed(ID_2, '222');
    let stopped = false;
    const client = fakeClient([]);
    const original = client.send.bind(client);
    client.send = (input) => {
      stopped = true;
      return original(input);
    };
    await drainUnknownItemCaptures(deps(client, { isStopped: () => stopped }));
    expect(client.sent).toHaveLength(1);
    // The answer that arrived after the stop is not written to the closing DB.
    expect(state().map((r) => r[1])).toEqual(['pending', 'pending']);
  });
});
