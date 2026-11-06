/**
 * T047 / RT-1231 — Unit tests: audit sync (outbox → Backend-Core).
 *
 * `AuditSync.flush()`:
 *   1. sends only the RT-160 D-2 central categories; every other one is marked
 *      local-only and never sent (category filter);
 *   2. marks `accepted` and `duplicates` synced (success);
 *   3. marks a `schema_violation` final: settled, never sent again;
 *   4. leaves other rejections in the outbox, retried at most
 *      `maxEventAttempts` times, then parks them (bounded retry);
 *   5. writes nothing on a network failure or a malformed answer and asks the
 *      caller to back off; the events go on the next flush (offline);
 *   6. settles locally an event that is off-contract (the server would 400
 *      the whole batch);
 *   7. writes nothing once stopped (shutdown latch).
 *
 * Store and client are injected fakes — no real DB or network.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AuditSync,
  type AuditEventKey,
  type AuditSyncStore,
  type AuditSyncClient,
  type AuditSyncBatchResponse,
} from '../audit-sync.js';
import type { AuditEvent } from '../../../shared/audit/event-shape.js';

// ─── Fixture data ──────────────────────────────────────────────────────────

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const BRANCH = '33333333-3333-4333-8333-333333333333';
const TERMINAL = '44444444-4444-4444-8444-444444444444';

/** A deterministic UUID for a short label (`evt(1)`). */
function evt(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function makeEvent(id: string, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    event_id: id,
    tenant_id: TENANT_A,
    branch_id: BRANCH,
    originating_terminal_id: TERMINAL,
    acting_operator_id: 'user_clerk1',
    session_id: null,
    shift_id: null,
    action_category: 'shift.forced_close',
    created_at: '2026-05-07T10:00:00.000Z',
    approving_supervisor_id: null,
    payload: {},
    ...overrides,
  };
}

// ─── Fake store ────────────────────────────────────────────────────────────

interface FakeStore {
  store: AuditSyncStore;
  unsynced: AuditEvent[];
  syncedIds: AuditEventKey[];
  settledIds: AuditEventKey[];
}

function makeFakeStore(initial: AuditEvent[] = []): FakeStore {
  const unsynced = [...initial];
  const syncedIds: AuditEventKey[] = [];
  const settledIds: AuditEventKey[] = [];
  const remove = (tenant_id: string, event_id: string): void => {
    const idx = unsynced.findIndex((e) => e.tenant_id === tenant_id && e.event_id === event_id);
    if (idx !== -1) unsynced.splice(idx, 1);
  };

  const store: AuditSyncStore = {
    listUnsynced(limit: number, exclude: readonly string[] = []): AuditEvent[] {
      return unsynced.filter((e) => !exclude.includes(e.event_id)).slice(0, limit);
    },
    markSynced(tenant_id: string, event_id: string): void {
      remove(tenant_id, event_id);
      syncedIds.push({ tenant_id, event_id });
    },
    markSettled(keys: readonly AuditEventKey[]): void {
      for (const key of keys) {
        remove(key.tenant_id, key.event_id);
        settledIds.push(key);
      }
    },
  };

  return { store, unsynced, syncedIds, settledIds };
}

// ─── Fake client ───────────────────────────────────────────────────────────

function makeFakeClient(response: AuditSyncBatchResponse | 'network_error'): {
  client: AuditSyncClient;
  calls: AuditEvent[][];
} {
  const calls: AuditEvent[][] = [];
  const client: AuditSyncClient = {
    sendBatch(events: AuditEvent[]): Promise<AuditSyncBatchResponse | 'network_error'> {
      calls.push([...events]);
      return Promise.resolve(response);
    },
  };
  return { client, calls };
}

const OK_EMPTY: AuditSyncBatchResponse = { accepted: [], duplicates: [], rejected: [] };

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('AuditSync — flush() (T047)', () => {
  it('does nothing when there are no unsynced events', async () => {
    const { store } = makeFakeStore([]);
    const { client, calls } = makeFakeClient(OK_EMPTY);
    const outcome = await new AuditSync({ store, client }).flush();
    expect(calls).toHaveLength(0);
    expect(outcome).toEqual({ kind: 'idle' });
  });

  it('sends unsynced central events in a single batch call', async () => {
    const { store } = makeFakeStore([makeEvent(evt(1)), makeEvent(evt(2))]);
    const { client, calls } = makeFakeClient({
      accepted: [evt(1), evt(2)],
      duplicates: [],
      rejected: [],
    });
    await new AuditSync({ store, client }).flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.map((e) => e.event_id)).toEqual([evt(1), evt(2)]);
  });

  it('sends the full AuditEvent to the client (all fields present)', async () => {
    const event = makeEvent(evt(1));
    const { store } = makeFakeStore([event]);
    const { client, calls } = makeFakeClient({ accepted: [evt(1)], duplicates: [], rejected: [] });
    await new AuditSync({ store, client }).flush();
    expect(calls[0]?.[0]).toEqual(event);
  });

  // ── RT-1231 category filter ─────────────────────────────────────────────

  describe('RT-1231 category filter (RT-160 D-2)', () => {
    it('marks non-central categories local-only and never sends them', async () => {
      const local = [
        makeEvent(evt(1), { action_category: 'shift.open' }),
        makeEvent(evt(2), { action_category: 'shift.close' }),
        makeEvent(evt(3), { action_category: 'sale.finalized' }),
        makeEvent(evt(4), { action_category: 'operator.session.locked' }),
      ];
      const central = makeEvent(evt(5), { action_category: 'operator.session.takeover' });
      const { store, settledIds, syncedIds } = makeFakeStore([...local, central]);
      const { client, calls } = makeFakeClient({
        accepted: [evt(5)],
        duplicates: [],
        rejected: [],
      });

      const outcome = await new AuditSync({ store, client }).flush();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.map((e) => e.event_id)).toEqual([evt(5)]);
      expect(settledIds.map((k) => k.event_id)).toEqual([evt(1), evt(2), evt(3), evt(4)]);
      expect(syncedIds.map((k) => k.event_id)).toEqual([evt(5)]);
      expect(outcome).toEqual({
        kind: 'progress',
        counts: { synced: 1, localOnly: 4, final: 0, retryable: 0, parked: 0 },
      });
    });

    it('sends nothing when every listed event is local-only', async () => {
      const { store, unsynced } = makeFakeStore([
        makeEvent(evt(1), { action_category: 'cart.parked' }),
      ]);
      const { client, calls } = makeFakeClient(OK_EMPTY);
      await new AuditSync({ store, client }).flush();
      expect(calls).toHaveLength(0);
      expect(unsynced).toHaveLength(0);
    });

    it('settles local-only pages in turn until it reaches a central event', async () => {
      const events = [
        ...Array.from({ length: 5 }, (_, i) =>
          makeEvent(evt(i + 1), { action_category: 'sale.receipt.printed' }),
        ),
        makeEvent(evt(99), {
          action_category: 'payment.force_failed' as AuditEvent['action_category'],
        }),
      ];
      const { store } = makeFakeStore(events);
      const { client, calls } = makeFakeClient({
        accepted: [evt(99)],
        duplicates: [],
        rejected: [],
      });
      await new AuditSync({ store, client, batchLimit: 2 }).flush();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.map((e) => e.event_id)).toEqual([evt(99)]);
    });

    it('settles at most maxPagesPerFlush local-only pages per flush', async () => {
      const events = Array.from({ length: 10 }, (_, i) =>
        makeEvent(evt(i + 1), { action_category: 'sale.receipt.printed' }),
      );
      const { store, unsynced } = makeFakeStore(events);
      const { client } = makeFakeClient(OK_EMPTY);
      await new AuditSync({ store, client, batchLimit: 2, maxPagesPerFlush: 3 }).flush();
      expect(unsynced).toHaveLength(4);
    });
  });

  // ── Accepted / duplicates → mark synced ─────────────────────────────────

  it('marks accepted events as synced with an ISO timestamp', async () => {
    const markSynced = vi.fn();
    const { store } = makeFakeStore([makeEvent(evt(1))]);
    store.markSynced = markSynced;
    const { client } = makeFakeClient({ accepted: [evt(1)], duplicates: [], rejected: [] });
    await new AuditSync({ store, client, now: () => '2026-11-06T10:00:00.000Z' }).flush();
    expect(markSynced).toHaveBeenCalledWith(TENANT_A, evt(1), '2026-11-06T10:00:00.000Z');
  });

  it('marks duplicate events as synced (they already landed on the backend)', async () => {
    const { store, syncedIds } = makeFakeStore([makeEvent(evt(1))]);
    const { client } = makeFakeClient({ accepted: [], duplicates: [evt(1)], rejected: [] });
    await new AuditSync({ store, client }).flush();
    expect(syncedIds).toEqual([{ tenant_id: TENANT_A, event_id: evt(1) }]);
  });

  it('marks both accepted and duplicate events synced in a mixed response', async () => {
    const { store, syncedIds } = makeFakeStore([
      makeEvent(evt(1)),
      makeEvent(evt(2)),
      makeEvent(evt(3)),
    ]);
    const { client } = makeFakeClient({
      accepted: [evt(1)],
      duplicates: [evt(2)],
      rejected: [{ event_id: evt(3), category: 'invalid_input' }],
    });
    await new AuditSync({ store, client }).flush();
    expect(syncedIds.map((s) => s.event_id)).toEqual([evt(1), evt(2)]);
  });

  // ── RT-1231 non-retryable refusal ───────────────────────────────────────

  describe('RT-1231 schema_violation is final', () => {
    it('settles the event, reports it, and never sends it again', async () => {
      const { store, syncedIds, settledIds, unsynced } = makeFakeStore([makeEvent(evt(1))]);
      const sendBatch = vi.fn<AuditSyncClient['sendBatch']>().mockResolvedValue({
        accepted: [],
        duplicates: [],
        rejected: [{ event_id: evt(1), category: 'schema_violation' }],
      });
      const onEventSettled = vi.fn();
      const sync = new AuditSync({ store, client: { sendBatch }, observer: { onEventSettled } });

      const outcome = await sync.flush();
      await sync.flush();
      await sync.flush();

      expect(sendBatch).toHaveBeenCalledTimes(1);
      expect(syncedIds).toHaveLength(0);
      expect(settledIds).toEqual([{ tenant_id: TENANT_A, event_id: evt(1) }]);
      expect(unsynced).toHaveLength(0);
      expect(onEventSettled).toHaveBeenCalledWith(
        expect.objectContaining({ event_id: evt(1), action_category: 'shift.forced_close' }),
        { kind: 'rejected_final', category: 'schema_violation' },
      );
      expect(outcome).toMatchObject({ kind: 'progress', counts: { final: 1 } });
      expect(sync.status().totals.final).toBe(1);
    });
  });

  // ── RT-1231 bounded retry ───────────────────────────────────────────────

  describe('RT-1231 bounded retry of the other rejections', () => {
    it.each(['invalid_input', 'tenant_mismatch'] as const)(
      'keeps a %s event in the outbox and asks the caller to back off',
      async (category) => {
        const { store, syncedIds, settledIds, unsynced } = makeFakeStore([makeEvent(evt(1))]);
        const { client } = makeFakeClient({
          accepted: [],
          duplicates: [],
          rejected: [{ event_id: evt(1), category }],
        });
        const outcome = await new AuditSync({ store, client }).flush();
        expect(syncedIds).toHaveLength(0);
        expect(settledIds).toHaveLength(0);
        expect(unsynced).toHaveLength(1);
        expect(outcome).toMatchObject({ kind: 'retry', counts: { retryable: 1 } });
      },
    );

    it('parks the event after maxEventAttempts and stops sending it', async () => {
      const { store, settledIds, unsynced } = makeFakeStore([makeEvent(evt(1)), makeEvent(evt(2))]);
      const sendBatch = vi.fn<AuditSyncClient['sendBatch']>((events) =>
        Promise.resolve({
          accepted: events.filter((e) => e.event_id === evt(2)).map((e) => e.event_id),
          duplicates: [],
          rejected: events
            .filter((e) => e.event_id === evt(1))
            .map((e) => ({ event_id: e.event_id, category: 'invalid_input' as const })),
        }),
      );
      const onEventSettled = vi.fn();
      const sync = new AuditSync({
        store,
        client: { sendBatch },
        maxEventAttempts: 3,
        observer: { onEventSettled },
      });

      for (let i = 0; i < 6; i += 1) await sync.flush();

      // Sent on 3 flushes (attempts 1, 2, 3 → parked), never again.
      const sendsOfEvt1 = sendBatch.mock.calls.filter(([events]) =>
        events.some((e) => e.event_id === evt(1)),
      );
      expect(sendsOfEvt1).toHaveLength(3);
      expect(settledIds).toHaveLength(0);
      expect(unsynced.map((e) => e.event_id)).toEqual([evt(1)]);
      expect(sync.status().parked).toBe(1);
      expect(onEventSettled).toHaveBeenCalledWith(expect.objectContaining({ event_id: evt(1) }), {
        kind: 'parked',
        attempts: 3,
        category: 'invalid_input',
      });
    });

    it('counts an event the answer does not account for as a retryable attempt', async () => {
      const { store, unsynced } = makeFakeStore([makeEvent(evt(1))]);
      const { client } = makeFakeClient(OK_EMPTY);
      const outcome = await new AuditSync({ store, client }).flush();
      expect(unsynced).toHaveLength(1);
      expect(outcome).toMatchObject({ kind: 'retry' });
    });

    it('forgets the attempts of an event that is later accepted', async () => {
      const { store, syncedIds } = makeFakeStore([makeEvent(evt(1))]);
      const sendBatch = vi
        .fn<AuditSyncClient['sendBatch']>()
        .mockResolvedValueOnce({
          accepted: [],
          duplicates: [],
          rejected: [{ event_id: evt(1), category: 'invalid_input' }],
        })
        .mockResolvedValueOnce({ accepted: [evt(1)], duplicates: [], rejected: [] });
      const sync = new AuditSync({ store, client: { sendBatch }, maxEventAttempts: 2 });
      await sync.flush();
      await sync.flush();
      expect(syncedIds).toHaveLength(1);
      expect(sync.status().parked).toBe(0);
    });
  });

  // ── RT-1231 request-level 400 (CodeRabbit #392) ─────────────────────────

  describe('RT-1231 a request-level 400 is isolated and bounded', () => {
    /** Backend-Core: a 400 for any batch that holds `bad`, else every event accepted. */
    function refusingClient(bad: string) {
      return vi.fn<AuditSyncClient['sendBatch']>((events) =>
        Promise.resolve(
          events.some((e) => e.event_id === bad)
            ? ('batch_refused' as const)
            : { accepted: events.map((e) => e.event_id), duplicates: [], rejected: [] },
        ),
      );
    }

    it('halves the batch until the bad event goes alone, parks it, and uploads the rest', async () => {
      const events = Array.from({ length: 8 }, (_, i) => makeEvent(evt(i + 1)));
      const { store, syncedIds, unsynced } = makeFakeStore(events);
      const sendBatch = refusingClient(evt(6));
      const onEventSettled = vi.fn();
      const sync = new AuditSync({
        store,
        client: { sendBatch },
        maxEventAttempts: 2,
        observer: { onEventSettled },
      });

      for (let i = 0; i < 30; i += 1) await sync.flush();

      expect(syncedIds.map((s) => s.event_id).sort()).toEqual(
        [1, 2, 3, 4, 5, 7, 8].map(evt).sort(),
      );
      expect(unsynced.map((e) => e.event_id)).toEqual([evt(6)]);
      expect(sync.status().parked).toBe(1);
      expect(onEventSettled).toHaveBeenCalledWith(expect.objectContaining({ event_id: evt(6) }), {
        kind: 'parked',
        attempts: 2,
        category: 'batch_refused',
      });
      // Bounded: after parking, the bad event is never sent again.
      const sends = sendBatch.mock.calls.length;
      await sync.flush();
      await sync.flush();
      expect(sendBatch.mock.calls.slice(sends).flat(2)).not.toContainEqual(
        expect.objectContaining({ event_id: evt(6) }),
      );
    });

    it('a multi-event 400 writes nothing and asks the caller to back off', async () => {
      const { store, syncedIds, settledIds } = makeFakeStore([
        makeEvent(evt(1)),
        makeEvent(evt(2)),
      ]);
      const outcome = await new AuditSync({
        store,
        client: { sendBatch: refusingClient(evt(1)) },
      }).flush();
      expect(outcome).toEqual({ kind: 'undelivered' });
      expect(syncedIds).toHaveLength(0);
      expect(settledIds).toHaveLength(0);
    });

    it('a lone 400 counts as a retryable attempt', async () => {
      const { store, unsynced } = makeFakeStore([makeEvent(evt(1))]);
      const outcome = await new AuditSync({
        store,
        client: { sendBatch: refusingClient(evt(1)) },
      }).flush();
      expect(outcome).toMatchObject({ kind: 'retry', counts: { retryable: 1 } });
      expect(unsynced).toHaveLength(1);
    });
  });

  // ── RT-1231 locally off-contract ────────────────────────────────────────

  it.each([
    '2026-02-30T00:00:00Z',
    '2025-02-29T00:00:00.000Z',
    '2026-13-01T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-11-06T24:00:00Z',
    '2026-11-06T10:60:00Z',
    '2026-11-06T10:00:00+02:00',
  ])('settles locally an event created_at %s (Backend-Core would 400 the batch)', async (at) => {
    const { store, settledIds } = makeFakeStore([makeEvent(evt(1), { created_at: at })]);
    const { client, calls } = makeFakeClient(OK_EMPTY);
    await new AuditSync({ store, client }).flush();
    expect(calls).toHaveLength(0);
    expect(settledIds).toEqual([{ tenant_id: TENANT_A, event_id: evt(1) }]);
  });

  it('sends a leap-day created_at', async () => {
    const { store } = makeFakeStore([
      makeEvent(evt(1), { created_at: '2028-02-29T23:59:59.999Z' }),
    ]);
    const { client, calls } = makeFakeClient({ accepted: [evt(1)], duplicates: [], rejected: [] });
    await new AuditSync({ store, client }).flush();
    expect(calls).toHaveLength(1);
  });

  it('settles a central event that is off-contract locally instead of sending it', async () => {
    const bad = makeEvent(evt(1), { session_id: 'not-a-uuid' });
    const good = makeEvent(evt(2));
    const { store, settledIds } = makeFakeStore([bad, good]);
    const { client, calls } = makeFakeClient({ accepted: [evt(2)], duplicates: [], rejected: [] });
    const onEventSettled = vi.fn();
    await new AuditSync({ store, client, observer: { onEventSettled } }).flush();
    expect(calls[0]?.map((e) => e.event_id)).toEqual([evt(2)]);
    expect(settledIds).toEqual([{ tenant_id: TENANT_A, event_id: evt(1) }]);
    expect(onEventSettled).toHaveBeenCalledWith(expect.objectContaining({ event_id: evt(1) }), {
      kind: 'invalid_local',
    });
  });

  // ── Network failure / offline ───────────────────────────────────────────

  it('writes nothing on network failure and reports undelivered (never throws)', async () => {
    const { store, syncedIds, settledIds, unsynced } = makeFakeStore([makeEvent(evt(1))]);
    const { client } = makeFakeClient('network_error');
    const outcome = await new AuditSync({ store, client }).flush();
    expect(outcome).toEqual({ kind: 'undelivered' });
    expect(syncedIds).toHaveLength(0);
    expect(settledIds).toHaveLength(0);
    expect(unsynced).toHaveLength(1);
  });

  it('offline: nothing is lost, and the events upload on reconnect', async () => {
    const events = [makeEvent(evt(1)), makeEvent(evt(2), { action_category: 'cashier.pin.reset' })];
    const { store, syncedIds, unsynced } = makeFakeStore(events);
    const sendBatch = vi
      .fn<AuditSyncClient['sendBatch']>()
      .mockResolvedValueOnce('network_error')
      .mockResolvedValueOnce('network_error')
      .mockImplementation((batch) =>
        Promise.resolve({ accepted: batch.map((e) => e.event_id), duplicates: [], rejected: [] }),
      );
    const sync = new AuditSync({ store, client: { sendBatch }, maxEventAttempts: 1 });

    expect(await sync.flush()).toEqual({ kind: 'undelivered' });
    expect(await sync.flush()).toEqual({ kind: 'undelivered' });
    expect(unsynced).toHaveLength(2);
    // Undelivered batches never count toward the per-event bound.
    expect(sync.status().parked).toBe(0);

    await sync.flush();
    expect(syncedIds.map((s) => s.event_id)).toEqual([evt(1), evt(2)]);
    expect(unsynced).toHaveLength(0);
  });

  // ── Malformed / partial response → fail safe ────────────────────────────

  it.each([
    ['accepted is null', { accepted: null, duplicates: [], rejected: [] }],
    ['accepted is not an array', { accepted: 'x', duplicates: [], rejected: [] }],
    ['duplicates is missing', { accepted: [evt(1)], rejected: [] }],
  ])('marks nothing and backs off when %s', async (_label, body) => {
    const { store, syncedIds, settledIds } = makeFakeStore([makeEvent(evt(1))]);
    const client: AuditSyncClient = {
      sendBatch: () => Promise.resolve(body as unknown as AuditSyncBatchResponse),
    };
    const outcome = await new AuditSync({ store, client }).flush();
    expect(syncedIds).toHaveLength(0);
    expect(settledIds).toHaveLength(0);
    expect(outcome).toEqual({ kind: 'undelivered' });
  });

  // ── Shutdown latch ──────────────────────────────────────────────────────

  it('writes nothing for a send that settles after stop', async () => {
    let stopped = false;
    const { store, syncedIds } = makeFakeStore([makeEvent(evt(1))]);
    const client: AuditSyncClient = {
      sendBatch: () => {
        stopped = true;
        return Promise.resolve({ accepted: [evt(1)], duplicates: [], rejected: [] });
      },
    };
    await new AuditSync({ store, client, isStopped: () => stopped }).flush();
    expect(syncedIds).toHaveLength(0);
  });

  // ── Batch limit ─────────────────────────────────────────────────────────

  it('respects the configured batch limit and passes the parked ids', async () => {
    const listUnsynced = vi.fn().mockReturnValue([]);
    const store: AuditSyncStore = { listUnsynced, markSynced: vi.fn(), markSettled: vi.fn() };
    const { client } = makeFakeClient(OK_EMPTY);
    await new AuditSync({ store, client, batchLimit: 25 }).flush();
    expect(listUnsynced).toHaveBeenCalledWith(25, []);
  });

  it('defaults the batch limit to the contract maximum (100)', async () => {
    const listUnsynced = vi.fn().mockReturnValue([]);
    const store: AuditSyncStore = { listUnsynced, markSynced: vi.fn(), markSettled: vi.fn() };
    const { client } = makeFakeClient(OK_EMPTY);
    await new AuditSync({ store, client }).flush();
    expect(listUnsynced).toHaveBeenCalledWith(100, []);
  });

  // ── Cross-tenant safety ─────────────────────────────────────────────────

  it('marks synced with the tenant of the listed event only', async () => {
    const { store, syncedIds } = makeFakeStore([makeEvent(evt(1), { tenant_id: TENANT_A })]);
    const { client } = makeFakeClient({ accepted: [evt(1)], duplicates: [], rejected: [] });
    await new AuditSync({ store, client }).flush();
    expect(syncedIds).toEqual([{ tenant_id: TENANT_A, event_id: evt(1) }]);
    expect(syncedIds).not.toContainEqual({ tenant_id: TENANT_B, event_id: evt(1) });
  });
});
