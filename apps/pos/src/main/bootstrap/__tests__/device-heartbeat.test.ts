import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';

vi.mock('../env.js', () => ({ resolveApiBaseUrl: () => 'https://bc.test' }));

import { registerDeviceHeartbeat, type DeviceHeartbeatDeps } from '../device-heartbeat.js';
import {
  freshCatalogueDb,
  handleFor,
  initCatalogueSql,
} from '../../catalogue/__tests__/__helpers__/catalogue-fixture.js';
import type { PairedWorkerStarter } from '../../app/paired-workers.js';
import { createSaleSyncStateRepo } from '../../sales-sync/sale-sync-state-repo.js';
import { seedOutbox, seedSale } from '../../sales-sync/__tests__/__helpers__/sales-sync-fixture.js';
import { HEARTBEAT_MIN_GAP_MS } from '../../device-health/heartbeat-scheduler.js';
import type { UpdateStatus } from '../../update/update-types.js';

/**
 * RT-1312 Phase 1 — `registerDeviceHeartbeat` wiring: a paired-only starter on
 * the latch, the real client on the shared fetch, the real sale-sync state repo
 * on a migrated database, the updater state, and the stop on the worker registry.
 */

beforeAll(async () => {
  await initCatalogueSql();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const TOKEN = 'device-token';
const TERMINAL = { tenant_id: 't1', branch_id: 'b1', terminal_id: 'term-1' };
const ackOf = (revision: number): Response =>
  new Response(
    JSON.stringify({
      acknowledged_at: '2026-11-10T12:00:00.000Z',
      pos_contract_revision: revision,
      policy: null,
      min_supported_grace_until: null,
      compliance: 'unknown',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function wire(
  opts: { revision?: number; token?: string | null; status?: number; processEnv?: boolean } = {},
) {
  const starters: [string, PairedWorkerStarter][] = [];
  const stops: [string, () => void][] = [];
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const listeners = new Set<(status: UpdateStatus) => void>();
  let status: UpdateStatus = { state: 'idle' };
  const db = freshCatalogueDb();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT, checksum TEXT);
    INSERT INTO schema_migrations (name) VALUES ('0059_shift_count_attempts'), ('0060_tenant_branding_cache');`);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: DeviceHeartbeatDeps = {
    db: handleFor(db),
    pairingStore: { getCurrentTerminalId: () => TERMINAL.terminal_id },
    pairedWorkersLatch: { register: (name, start) => starters.push([name, start]) },
    workerRegistry: { register: (name, stop) => stops.push([name, stop]) },
    mainLogger: logger as unknown as Logger,
    backendFetch: (input, init) => {
      sent.push({ url: input instanceof Request ? input.url : input.toString(), init });
      if (opts.status !== undefined)
        return Promise.resolve(new Response('{}', { status: opts.status }));
      return Promise.resolve(ackOf(opts.revision ?? 2));
    },
    readSendableDeviceToken: () => Promise.resolve(opts.token === undefined ? TOKEN : opts.token),
    updateService: {
      getStatus: () => status,
      onStatusChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    ...(opts.processEnv ? {} : { env: { POS_PULSE_UPDATE_CHANNEL: 'canary' } }),
  };
  registerDeviceHeartbeat(deps);
  const bodies = (): Record<string, unknown>[] =>
    sent.map((s) => JSON.parse(s.init?.body as string) as Record<string, unknown>);
  return {
    db,
    starters,
    stops,
    sent,
    bodies,
    logger,
    listeners,
    setStatus: (next: UpdateStatus) => {
      status = next;
      for (const l of listeners) l(next);
    },
    start: () => {
      for (const [, start] of starters) start(TERMINAL);
    },
  };
}

describe('RT-1312 — registerDeviceHeartbeat', () => {
  it('registers one paired-only starter and sends nothing before the terminal is paired', async () => {
    const w = wire();
    expect(w.starters.map(([name]) => name)).toEqual(['device heartbeat']);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(w.sent).toHaveLength(0);
  });

  it('beats at start with every known field and no sale_queue yet', async () => {
    const w = wire();
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]?.url).toBe('https://bc.test/api/pos/v1/terminals/heartbeat');
    expect((w.sent[0]?.init?.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(w.bodies()[0]).toEqual({
      app_version: null,
      update_channel: 'canary',
      update_state: 'idle',
      pending_version: null,
      schema_head: '0060_tenant_branding_cache',
      source_clock_at: '2026-11-10T12:00:00.000Z',
    });
    for (const [, stop] of w.stops) stop();
  });

  it('reads the update channel from the process environment when no env is passed', async () => {
    vi.stubEnv('POS_PULSE_UPDATE_CHANNEL', 'stable');
    try {
      const w = wire({ processEnv: true });
      w.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(w.bodies()[0]?.['update_channel']).toBe('stable');
      for (const [, stop] of w.stops) stop();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sends the real sale-queue counts one cool-down after a revision 2 reply', async () => {
    const w = wire({ revision: 2 });
    w.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MIN_GAP_MS);
    expect(w.bodies()[1]?.['sale_queue']).toEqual({
      pending: 0,
      dead_letter: 0,
      held_previous_pairing: 0,
      oldest_pending_at: null,
    });
    for (const [, stop] of w.stops) stop();
  });

  it('beats again on an update state change, with the pending version', async () => {
    const w = wire({ revision: 1 });
    w.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MIN_GAP_MS);
    w.setStatus({ state: 'update_pending', availableVersion: '1.5.0' });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.bodies()[1]).toMatchObject({
      update_state: 'update_pending',
      pending_version: '1.5.0',
    });
    for (const [, stop] of w.stops) stop();
  });

  it.each([400, 401, 500])('never throws on a %s and logs the status only', async (status) => {
    const w = wire({ status });
    w.start();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MIN_GAP_MS * 2);
    expect(w.logger.warn).toHaveBeenCalledWith(
      { outcome: expect.any(String) as string, status },
      'device_heartbeat:reported',
    );
    expect(JSON.stringify(w.logger.warn.mock.calls)).not.toContain(TOKEN);
    for (const [, stop] of w.stops) stop();
  });

  it('sends nothing while there is no sendable token (unpaired or revoked)', async () => {
    const w = wire({ token: null });
    w.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(w.sent).toHaveLength(0);
    for (const [, stop] of w.stops) stop();
  });

  it('stops on quit: every timer cleared and the updater listener removed', async () => {
    const w = wire();
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.stops.map(([name]) => name)).toEqual(['device heartbeat']);
    expect(w.listeners.size).toBe(1);
    for (const [, stop] of w.stops) stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(w.listeners.size).toBe(0);
    w.setStatus({ state: 'checking' });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(w.sent).toHaveLength(1);
  });
});

/**
 * RT-1312 Phase 3(c) — the quarantine uploader rides the heartbeat's lifecycle and
 * its revision ack: inert below `pos_contract_revision` 3, then it uploads the
 * stranded sale with the device bearer, marks it, and the next heartbeat stops
 * counting it.
 */
describe('RT-1312 Phase 3(c) — the quarantine uploader on the heartbeat', () => {
  const UPLOAD_URL = 'https://bc.test/api/pos/v1/quarantined-sales';
  const OLD_TERMINAL = 'term-old';

  /** A dead-lettered sale, and a held one queued under an earlier pairing. */
  function strand(w: ReturnType<typeof wire>): void {
    const scope = { tenant_id: 't1', branch_id: 'b1' };
    seedSale(w.db, { sale_id: 'dead-1', ...scope, terminal_id: 'term-1' });
    seedOutbox(w.db, { sale_id: 'dead-1', ...scope, terminal_id: 'term-1' });
    createSaleSyncStateRepo(handleFor(w.db)).markDeadLetter({
      saleId: 'dead-1',
      tenantId: 't1',
      branchId: 'b1',
      now: '2026-11-10T11:00:00.000Z',
    });
    seedSale(w.db, { sale_id: 'held-1', ...scope, terminal_id: OLD_TERMINAL });
    seedOutbox(w.db, { sale_id: 'held-1', ...scope, terminal_id: OLD_TERMINAL });
  }

  const uploads = (w: ReturnType<typeof wire>) => w.sent.filter((s) => s.url === UPLOAD_URL);
  const uploadedRows = (w: ReturnType<typeof wire>): unknown[][] =>
    w.db.exec(`SELECT sale_id, state FROM sale_quarantine_upload ORDER BY sale_id`)[0]?.values ??
    [];

  it('sends no upload while the advertised revision is below 3', async () => {
    const w = wire({ revision: 2 });
    strand(w);
    w.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(uploads(w)).toHaveLength(0);
    expect(uploadedRows(w)).toEqual([]);
    for (const [, stop] of w.stops) stop();
  });

  it('sends no upload before any heartbeat reply (the gate fails closed)', async () => {
    const w = wire({ status: 500 });
    strand(w);
    w.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(uploads(w)).toHaveLength(0);
    for (const [, stop] of w.stops) stop();
  });

  it('at revision 3 uploads the dead-lettered and the held sale with the device bearer, then stops counting them', async () => {
    const w = wire({ revision: 3 });
    strand(w);
    w.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const sent = uploads(w);
    expect(sent).toHaveLength(2);
    for (const s of sent) {
      expect((s.init?.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    }
    const bodies = sent.map((s) => JSON.parse(s.init?.body as string) as Record<string, unknown>);
    expect(bodies.map((b) => (b['reason'] as { kind: string }).kind).sort()).toEqual([
      'held_previous_pairing',
      'refused',
    ]);
    const held = bodies.find(
      (b) => (b['reason'] as { kind: string }).kind === 'held_previous_pairing',
    );
    expect(held?.['previousTerminalId']).toBe(OLD_TERMINAL);
    expect(uploadedRows(w)).toEqual([
      ['dead-1', 'uploaded'],
      ['held-1', 'uploaded'],
    ]);

    // The last heartbeat no longer counts either one; the till's own view still does.
    const last = w.bodies().at(-1)?.['sale_queue'] as Record<string, number>;
    expect(last['dead_letter']).toBe(0);
    expect(last['held_previous_pairing']).toBe(0);
    expect(
      createSaleSyncStateRepo(handleFor(w.db)).readSyncStatus({
        tenantId: 't1',
        branchId: 'b1',
        terminalId: 'term-1',
      }),
    ).toMatchObject({ deadLetter: 1, heldPreviousPairing: 1 });

    // Uploaded once: later passes send nothing more.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(uploads(w)).toHaveLength(2);
    for (const [, stop] of w.stops) stop();
  });

  it('stops with the heartbeat: no timer is left', async () => {
    const w = wire({ revision: 3 });
    strand(w);
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    for (const [, stop] of w.stops) stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
