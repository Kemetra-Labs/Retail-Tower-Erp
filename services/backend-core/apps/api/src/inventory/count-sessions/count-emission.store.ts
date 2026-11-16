/**
 * Count emission, the database half — Jira RT-1423 (RT-292 Gate 6). Runs INSIDE the approval transaction
 * (DC-2: the effects and their ERP intents are written together), after the corrections:
 *
 *   1. read the confirmed ERP item map of the approved lines and the store's active `stock` warehouse;
 *   2. `planEmission`: non-zero variance, no refusal, mapped, chunks of at most 100 in product order;
 *   3. insert one `erpnext_posting_status` row per chunk (`kind = 'inventory_count'`, frozen cut + 1 µs,
 *      provenance `count:<sessionId>[:<chunk>]`) and its frozen `count_posting_lines`;
 *   4. link each line's correction effects to their chunk (`not_posted -> pending`).
 *
 * Idempotent three ways: the caller holds the session row lock and the session is `approved` only once;
 * `UNIQUE (tenant, session, chunk)` plus `ON CONFLICT DO NOTHING` makes a replayed insert a no-op; and the
 * effect link only moves `not_posted` effects and refuses a count that does not match. The caller took the
 * tenant's feed sequence lock BEFORE the session lock (the same order as `ackOutcome`), so the commit order
 * of new chunks is their sequence order and the connector's cursor can never skip one.
 */
import { newId } from '@data-pulse-2/shared';
import type { PoolClient } from 'pg';

import {
  COUNT_SOURCE_SYSTEM,
  countBody,
  payloadHash,
  planEmission,
  provenanceKey,
  type EmissionCandidate,
  type EmissionPlan,
} from './count-emission';
import { CountRuleError } from './count-session.rules';
import type { BuiltLine, SessionRow } from './count-session.store';

export interface EmissionSummary {
  readonly chunks: number;
  readonly lines: number;
  readonly skipped: EmissionPlan['skipped'];
  readonly intentIds: readonly string[];
}

/** UTC, six fractional digits: the frozen Count Cut plus one microsecond (G6-6), computed by the database. */
async function frozenPostingDatetime(client: PoolClient, sessionId: string): Promise<string> {
  const r = await client.query<{ dt: string | null }>(
    `SELECT to_char((cut_at + interval '1 microsecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS dt
       FROM count_sessions WHERE id = $1`,
    [sessionId],
  );
  const dt = r.rows[0]?.dt;
  if (!dt) throw new CountRuleError('count_cut_missing', 'The session has no Count Cut, so nothing can be posted.');
  return dt;
}

async function itemRefs(client: PoolClient, productIds: readonly string[]): Promise<Map<string, string>> {
  const r = await client.query<{ tenant_product_id: string; erpnext_item_ref: string }>(
    `SELECT tenant_product_id, erpnext_item_ref
       FROM erpnext_item_map
      WHERE tenant_product_id = ANY($1::uuid[]) AND state = 'confirmed' AND retired_at IS NULL`,
    [productIds],
  );
  return new Map(r.rows.map((x) => [x.tenant_product_id, x.erpnext_item_ref]));
}

async function stockWarehouse(client: PoolClient, storeId: string): Promise<string | null> {
  const r = await client.query<{ erpnext_warehouse_ref: string }>(
    `SELECT erpnext_warehouse_ref FROM erpnext_warehouse_map
      WHERE store_id = $1 AND purpose = 'stock' AND retired_at IS NULL`,
    [storeId],
  );
  return r.rows[0]?.erpnext_warehouse_ref ?? null;
}

async function candidatesOf(
  client: PoolClient,
  sessionId: string,
  built: readonly BuiltLine[],
): Promise<EmissionCandidate[]> {
  const ids = built.map((b) => b.body.productId);
  const refs = await itemRefs(client, ids);
  const effects = await client.query<{ tenant_product_ref: string; correction_effect_ids: string[] | null }>(
    `SELECT tenant_product_ref, correction_effect_ids FROM count_session_lines WHERE session_id = $1`,
    [sessionId],
  );
  const byProduct = new Map(effects.rows.map((r) => [r.tenant_product_ref, r.correction_effect_ids ?? []]));
  return built.map((b) => ({
    productId: b.body.productId,
    varianceQuantity: b.body.varianceQuantity,
    countedQuantity: b.body.countedQuantity,
    stockingUnit: b.body.stockingUnit,
    refusalCode: b.body.refusal?.code ?? null,
    erpnextItemRef: refs.get(b.body.productId) ?? null,
    correctionEffectIds: byProduct.get(b.body.productId) ?? [],
  }));
}

/** Insert the chunks of an approved session and link their effects. Writes nothing when there is no chunk. */
export async function emitCountChunks(
  client: PoolClient,
  session: SessionRow,
  built: readonly BuiltLine[],
): Promise<EmissionSummary> {
  const warehouse = await stockWarehouse(client, session.store_id);
  const candidates = await candidatesOf(client, session.id, built);
  const plan = planEmission(candidates, warehouse ?? '');
  if (plan.chunks.length > 0 && warehouse === null) {
    throw new CountRuleError(
      'count_store_not_ready',
      'The store has no active stock warehouse mapping, so its count cannot be posted to ERP.',
    );
  }
  const stamp = plan.chunks.length > 0 ? await frozenPostingDatetime(client, session.id) : '';
  const intentIds: string[] = [];
  for (let i = 0; i < plan.chunks.length; i += 1) {
    intentIds.push(await insertChunk(client, session, plan, i, stamp));
  }
  return {
    chunks: plan.chunks.length,
    lines: plan.chunks.reduce((n, c) => n + c.length, 0),
    skipped: plan.skipped,
    intentIds,
  };
}

async function insertChunk(
  client: PoolClient,
  session: SessionRow,
  plan: EmissionPlan,
  index: number,
  stamp: string,
): Promise<string> {
  const lines = plan.chunks[index]!;
  const chunkNo = index + 1;
  const total = plan.chunks.length;
  const body = countBody({
    sessionId: session.id,
    storeId: session.store_id,
    chunk: chunkNo,
    chunkTotal: total,
    postingDatetime: stamp,
    lines,
  });
  const id = newId();
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id, payload_hash, status,
        count_session_id, count_chunk, count_chunk_total, count_posting_datetime)
     VALUES ($1, $2, $3, NULL, 'inventory_count', $4, $5, $6, $7, 'pending', $8, $9, $10, $11)
     ON CONFLICT (tenant_id, count_session_id, count_chunk) WHERE count_session_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      id,
      session.tenant_id,
      session.store_id,
      newId(),
      COUNT_SOURCE_SYSTEM,
      provenanceKey(session.id, chunkNo, total),
      payloadHash(body),
      session.id,
      chunkNo,
      total,
      stamp,
    ],
  );
  const intentId = inserted.rows[0]?.id;
  // A replay: the chunk exists already (the unique key held). Its frozen body and links are not rewritten.
  if (!intentId) return await existingChunkId(client, session, chunkNo);
  for (let seq = 0; seq < lines.length; seq += 1) {
    const l = lines[seq]!;
    await client.query(
      `INSERT INTO count_posting_lines
         (intent_id, tenant_id, line_seq, tenant_product_ref, erpnext_item_ref, warehouse_ref, counted_quantity, unit)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric(19,4), $8)`,
      [intentId, session.tenant_id, seq + 1, l.productId, l.erpnextItemRef, l.warehouseRef, l.countedQuantity, l.unit],
    );
    await linkEffects(client, intentId, l.correctionEffectIds);
  }
  return intentId;
}

async function existingChunkId(client: PoolClient, session: SessionRow, chunkNo: number): Promise<string> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM erpnext_posting_status WHERE count_session_id = $1 AND count_chunk = $2`,
    [session.id, chunkNo],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('CountEmission: the chunk neither inserted nor exists');
  return id;
}

/** `not_posted -> pending` for the line's effects. Refuses (rolls back) if any is not a fresh `not_posted` effect. */
async function linkEffects(client: PoolClient, intentId: string, effectIds: readonly string[]): Promise<void> {
  if (effectIds.length === 0) {
    throw new CountRuleError('count_line_without_effect', 'A line to post has no correction effect.');
  }
  const r = await client.query(
    `UPDATE inventory_effect_integration
        SET state = 'pending', posting_status_id = $1, updated_at = now()
      WHERE effect_id = ANY($2::uuid[]) AND state = 'not_posted'`,
    [intentId, effectIds],
  );
  if ((r.rowCount ?? 0) !== effectIds.length) {
    throw new CountRuleError('count_effect_not_postable', 'A correction effect of the count is not in the not_posted state.');
  }
}
