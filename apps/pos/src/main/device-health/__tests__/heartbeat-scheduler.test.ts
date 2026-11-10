import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HeartbeatOutcome } from '../heartbeat-client.js';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MIN_GAP_MS,
  HEARTBEAT_POLL_MS,
  createHeartbeatScheduler,
  type HeartbeatSchedulerDeps,
} from '../heartbeat-scheduler.js';
import type { DeviceHeartbeatReport, SaleQueueCounts } from '../heartbeat-wire.js';

/**
 * RT-1312 Phase 1 — when the till beats: at start, every 15 minutes, soon after
 * the sale-queue counts change (polled), and on an explicit request (an update
 * state change), never two beats less than 61 s apart (Backend-Core stores one
 * per 60 s). `sale_queue` only after a reply carried revision >= 2. A failure
 * never throws; a 401 never speeds the schedule up.
 */

const ACK2: HeartbeatOutcome = { kind: 'acked', status: 200, posContractRevision: 2 };
const ACK1: HeartbeatOutcome = { kind: 'acked', status: 200, posContractRevision: 1 };
const TOKEN = 'secret-device-token';

interface Beat {
  at: number;
  body: DeviceHeartbeatReport;
}

function harness(opts: { outcomes?: HeartbeatOutcome[]; token?: string | null } = {}) {
  const t0 = Date.now();
  const beats: Beat[] = [];
  const outcomes = [...(opts.outcomes ?? [])];
  let fallback: HeartbeatOutcome = ACK2;
  let queue: SaleQueueCounts = {
    pending: 0,
    deadLetter: 0,
    heldPreviousPairing: 0,
    oldestPendingAt: null,
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const readSaleQueue = vi.fn(() => queue);
  const report = vi.fn((_token: string, body: DeviceHeartbeatReport) => {
    beats.push({ at: Date.now() - t0, body });
    return Promise.resolve(outcomes.shift() ?? fallback);
  });
  const deps: HeartbeatSchedulerDeps = {
    readToken: () => Promise.resolve(opts.token === undefined ? TOKEN : opts.token),
    readFacts: () => ({
      appVersion: null,
      updateChannel: 'canary',
      updateState: 'idle',
      pendingVersion: null,
      schemaHead: '0060_tenant_branding_cache',
      sourceClockAt: new Date(),
    }),
    readSaleQueue,
    client: { report },
    logger,
  };
  const scheduler = createHeartbeatScheduler(deps);
  return {
    scheduler,
    beats,
    logger,
    report,
    readSaleQueue,
    setQueue: (next: Partial<SaleQueueCounts>) => {
      queue = { ...queue, ...next };
    },
    setFallback: (o: HeartbeatOutcome) => {
      fallback = o;
    },
    times: () => beats.map((b) => b.at),
  };
}

const advance = (ms: number): Promise<void> =>
  vi.advanceTimersByTimeAsync(ms).then(() => undefined);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('heartbeat schedule constants', () => {
  it('beats every 15 minutes, polls the queue every 30 s and keeps beats 61 s apart', () => {
    expect([HEARTBEAT_INTERVAL_MS, HEARTBEAT_POLL_MS, HEARTBEAT_MIN_GAP_MS]).toEqual([
      15 * 60_000,
      30_000,
      61_000,
    ]);
  });
});

describe('createHeartbeatScheduler', () => {
  it('beats once at start, without sale_queue before any reply', async () => {
    const h = harness();
    h.scheduler.start();
    await advance(0);
    expect(h.times()).toEqual([0]);
    expect(h.beats[0]?.body).not.toHaveProperty('sale_queue');
    h.scheduler.stop();
  });

  it('sends sale_queue in the beat right after a revision 2 reply, once the cool-down ends', async () => {
    const h = harness();
    h.setQueue({ pending: 2, deadLetter: 1 });
    h.scheduler.start();
    await advance(HEARTBEAT_MIN_GAP_MS - 1);
    expect(h.times()).toEqual([0]);
    await advance(1);
    expect(h.times()).toEqual([0, HEARTBEAT_MIN_GAP_MS]);
    expect(h.beats[1]?.body.sale_queue).toEqual({
      pending: 2,
      dead_letter: 1,
      held_previous_pairing: 0,
      oldest_pending_at: null,
    });
    h.scheduler.stop();
  });

  it('never sends sale_queue to a revision 1 Backend-Core, and count changes do not beat', async () => {
    const h = harness();
    h.setFallback(ACK1);
    h.scheduler.start();
    await advance(5 * 60_000);
    h.setQueue({ deadLetter: 3 });
    await advance(HEARTBEAT_INTERVAL_MS);
    expect(h.times()).toEqual([0, HEARTBEAT_INTERVAL_MS]);
    expect(h.beats.every((b) => !('sale_queue' in b.body))).toBe(true);
    h.scheduler.stop();
  });

  it('beats every 15 minutes while nothing changes', async () => {
    const h = harness();
    h.scheduler.start();
    await advance(HEARTBEAT_MIN_GAP_MS + 2 * HEARTBEAT_INTERVAL_MS);
    expect(h.times()).toEqual([
      0,
      HEARTBEAT_MIN_GAP_MS,
      HEARTBEAT_MIN_GAP_MS + HEARTBEAT_INTERVAL_MS,
      HEARTBEAT_MIN_GAP_MS + 2 * HEARTBEAT_INTERVAL_MS,
    ]);
    h.scheduler.stop();
  });

  it('sends a dead-lettered sale within one poll once the cool-down has passed', async () => {
    const h = harness();
    h.scheduler.start();
    await advance(5 * 60_000);
    expect(h.times()).toEqual([0, HEARTBEAT_MIN_GAP_MS]);
    h.setQueue({ deadLetter: 1 });
    await advance(HEARTBEAT_POLL_MS);
    expect(h.beats).toHaveLength(3);
    expect(h.beats[2]?.body.sale_queue?.dead_letter).toBe(1);
    expect((h.beats[2]?.at ?? 0) - 5 * 60_000).toBeLessThanOrEqual(HEARTBEAT_POLL_MS);
    h.scheduler.stop();
  });

  it('defers a change seen during the cool-down to the moment it ends', async () => {
    const h = harness();
    h.scheduler.start();
    await advance(HEARTBEAT_MIN_GAP_MS);
    h.setQueue({ pending: 4 });
    await advance(HEARTBEAT_POLL_MS);
    expect(h.times()).toEqual([0, HEARTBEAT_MIN_GAP_MS]);
    await advance(2 * HEARTBEAT_MIN_GAP_MS - (h.times()[1] ?? 0) - HEARTBEAT_POLL_MS);
    expect(h.times()).toEqual([0, HEARTBEAT_MIN_GAP_MS, 2 * HEARTBEAT_MIN_GAP_MS]);
    expect(h.beats[2]?.body.sale_queue?.pending).toBe(4);
    h.scheduler.stop();
  });

  it('never beats twice within 61 s, however often things change', async () => {
    const h = harness();
    h.scheduler.start();
    for (let i = 1; i <= 40; i += 1) {
      h.setQueue({ pending: i });
      h.scheduler.requestBeat();
      await advance(7_000);
    }
    const times = h.times();
    expect(times.length).toBeGreaterThan(2);
    times.slice(1).forEach((t, i) => {
      expect(t - (times[i] ?? 0)).toBeGreaterThanOrEqual(HEARTBEAT_MIN_GAP_MS);
    });
    h.scheduler.stop();
  });

  it('beats on an explicit request (an update state change), after the cool-down', async () => {
    const h = harness();
    h.setFallback(ACK1);
    h.scheduler.start();
    await advance(10_000);
    h.scheduler.requestBeat();
    await advance(0);
    expect(h.times()).toEqual([0]);
    await advance(HEARTBEAT_MIN_GAP_MS - 10_000);
    expect(h.times()).toEqual([0, HEARTBEAT_MIN_GAP_MS]);
    h.scheduler.stop();
  });

  it('after a 401, a change or request never beats before the 15-minute schedule', async () => {
    const h = harness({ outcomes: [{ kind: 'unauthorized', status: 401 }] });
    h.scheduler.start();
    await advance(2 * 60_000);
    h.setQueue({ deadLetter: 2 });
    h.scheduler.requestBeat();
    await advance(HEARTBEAT_INTERVAL_MS - 2 * 60_000);
    expect(h.times()).toEqual([0, HEARTBEAT_INTERVAL_MS]);
    h.scheduler.stop();
  });

  it('after a 400, drops the cached revision so the next beat has no sale_queue', async () => {
    const h = harness({ outcomes: [ACK2, { kind: 'rejected', status: 400 }, ACK1] });
    h.scheduler.start();
    await advance(HEARTBEAT_MIN_GAP_MS);
    expect(h.beats[1]?.body).toHaveProperty('sale_queue');
    h.setQueue({ deadLetter: 9 });
    await advance(HEARTBEAT_INTERVAL_MS);
    expect(h.beats).toHaveLength(3);
    expect(h.beats[2]?.body).not.toHaveProperty('sale_queue');
    expect(h.beats[2]?.at).toBe(HEARTBEAT_MIN_GAP_MS + HEARTBEAT_INTERVAL_MS);
    h.scheduler.stop();
  });

  it('keeps an unsent change after a 5xx or a network fault and retries it 61 s later', async () => {
    const h = harness({
      outcomes: [ACK2, ACK2, { kind: 'server_error', status: 503 }, { kind: 'unreachable' }],
    });
    h.scheduler.start();
    await advance(HEARTBEAT_MIN_GAP_MS);
    h.setQueue({ deadLetter: 1 });
    await advance(5 * HEARTBEAT_MIN_GAP_MS);
    const times = h.times();
    expect(times.length).toBeGreaterThanOrEqual(5);
    expect(h.beats[4]?.body.sale_queue?.dead_letter).toBe(1);
    times.slice(1).forEach((t, i) => {
      expect(t - (times[i] ?? 0)).toBeGreaterThanOrEqual(HEARTBEAT_MIN_GAP_MS);
    });
    const afterSuccess = h.beats.length;
    await advance(10 * 60_000);
    expect(h.beats).toHaveLength(afterSuccess);
    h.scheduler.stop();
  });

  it('never throws when the client or a reader throws', async () => {
    const h = harness();
    h.report.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    h.scheduler.start();
    await advance(0);
    h.readSaleQueue.mockImplementation(() => {
      throw new Error('db closed');
    });
    await expect(advance(HEARTBEAT_INTERVAL_MS + HEARTBEAT_MIN_GAP_MS)).resolves.toBeUndefined();
    expect(h.beats.length).toBeGreaterThanOrEqual(2);
    h.scheduler.stop();
  });

  it('counts the cool-down from when a slow reply arrived, so the next beat is stored', async () => {
    const h = harness();
    h.report.mockImplementationOnce((_token: string, body: DeviceHeartbeatReport) => {
      h.beats.push({ at: Date.now() - Date.parse('2026-11-10T12:00:00.000Z'), body });
      return new Promise<HeartbeatOutcome>((resolve) => {
        setTimeout(() => {
          resolve(ACK2);
        }, 5_000);
      });
    });
    h.scheduler.start();
    await advance(5_000 + HEARTBEAT_MIN_GAP_MS - 1);
    expect(h.times()).toEqual([0]);
    await advance(1);
    expect(h.times()).toEqual([0, 5_000 + HEARTBEAT_MIN_GAP_MS]);
    expect(h.beats[1]?.body).toHaveProperty('sale_queue');
    h.scheduler.stop();
  });

  it('keeps the last ack revision and its receive time in memory, and drops it on a 400', async () => {
    const h = harness({ outcomes: [ACK2, { kind: 'rejected', status: 400 }] });
    expect(h.scheduler.lastAck()).toBeNull();
    h.scheduler.start();
    await advance(0);
    expect(h.scheduler.lastAck()).toEqual({
      posContractRevision: 2,
      receivedAt: Date.parse('2026-11-10T12:00:00.000Z'),
    });
    await advance(HEARTBEAT_MIN_GAP_MS);
    expect(h.scheduler.lastAck()).toBeNull();
    h.scheduler.stop();
  });

  it('sends nothing while there is no sendable device token (unpaired or revoked)', async () => {
    const h = harness({ token: null });
    h.scheduler.start();
    await advance(HEARTBEAT_INTERVAL_MS * 2);
    expect(h.report).not.toHaveBeenCalled();
    h.scheduler.stop();
  });

  it('a token lost after the gate opened, with changed counts, does not retry every poll (61 s floor)', async () => {
    let token: string | null = TOKEN;
    let deadLetter = 0;
    const h = harness();
    const readToken = vi.fn(() => Promise.resolve(token));
    const s = createHeartbeatScheduler({
      readToken,
      readFacts: () => ({
        appVersion: null,
        updateChannel: 'canary',
        updateState: 'idle',
        pendingVersion: null,
        schemaHead: null,
        sourceClockAt: new Date(),
      }),
      readSaleQueue: () => ({
        pending: 0,
        deadLetter,
        heldPreviousPairing: 0,
        oldestPendingAt: null,
      }),
      client: { report: h.report },
      logger: h.logger,
    });
    s.start();
    await advance(0); // first beat: the revision 2 reply opens the gate
    await advance(HEARTBEAT_MIN_GAP_MS); // follow-up beat reports the queue
    token = null; // revoked / unpaired
    deadLetter = 1; // the counts now differ from the last reported ones
    const before = readToken.mock.calls.length;
    for (let i = 0; i < 6; i += 1) {
      await advance(HEARTBEAT_POLL_MS);
    }
    const attempts = readToken.mock.calls.length - before;
    // 6 polls x 30 s = 180 s: at most one attempt per 61 s (3), never one per poll (6).
    expect(attempts).toBeLessThanOrEqual(Math.ceil((6 * HEARTBEAT_POLL_MS) / HEARTBEAT_MIN_GAP_MS));
    s.stop();
  });

  it('stops every timer, and a reply that lands after stop schedules and reads nothing', async () => {
    const h = harness();
    let release: (o: HeartbeatOutcome) => void = () => undefined;
    h.report.mockImplementationOnce(
      () =>
        new Promise<HeartbeatOutcome>((resolve) => {
          release = resolve;
        }),
    );
    h.scheduler.start();
    await advance(0);
    h.scheduler.stop();
    const reads = h.readSaleQueue.mock.calls.length;
    release(ACK2);
    await advance(HEARTBEAT_INTERVAL_MS * 2);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.readSaleQueue.mock.calls.length).toBe(reads);
  });

  it('logs the outcome and status only: no token, body or counts', async () => {
    const h = harness({ outcomes: [ACK2, { kind: 'unauthorized', status: 401 }] });
    h.setQueue({ pending: 777, deadLetter: 555 });
    h.scheduler.start();
    await advance(HEARTBEAT_MIN_GAP_MS);
    const calls = [...h.logger.info.mock.calls, ...h.logger.warn.mock.calls];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [fields] of calls) {
      expect(Object.keys(fields as object).every((k) => ['outcome', 'status'].includes(k))).toBe(
        true,
      );
    }
    const text = JSON.stringify(calls);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('777');
    expect(text).not.toContain('555');
    h.scheduler.stop();
  });
});
