/**
 * RT-1231 — `startAuditSync` end to end inside the process: the real 0004
 * schema (sql.js), the real store, client and shared transport, a fake
 * Backend-Core `fetch` and fake timers.
 *
 *   • a takeover and a manager approval (the issue's lab pair) are uploaded with
 *     the device attestation in the body; routine events stay local-only;
 *   • offline: nothing is written, nothing is lost, and the events upload on
 *     the first flush after the connection returns;
 *   • a `schema_violation` is settled once and never sent again;
 *   • the worker stop ends the loop.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';
import {
  auditSyncDepsOf,
  startAuditSync,
  type AuditSyncSourceDeps,
} from '../../../../src/main/bootstrap/audit-sync.js';
import { AUDIT_SYNC_INTERVAL_MS } from '../../../../src/main/audit/schedule-audit-sync.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const MIGRATION_SQL = readFileSync(
  path.join(REPO_ROOT, 'migrations', '0004_audit_events.sql'),
  'utf8',
);

const PAIRING = {
  tenant_id: '11111111-1111-4111-8111-111111111111',
  branch_id: '33333333-3333-4333-8333-333333333333',
  terminal_id: '44444444-4444-4444-8444-444444444444',
};

const TAKEOVER = '00000000-0000-4000-8000-000000000001';
const APPROVAL = '00000000-0000-4000-8000-000000000002';
const ROUTINE = '00000000-0000-4000-8000-000000000003';

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function seed(db: SqlJsDatabase, id: string, category: string, at: string): void {
  db.run(
    `INSERT INTO audit_events (event_id, tenant_id, branch_id, originating_terminal_id,
       acting_operator_id, session_id, shift_id, action_category, created_at,
       approving_supervisor_id, payload) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, '{}')`,
    [
      id,
      PAIRING.tenant_id,
      PAIRING.branch_id,
      PAIRING.terminal_id,
      'user_clerk1',
      category,
      at,
      category === 'manager_approval.granted' ? 'user_mgr' : null,
    ],
  );
}

function syncState(db: SqlJsDatabase): Record<string, string | null> {
  const rows = (db.exec('SELECT event_id, synced_at FROM audit_events_sync_state')[0]?.values ??
    []) as Array<[string, string | null]>;
  return Object.fromEntries(rows);
}

interface Backend {
  online: boolean;
  bodies: Array<{ device_token_attestation: string; events: Array<{ event_id: string }> }>;
  headers: Array<Record<string, string>>;
  reject: Record<string, string>;
}

function fakeBackend(): {
  backend: Backend;
  fetch: (u: RequestInfo | URL, i?: RequestInit) => Promise<Response>;
} {
  const backend: Backend = { online: true, bodies: [], headers: [], reject: {} };
  const fetch = (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!backend.online) return Promise.reject(new TypeError('fetch failed'));
    const body = JSON.parse(init?.body as string) as Backend['bodies'][number];
    backend.bodies.push(body);
    backend.headers.push(init?.headers as Record<string, string>);
    const ids = body.events.map((e) => e.event_id);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          accepted: ids.filter((id) => backend.reject[id] === undefined),
          duplicates: [],
          rejected: ids
            .filter((id) => backend.reject[id] !== undefined)
            .map((id) => ({ event_id: id, category: backend.reject[id] })),
        }),
        { status: 200 },
      ),
    );
  };
  return { backend, fetch };
}

function start(db: SqlJsDatabase, fetch: ReturnType<typeof fakeBackend>['fetch']) {
  const register = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  startAuditSync(
    {
      db: makeSqlJsHandle(db),
      backendFetch: fetch,
      readDeviceToken: () => Promise.resolve('device-token'),
      currentTerminalId: () => PAIRING.terminal_id,
      workerRegistry: { register },
      mainLogger: logger,
      baseUrl: 'https://bc.test',
    },
    PAIRING,
  );
  const stop = register.mock.calls[0]?.[1] as () => void;
  return { register, logger, stop };
}

describe('RT-1231 startAuditSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uploads a takeover and a manager approval; routine events stay local-only', async () => {
    const db = new SQL.Database();
    db.run(MIGRATION_SQL);
    seed(db, TAKEOVER, 'operator.session.takeover', '2026-11-06T10:00:01.000Z');
    seed(db, APPROVAL, 'manager_approval.granted', '2026-11-06T10:00:02.000Z');
    seed(db, ROUTINE, 'shift.open', '2026-11-06T10:00:00.000Z');
    const { backend, fetch } = fakeBackend();
    const { register, stop, logger } = start(db, fetch);

    expect(register).toHaveBeenCalledWith('audit-sync interval', expect.any(Function));
    await vi.advanceTimersByTimeAsync(AUDIT_SYNC_INTERVAL_MS);

    expect(backend.bodies).toHaveLength(1);
    expect(backend.bodies[0]?.device_token_attestation).toBe('device-token');
    expect(backend.bodies[0]?.events.map((e) => e.event_id)).toEqual([TAKEOVER, APPROVAL]);
    expect(backend.headers[0]).not.toHaveProperty('Authorization');
    const state = syncState(db);
    expect(state[TAKEOVER]).toEqual(expect.any(String));
    expect(state[APPROVAL]).toEqual(expect.any(String));
    expect(state[ROUTINE]).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      { synced: 2, localOnly: 1, final: 0, retryable: 0, parked: 0, outcome: 'progress' },
      'audit_sync:flushed',
    );
    stop();
  });

  it('offline: nothing is lost, and the events upload on reconnect', async () => {
    const db = new SQL.Database();
    db.run(MIGRATION_SQL);
    seed(db, TAKEOVER, 'operator.session.takeover', '2026-11-06T10:00:01.000Z');
    const { backend, fetch } = fakeBackend();
    backend.online = false;
    const { logger, stop } = start(db, fetch);

    await vi.advanceTimersByTimeAsync(AUDIT_SYNC_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncState(db)).toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      { reason: 'unreachable' },
      'audit_sync:batch_undelivered',
    );

    backend.online = true;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(backend.bodies.map((b) => b.events.map((e) => e.event_id))).toEqual([[TAKEOVER]]);
    expect(syncState(db)[TAKEOVER]).toEqual(expect.any(String));
    stop();
  });

  it('settles a schema_violation once and never sends it again', async () => {
    const db = new SQL.Database();
    db.run(MIGRATION_SQL);
    seed(db, APPROVAL, 'manager_approval.granted', '2026-11-06T10:00:02.000Z');
    const { backend, fetch } = fakeBackend();
    backend.reject[APPROVAL] = 'schema_violation';
    const { logger, stop } = start(db, fetch);

    await vi.advanceTimersByTimeAsync(AUDIT_SYNC_INTERVAL_MS * 5);

    expect(backend.bodies).toHaveLength(1);
    expect(syncState(db)).toEqual({ [APPROVAL]: null });
    expect(logger.warn).toHaveBeenCalledWith(
      {
        event_id: APPROVAL,
        action_category: 'manager_approval.granted',
        kind: 'rejected_final',
        category: 'schema_violation',
      },
      'audit_sync:event_refused_final',
    );
    stop();
  });

  it('the worker stop ends the loop', async () => {
    const db = new SQL.Database();
    db.run(MIGRATION_SQL);
    seed(db, TAKEOVER, 'operator.session.takeover', '2026-11-06T10:00:01.000Z');
    const { backend, fetch } = fakeBackend();
    const { stop } = start(db, fetch);
    stop();
    await vi.advanceTimersByTimeAsync(AUDIT_SYNC_INTERVAL_MS * 10);
    expect(backend.bodies).toHaveLength(0);
  });
});

describe('RT-1231 auditSyncDepsOf', () => {
  it('wires the sendable device-token reader and the live terminal id', async () => {
    const getCurrentTerminalId = vi.fn(() => PAIRING.terminal_id);
    const getStatus = vi.fn(() => Promise.resolve({ kind: 'unpaired' as const }));
    const source = {
      db: { marker: 'db' },
      backendFetch: vi.fn(),
      pairingStore: { getStatus, getCurrentTerminalId },
      secretStore: { get: vi.fn() },
      deviceTokenKey: 'device-token-key',
      workerRegistry: { register: vi.fn() },
      mainLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as AuditSyncSourceDeps;
    const deps = auditSyncDepsOf(source);
    expect(deps.db).toBe(source.db);
    expect(deps.backendFetch).toBe(source.backendFetch);
    expect(deps.workerRegistry).toBe(source.workerRegistry);
    expect(deps.mainLogger).toBe(source.mainLogger);
    expect(deps.currentTerminalId()).toBe(PAIRING.terminal_id);
    // Unpaired → no token, so no audit request is ever made.
    await expect(deps.readDeviceToken()).resolves.toBeNull();
    expect(getStatus).toHaveBeenCalled();
  });
});
