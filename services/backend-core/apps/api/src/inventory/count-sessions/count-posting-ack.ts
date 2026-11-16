/**
 * Count chunk acknowledgement — Jira RT-1423 (RT-292 Gate 6). The ack of an `inventory_count` work item
 * changes INTEGRATION STATE, never quantity (771, DC-3): the Retail `count_correction` effects are never
 * written here, only their `inventory_effect_integration` rows and the chunk's own status and line results.
 *
 * Runs on the caller's client inside the ack transaction (the posting row is already locked `FOR UPDATE`,
 * after the tenant's feed sequence lock), so the chunk, its lines, its effects and the session move together
 * or not at all.
 *
 *   - `posted` and `verified_noop` carry per-line results (`lines`, REQUIRED for a count chunk). A line the
 *     Connector `adjusted` or verified as a no-op confirms its effects; a line it `rejected` rejects them
 *     (they stand, DC-5, and a typed refusal explains why). A chunk with any rejected line is never fully
 *     confirmed: the session goes to `needs_attention`.
 *   - a no-op effect is `confirmed` with NO document (the reason `count_verified_noop`, allowed by the 0116
 *     CHECK): never a fabricated document reference.
 *   - the session moves `posting -> confirmed` only when every chunk is posted or a verified no-op with no
 *     rejected line and no line was refused at approval, and `posting -> needs_attention` as soon as any
 *     chunk is dead-lettered or reconciled, or any line is rejected or refused. No ERP document is ever
 *     cancelled or edited to hide a mismatch.
 */
import type { PoolClient } from 'pg';

import {
  effectTargetFor,
  sessionOutcome,
  type ChunkResult,
  type ChunkStatus,
  type LineResult,
  type SessionOutcome,
} from './count-emission';

export interface AckLine {
  readonly lineSeq: number;
  readonly result: LineResult;
  readonly verifiedQtyAfter: string | null;
  readonly refusal: { readonly code: string; readonly message: string } | null;
}

export class CountAckLinesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CountAckLinesError';
  }
}

interface StoredLine {
  readonly line_seq: number;
  readonly tenant_product_ref: string;
}

/** The lines must be exactly the chunk's lines: one result for each, none unknown, none repeated. */
export function checkLinesMatch(stored: readonly number[], lines: readonly AckLine[]): void {
  const want = new Set(stored);
  const seen = new Set<number>();
  for (const l of lines) {
    if (!want.has(l.lineSeq)) throw new CountAckLinesError(`lineSeq ${l.lineSeq} is not a line of this chunk`);
    if (seen.has(l.lineSeq)) throw new CountAckLinesError(`lineSeq ${l.lineSeq} is reported twice`);
    seen.add(l.lineSeq);
  }
  if (seen.size !== want.size) throw new CountAckLinesError('every line of the chunk needs a result');
  for (const l of lines) {
    if (l.result === 'rejected' && l.refusal === null) {
      throw new CountAckLinesError(`rejected line ${l.lineSeq} carries no refusal`);
    }
    if (l.result !== 'rejected' && l.verifiedQtyAfter === null) {
      throw new CountAckLinesError(`line ${l.lineSeq} carries no verifiedQtyAfter`);
    }
  }
}

/** Record the per-line results of a chunk and move its lines' effects. Returns the number of effects moved. */
export async function applyCountLineResults(
  client: PoolClient,
  intentId: string,
  lines: readonly AckLine[],
  documentRef: string | null,
): Promise<number> {
  const stored = await client.query<StoredLine>(
    `SELECT line_seq, tenant_product_ref FROM count_posting_lines WHERE intent_id = $1 ORDER BY line_seq`,
    [intentId],
  );
  checkLinesMatch(
    stored.rows.map((r) => r.line_seq),
    lines,
  );
  const session = await client.query<{ count_session_id: string }>(
    `SELECT count_session_id FROM erpnext_posting_status WHERE id = $1`,
    [intentId],
  );
  const sessionId = session.rows[0]?.count_session_id;
  if (!sessionId) throw new CountAckLinesError('not a count chunk');
  let moved = 0;
  for (const row of stored.rows) {
    const line = lines.find((l) => l.lineSeq === row.line_seq) as AckLine;
    await client.query(
      `UPDATE count_posting_lines
          SET result = $3, verified_qty_after = $4, refusal_code = $5, refusal_message = $6, resulted_at = now()
        WHERE intent_id = $1 AND line_seq = $2 AND result IS NULL`,
      [
        intentId,
        row.line_seq,
        line.result,
        line.result === 'rejected' ? null : line.verifiedQtyAfter,
        line.refusal?.code ?? null,
        line.refusal?.message.slice(0, 1000) ?? null,
      ],
    );
    moved += await moveLineEffects(client, sessionId, row.tenant_product_ref, line, documentRef);
  }
  return moved;
}

async function moveLineEffects(
  client: PoolClient,
  sessionId: string,
  productId: string,
  line: AckLine,
  documentRef: string | null,
): Promise<number> {
  const target = effectTargetFor(line.result);
  const noop = line.result === 'verified_noop';
  const reason = target === 'rejected' ? `count_line_${line.refusal?.code ?? 'rejected'}`.slice(0, 500) : noop ? 'count_verified_noop' : null;
  const r = await client.query(
    `UPDATE inventory_effect_integration ie
        SET state = $3,
            erp_document_ref = CASE WHEN $3 = 'confirmed' AND NOT $4::boolean THEN $5 ELSE NULL END,
            erp_confirmed_at = CASE WHEN $3 = 'confirmed' THEN now() ELSE NULL END,
            state_reason = $6,
            updated_at = now()
      WHERE ie.state = 'pending'
        AND ie.effect_id = ANY (SELECT unnest(correction_effect_ids)
                                  FROM count_session_lines
                                 WHERE session_id = $1 AND tenant_product_ref = $2)`,
    [sessionId, productId, target, noop, documentRef, reason],
  );
  return r.rowCount ?? 0;
}

/**
 * Recompute and persist the session state from its chunks (after any chunk ack, including a dead-letter).
 * Only a session still `posting` moves: `needs_attention` is left for an explicit authorized resolution.
 */
export async function recomputeCountSession(client: PoolClient, intentId: string): Promise<SessionOutcome | null> {
  const head = await client.query<{ count_session_id: string; tenant_id: string }>(
    `SELECT count_session_id, tenant_id FROM erpnext_posting_status WHERE id = $1`,
    [intentId],
  );
  const sessionId = head.rows[0]?.count_session_id;
  if (!sessionId) return null;
  const chunks = await client.query<{ status: ChunkStatus; has_rejected: boolean }>(
    `SELECT p.status,
            EXISTS (SELECT 1 FROM count_posting_lines l WHERE l.intent_id = p.id AND l.result = 'rejected') AS has_rejected
       FROM erpnext_posting_status p
      WHERE p.count_session_id = $1 AND p.kind = 'inventory_count'`,
    [sessionId],
  );
  const refused = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM count_session_lines WHERE session_id = $1 AND refusal_code IS NOT NULL`,
    [sessionId],
  );
  const results: ChunkResult[] = chunks.rows.map((c) => ({ status: c.status, hasRejectedLine: c.has_rejected }));
  const outcome = sessionOutcome(results, Number(refused.rows[0]?.n ?? '0') > 0);
  if (outcome !== 'posting') {
    await client.query(
      `UPDATE count_sessions SET state = $2, updated_at = now() WHERE id = $1 AND state = 'posting'`,
      [sessionId, outcome],
    );
  }
  return outcome;
}
