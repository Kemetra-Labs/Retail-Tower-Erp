/**
 * RT-1231 — the production `AuditSyncStore` on better-sqlite3.
 *
 * Reads `audit_events` rows with no `audit_events_sync_state` row and writes
 * that sibling table only (0004; `audit_events` stays append-only). No schema
 * change: a NULL `synced_at` already means "settled, not uploaded".
 *
 * Scope (RT-221 / RT-138 L6, as the sale outbox): only the events of the
 * CURRENT pairing's tenant, branch and terminal are listed, read live each
 * time. An earlier pairing's events are held, never sent under the new device
 * identity (they would only be refused as `tenant_mismatch` / `invalid_input`).
 * Unpaired → nothing is listed.
 *
 * Statements are prepared lazily: the tables exist only after migration 0004.
 */
import type { DatabaseHandle } from '../db/client.js';
import type { AuditEvent } from '../../shared/audit/event-shape.js';
import type { AuditEventKey, AuditSyncStore } from './audit-sync.js';

export interface AuditSyncScope {
  readonly tenantId: string;
  readonly branchId: string;
  readonly terminalId: string;
}

type AllStmt = { all(...params: unknown[]): unknown[] };
type RunStmt = { run(...params: unknown[]): unknown };

interface AuditEventRow {
  event_id: string;
  tenant_id: string;
  branch_id: string;
  originating_terminal_id: string;
  acting_operator_id: string;
  session_id: string | null;
  shift_id: string | null;
  action_category: string;
  created_at: string;
  approving_supervisor_id: string | null;
  payload: string | null;
}

const LIST_SQL = `
  SELECT ae.event_id, ae.tenant_id, ae.branch_id, ae.originating_terminal_id,
         ae.acting_operator_id, ae.session_id, ae.shift_id, ae.action_category,
         ae.created_at, ae.approving_supervisor_id, ae.payload
  FROM audit_events ae
  WHERE ae.tenant_id = ?
    AND ae.branch_id = ?
    AND ae.originating_terminal_id = ?
    AND NOT EXISTS (
      SELECT 1 FROM audit_events_sync_state ss
      WHERE ss.tenant_id = ae.tenant_id AND ss.event_id = ae.event_id
    )
    AND ae.event_id NOT IN (SELECT value FROM json_each(?))
  ORDER BY ae.created_at, ae.event_id
  LIMIT ?`;

/**
 * The stored payload as written. Unreadable JSON reads as `null`, which
 * `isWireReady` refuses, so such an event is settled as final, never sent.
 */
function parsePayload(raw: string | null): AuditEvent['payload'] {
  if (raw === null) return {};
  try {
    return JSON.parse(raw) as AuditEvent['payload'];
  } catch {
    return null as unknown as AuditEvent['payload'];
  }
}

function toEvent(row: AuditEventRow): AuditEvent {
  return {
    event_id: row.event_id,
    tenant_id: row.tenant_id,
    branch_id: row.branch_id,
    originating_terminal_id: row.originating_terminal_id,
    acting_operator_id: row.acting_operator_id,
    session_id: row.session_id,
    shift_id: row.shift_id,
    action_category: row.action_category as AuditEvent['action_category'],
    created_at: row.created_at,
    approving_supervisor_id: row.approving_supervisor_id,
    payload: parsePayload(row.payload),
  };
}

export function bindAuditSyncStoreDb(
  handle: DatabaseHandle,
  scope: () => AuditSyncScope | null,
): AuditSyncStore {
  let listStmt: AllStmt | null = null;
  let syncedStmt: RunStmt | null = null;
  let settledStmt: RunStmt | null = null;
  let settleMany: ((keys: readonly AuditEventKey[]) => void) | null = null;

  return {
    listUnsynced(limit, excludeEventIds = []) {
      const current = scope();
      if (current === null) return [];
      listStmt ??= handle.prepare(LIST_SQL) as AllStmt;
      const rows = listStmt.all(
        current.tenantId,
        current.branchId,
        current.terminalId,
        JSON.stringify(excludeEventIds),
        limit,
      ) as AuditEventRow[];
      return rows.map(toEvent);
    },

    markSynced(tenant_id, event_id, synced_at) {
      syncedStmt ??= handle.prepare(
        `INSERT INTO audit_events_sync_state (tenant_id, event_id, synced_at)
         VALUES (?, ?, ?)
         ON CONFLICT (tenant_id, event_id) DO UPDATE SET synced_at = excluded.synced_at`,
      ) as RunStmt;
      syncedStmt.run(tenant_id, event_id, synced_at);
    },

    markSettled(keys) {
      if (keys.length === 0) return;
      settledStmt ??= handle.prepare(
        `INSERT OR IGNORE INTO audit_events_sync_state (tenant_id, event_id, synced_at)
         VALUES (?, ?, NULL)`,
      ) as RunStmt;
      const stmt = settledStmt;
      settleMany ??= handle.transaction((batch: readonly AuditEventKey[]) => {
        for (const key of batch) stmt.run(key.tenant_id, key.event_id);
      });
      settleMany(keys);
    },
  };
}
