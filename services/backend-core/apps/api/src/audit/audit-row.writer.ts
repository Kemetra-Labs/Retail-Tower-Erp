/**
 * RT-1484 — the `audit` module's port for an audit row written INSIDE the caller's transaction.
 *
 * A Console write whose contract says "one `audit_events` row in the same transaction" (the
 * pricing structure writes, `pricing/price-structure.yaml`) cannot use `insertAuditEvent`
 * (`@data-pulse-2/db`): that helper opens its own connection and transaction. This writes the row
 * on the caller's client, under the caller's tenant context (RLS), so the change and its audit row
 * commit or roll back together. Ids, codes and labels only in `metadata` (FR-AUDIT-3, §XIV).
 */
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

/** One `audit_events` row of a tenant-scoped write. */
export interface TransactionalAuditRow {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly storeId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  /** The request id (a UUID), or null when the request carries none. */
  readonly requestId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** `actor_label` stays NULL (a human actor is named by its user id); `occurred_at` is the DB default. */
const INSERT_SQL = `INSERT INTO audit_events (id, tenant_id, actor_user_id, store_id, action, target_type, target_id, request_id, metadata)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`;

/** Insert `row` on `client`, inside the caller's open transaction. */
export async function insertAuditRowInTransaction(
  client: Pick<PoolClient, "query">,
  row: TransactionalAuditRow,
): Promise<void> {
  const { tenantId, actorUserId, storeId, action, targetType, targetId, requestId, metadata } = row;
  const values = [tenantId, actorUserId, storeId, action, targetType, targetId, requestId, JSON.stringify(metadata)];
  await client.query(INSERT_SQL, [newId(), ...values]);
}

/**
 * RT-1484 PR-6 (owner decision on m2): the metadata of the FIRST `action` row about `targetId`,
 * read on the caller's client under its tenant context (RLS), or null. Audit rows are append-only,
 * so this reads back a fact the caller recorded in an earlier transaction of its own (for a
 * rollback Change Set: the instant it restores from), never anything a client can change.
 */
export async function readFirstAuditMetadata(
  client: Pick<PoolClient, "query">,
  key: { readonly tenantId: string; readonly action: string; readonly targetType: string; readonly targetId: string },
): Promise<Record<string, unknown> | null> {
  const r = await client.query<{ metadata: Record<string, unknown> | null }>(
    `SELECT metadata FROM audit_events
      WHERE tenant_id = $1::uuid AND action = $2 AND target_type = $3 AND target_id = $4::uuid
      ORDER BY occurred_at, id LIMIT 1`,
    [key.tenantId, key.action, key.targetType, key.targetId],
  );
  return r.rows[0]?.metadata ?? null;
}
