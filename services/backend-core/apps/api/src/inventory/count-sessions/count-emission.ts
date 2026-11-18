/**
 * Count emission rules — Jira RT-1423 (RT-292 Gate 6; posting-feed.yaml 1.15.0-draft). PURE: no database,
 * no clock. An approved Count Session becomes `inventory_count` work items of at most 100 lines each:
 *
 *   - only lines with a NON-ZERO Retail variance, no refusal and a confirmed ERP item map are sent
 *     (G6-2: zero variance is recorded and audited, never posted);
 *   - the value sent is the ABSOLUTE counted quantity (the sum of the observed positions, G6-1), never the
 *     Retail variance (ERPNext's Stock Reconciliation takes a target, and an absolute target also removes
 *     any earlier Retail/ERP divergence);
 *   - the chunks are cut in product order so the same session always yields the same chunks;
 *   - the provenance key is `count:<sessionId>` for a one-chunk count and `count:<sessionId>:<chunk>`
 *     above one, the key the Connector's Draft-aware lookup uses;
 *   - the body is frozen into `count_posting_lines` at approval; the feed reads only that.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../../common/hashing/canonical-json';
import { parseQuantity } from '../../common/quantity/decimal-quantity';

/** A Stock Reconciliation holds at most 100 rows (G6-6, posting-feed.yaml `CountPosting.lines`). */
export const COUNT_CHUNK_MAX = 100;

export const COUNT_SOURCE_SYSTEM = 'retail-tower';

type SkipReason = 'zero_variance' | 'refused' | 'unmapped';

export interface EmissionCandidate {
  readonly productId: string;
  /** Counted minus expected, exact decimal text. */
  readonly varianceQuantity: string;
  /** The ABSOLUTE counted total over all observed positions, exact decimal text. */
  readonly countedQuantity: string;
  readonly stockingUnit: string;
  /** The line's refusal code (count_line_unmapped, ...) or null. */
  readonly refusalCode: string | null;
  /** The confirmed ERP item reference of the product, or null when unmapped. */
  readonly erpnextItemRef: string | null;
  /** The `count_correction` effects the approval wrote for this line. */
  readonly correctionEffectIds: readonly string[];
}

interface EmissionLine {
  readonly productId: string;
  readonly erpnextItemRef: string;
  readonly warehouseRef: string;
  readonly countedQuantity: string;
  readonly unit: string;
  readonly correctionEffectIds: readonly string[];
}

interface SkippedLine {
  readonly productId: string;
  readonly reason: SkipReason;
}

export interface EmissionPlan {
  /** Lines in chunk order, each chunk at most COUNT_CHUNK_MAX. */
  readonly chunks: readonly (readonly EmissionLine[])[];
  readonly skipped: readonly SkippedLine[];
}

/** Which lines are sent, which are skipped and why, cut into chunks of at most `max`. */
export function planEmission(
  candidates: readonly EmissionCandidate[],
  warehouseRef: string,
  max: number = COUNT_CHUNK_MAX,
): EmissionPlan {
  if (!Number.isInteger(max) || max < 1 || max > COUNT_CHUNK_MAX) {
    throw new RangeError(`chunk size must be 1..${COUNT_CHUNK_MAX}`);
  }
  const included: EmissionLine[] = [];
  const skipped: SkippedLine[] = [];
  const ordered = [...candidates].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
  for (const c of ordered) {
    const reason = skipReason(c);
    if (reason !== null) {
      skipped.push({ productId: c.productId, reason });
      continue;
    }
    included.push({
      productId: c.productId,
      erpnextItemRef: c.erpnextItemRef as string,
      warehouseRef,
      countedQuantity: c.countedQuantity,
      unit: c.stockingUnit,
      correctionEffectIds: c.correctionEffectIds,
    });
  }
  return { chunks: chunk(included, max), skipped };
}

function skipReason(c: EmissionCandidate): SkipReason | null {
  if (c.refusalCode !== null) return 'refused';
  if (parseQuantity(c.varianceQuantity, 'varianceQuantity') === 0n) return 'zero_variance';
  if (c.erpnextItemRef === null) return 'unmapped';
  return null;
}

export function chunk<T>(items: readonly T[], max: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += max) out.push(items.slice(i, i + max));
  return out;
}

/** `count:<sessionId>` for a one-chunk count, `count:<sessionId>:<chunk>` (1-based) above one. */
export function provenanceKey(sessionId: string, chunkNo: number, chunkTotal: number): string {
  if (chunkNo < 1 || chunkNo > chunkTotal) throw new RangeError('chunk is outside 1..chunkTotal');
  return chunkTotal === 1 ? `count:${sessionId}` : `count:${sessionId}:${chunkNo}`;
}

export interface CountBodyInput {
  readonly sessionId: string;
  readonly storeId: string;
  readonly chunk: number;
  readonly chunkTotal: number;
  /** The frozen Count Cut plus one microsecond, UTC, six fractional digits (computed by the database). */
  readonly postingDatetime: string;
  readonly lines: readonly EmissionLine[];
}

/** The wire `CountPosting` of one chunk (posting-feed.yaml 1.15.0-draft), strict and frozen. */
export function countBody(input: CountBodyInput): Record<string, unknown> {
  if (input.lines.length < 1 || input.lines.length > COUNT_CHUNK_MAX) {
    throw new RangeError(`a chunk holds 1..${COUNT_CHUNK_MAX} lines`);
  }
  return {
    countSessionRef: input.sessionId,
    chunk: input.chunk,
    chunkCount: input.chunkTotal,
    storeId: input.storeId,
    mappingBucketRef: `${input.storeId}:stock`,
    postingDatetime: input.postingDatetime,
    lines: input.lines.map((l, i) => ({
      lineSeq: i + 1,
      erpnextItemRef: { doctype: 'Item', name: l.erpnextItemRef },
      warehouseRef: { doctype: 'Warehouse', name: l.warehouseRef },
      countedQuantity: l.countedQuantity,
      unit: l.unit,
    })),
  };
}

/** SHA-256 of the canonical count body (the feed's `payloadHash`). */
export function payloadHash(body: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

// ---- lifecycle ----------------------------------------------------------------------------------

export type ChunkStatus = 'pending' | 'posted' | 'verified_noop' | 'permanently_rejected';

export interface ChunkResult {
  readonly status: ChunkStatus;
  /** True when the Connector reported at least one `rejected` line for this chunk. */
  readonly hasRejectedLine: boolean;
}

export type SessionOutcome = 'posting' | 'confirmed' | 'needs_attention';

/**
 * The session state from its chunks. `confirmed` only when EVERY chunk is posted or a verified no-op with
 * no rejected line: a partly refused chunk is never fully confirmed. Any dead-lettered or reconciled chunk
 * and any rejected line, or a line refused at approval (`hasRefusedLine`: it could not post), puts the
 * session in `needs_attention` at once, whatever the other chunks are still doing; otherwise it stays
 * `posting`. No chunks and no refused line is `confirmed` (nothing needed ERP).
 */
export function sessionOutcome(chunks: readonly ChunkResult[], hasRefusedLine = false): SessionOutcome {
  if (hasRefusedLine || chunks.some((c) => c.status === 'permanently_rejected' || c.hasRejectedLine)) {
    return 'needs_attention';
  }
  if (chunks.every((c) => c.status === 'posted' || c.status === 'verified_noop')) return 'confirmed';
  return 'posting';
}

export type LineResult = 'adjusted' | 'verified_noop' | 'rejected';

/** The integration state a counted line's correction effects take for the Connector's line result. */
export function effectTargetFor(result: LineResult): 'confirmed' | 'rejected' {
  return result === 'rejected' ? 'rejected' : 'confirmed';
}
