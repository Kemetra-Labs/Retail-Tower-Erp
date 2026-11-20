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

/** Rows per statement of {@link insertAuditRowsInTransaction}. */
const AUDIT_ROWS_PER_STATEMENT = 1000;

/**
 * RT-1507 — many audit rows of one tenant-scoped write in as few statements as possible, on the caller's client inside
 * its open transaction (the product import's publish writes one row per product, identifier and brand). Same columns and
 * rules as {@link insertAuditRowInTransaction}.
 */
export async function insertAuditRowsInTransaction(
  client: Pick<PoolClient, "query">,
  rows: readonly TransactionalAuditRow[],
): Promise<void> {
  for (let from = 0; from < rows.length; from += AUDIT_ROWS_PER_STATEMENT) {
    const chunk = rows.slice(from, from + AUDIT_ROWS_PER_STATEMENT).map((r) => ({
      id: newId(),
      tenant_id: r.tenantId,
      actor_user_id: r.actorUserId,
      store_id: r.storeId,
      action: r.action,
      target_type: r.targetType,
      target_id: r.targetId,
      request_id: r.requestId,
      metadata: r.metadata,
    }));
    await client.query(
      `INSERT INTO audit_events (id, tenant_id, actor_user_id, store_id, action, target_type, target_id, request_id, metadata)
       SELECT v.id, v.tenant_id, v.actor_user_id, v.store_id, v.action, v.target_type, v.target_id, v.request_id, v.metadata
         FROM jsonb_to_recordset($1::jsonb) AS v(id uuid, tenant_id uuid, actor_user_id uuid, store_id uuid, action text,
                                                  target_type text, target_id uuid, request_id uuid, metadata jsonb)`,
      [JSON.stringify(chunk)],
    );
  }
}

/**
 * RT-1484 PR-6 (owner decision on m2): the metadata of the NEWEST row about `targetId` whose
 * metadata holds `metadataKey`, read on the caller's client under its tenant context (RLS), or
 * null. Audit rows are append-only, so this reads back a fact the caller recorded in an earlier
 * transaction of its own (for a rollback Change Set: the instant its items were last generated
 * from), never anything a client can change.
 */
export async function readLatestAuditMetadataWithKey(
  client: Pick<PoolClient, "query">,
  key: { readonly tenantId: string; readonly targetType: string; readonly targetId: string; readonly metadataKey: string },
): Promise<Record<string, unknown> | null> {
  const r = await client.query<{ metadata: Record<string, unknown> | null }>(
    `SELECT metadata FROM audit_events
      WHERE tenant_id = $1::uuid AND target_type = $2 AND target_id = $3::uuid AND metadata ? $4
      ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    [key.tenantId, key.targetType, key.targetId, key.metadataKey],
  );
  return r.rows[0]?.metadata ?? null;
}
