/**
 * RT-1231 — `bindAuditSyncStoreDb` against the real 0004 schema (sql.js).
 *
 * Covers: listing only unsettled events of the current pairing scope, oldest
 * first; the parked-id exclusion; `markSynced`; `markSettled` (NULL
 * `synced_at`, one transaction, idempotent); unpaired → nothing listed; and
 * `audit_events` untouched (append-only).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from 'sql.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeSqlJsHandle } from '../cart/__helpers__/sql-js-handle.js';
import {
  bindAuditSyncStoreDb,
  type AuditSyncScope,
} from '../../../../src/main/audit/audit-sync-store.js';
import type { AuditEvent } from '../../../../src/shared/audit/event-shape.js';

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

const SCOPE: AuditSyncScope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  branchId: '33333333-3333-4333-8333-333333333333',
  terminalId: '44444444-4444-4444-8444-444444444444',
};

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function evt(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function seed(
  db: SqlJsDatabase,
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
): void {
  const row = {
    event_id: id,
    tenant_id: SCOPE.tenantId,
    branch_id: SCOPE.branchId,
    originating_terminal_id: SCOPE.terminalId,
    acting_operator_id: 'user_clerk1',
    session_id: null,
    shift_id: null,
    action_category: 'operator.session.takeover',
    created_at: '2026-11-06T10:00:00.000Z',
    approving_supervisor_id: null,
    payload: '{"k":"v"}',
    ...overrides,
  };
  db.run(
    `INSERT INTO audit_events (event_id, tenant_id, branch_id, originating_terminal_id,
       acting_operator_id, session_id, shift_id, action_category, created_at,
       approving_supervisor_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    Object.values(row),
  );
}

function syncRows(db: SqlJsDatabase): Array<[string, string | null]> {
  const res = db.exec('SELECT event_id, synced_at FROM audit_events_sync_state ORDER BY event_id');
  return (res[0]?.values ?? []) as Array<[string, string | null]>;
}

function fresh(scope: () => AuditSyncScope | null = () => SCOPE) {
  const db = new SQL.Database();
  db.run(MIGRATION_SQL);
  return { db, store: bindAuditSyncStoreDb(makeSqlJsHandle(db), scope) };
}

describe('RT-1231 bindAuditSyncStoreDb', () => {
  it('lists unsettled events of the current scope, oldest first, with the payload parsed', () => {
    const { db, store } = fresh();
    seed(db, evt(2), { created_at: '2026-11-06T10:00:02.000Z' });
    seed(db, evt(1), { created_at: '2026-11-06T10:00:01.000Z' });
    const listed: AuditEvent[] = store.listUnsynced(10);
    expect(listed.map((e) => e.event_id)).toEqual([evt(1), evt(2)]);
    expect(listed[0]).toMatchObject({
      tenant_id: SCOPE.tenantId,
      action_category: 'operator.session.takeover',
      session_id: null,
      payload: { k: 'v' },
    });
  });

  it('holds events of another tenant, branch or terminal (RT-221 scope)', () => {
    const { db, store } = fresh();
    seed(db, evt(1));
    seed(db, evt(2), { tenant_id: '99999999-9999-4999-8999-999999999999' });
    seed(db, evt(3), { branch_id: '99999999-9999-4999-8999-999999999999' });
    seed(db, evt(4), { originating_terminal_id: '99999999-9999-4999-8999-999999999999' });
    expect(store.listUnsynced(10).map((e) => e.event_id)).toEqual([evt(1)]);
  });

  it('lists nothing while unpaired', () => {
    const { db, store } = fresh(() => null);
    seed(db, evt(1));
    expect(store.listUnsynced(10)).toEqual([]);
  });

  it('honours the limit and skips the excluded (parked) ids', () => {
    const { db, store } = fresh();
    for (let i = 1; i <= 4; i += 1)
      seed(db, evt(i), { created_at: `2026-11-06T10:00:0${String(i)}.000Z` });
    expect(store.listUnsynced(2).map((e) => e.event_id)).toEqual([evt(1), evt(2)]);
    expect(store.listUnsynced(10, [evt(1), evt(3)]).map((e) => e.event_id)).toEqual([
      evt(2),
      evt(4),
    ]);
  });

  it('markSynced records synced_at and removes the event from the list', () => {
    const { db, store } = fresh();
    seed(db, evt(1));
    store.markSynced(SCOPE.tenantId, evt(1), '2026-11-06T11:00:00.000Z');
    expect(store.listUnsynced(10)).toEqual([]);
    expect(syncRows(db)).toEqual([[evt(1), '2026-11-06T11:00:00.000Z']]);
  });

  it('markSettled writes a NULL synced_at row, idempotently, and never touches audit_events', () => {
    const { db, store } = fresh();
    seed(db, evt(1));
    seed(db, evt(2));
    store.markSettled([
      { tenant_id: SCOPE.tenantId, event_id: evt(1) },
      { tenant_id: SCOPE.tenantId, event_id: evt(2) },
    ]);
    store.markSettled([{ tenant_id: SCOPE.tenantId, event_id: evt(1) }]);
    store.markSettled([]);
    expect(store.listUnsynced(10)).toEqual([]);
    expect(syncRows(db)).toEqual([
      [evt(1), null],
      [evt(2), null],
    ]);
    expect(db.exec('SELECT COUNT(*) FROM audit_events')[0]?.values[0]?.[0]).toBe(2);
  });

  it('reads an unreadable stored payload as a non-object (never sent)', () => {
    const { db, store } = fresh();
    seed(db, evt(1), { payload: '{not json' });
    expect(store.listUnsynced(10)[0]?.payload).toBeNull();
  });
});
