/**
 * Late-event compensation rules — Jira RT-1424 (RT-292 Gate 6, G6-5; Confluence page 78938114, conditions A to I).
 *
 * PURE: no I/O. `evaluateCompensation` decides, from ALREADY LOADED evidence, whether the explicit authorized
 * resolution may write the Retail-only compensation of one late pre-cut event that an ERPNext count already
 * absorbed. Any failed condition is a typed refusal and NOTHING is written (the caller throws before its first
 * INSERT; the post-write invariants of condition I roll the whole transaction back).
 *
 *   A  causal link         immutable references agree: finding, late event, count correction, same tenant / store /
 *                          product / position; the late event was learned after the cut and stamped at or before it
 *   B  independent proof   the Connector read the count's ledger row and the late event's ledger row back
 *                          (`erp_stock_import_rows`); Backend-Core's own state is never evidence
 *   C  ERP absorption      the late event is ERP book (`confirmed` or `external`) and its ledger posting stamp is
 *                          strictly earlier than the count's, from the two ledger rows, never Retail timestamps
 *   F  explainable         the absorbing ERP document is named
 *   H  exact quantity      the compensation is the late event's signed quantity, negated, equal to the ledger
 *                          quantity the Connector read; partial, changed or cancelled evidence refuses
 *   D  consistency         projected expected_erp_book after the compensation equals the Bin read after the late
 *                          event's confirmation; unrelated divergence therefore refuses
 *   G  deduplication       enforced by the service (replay) and by database UNIQUE constraints
 *   I  invariants          verified by the service in the same transaction before commit
 *   E  authorization       the controller's role guard plus a mandatory reason, audited in the same transaction
 */
import { createHash } from 'node:crypto';

/**
 * Condition E: the roles that may resolve a late event, G6-10's "authorized operator". Checked by the route guard AND
 * by the service against the caller's own membership in the tenant, because the route guard admits a platform admin
 * before it looks at a tenant role and this resolution has no platform override.
 */
export const COMPENSATION_ROLES = ['owner', 'tenant_admin'] as const;

export type CompensationRefusalCode =
  | 'compensation_link_invalid'
  | 'compensation_erp_evidence_missing'
  | 'compensation_erp_order_unproven'
  | 'compensation_not_explainable'
  | 'compensation_quantity_mismatch'
  | 'compensation_book_inconsistent'
  | 'compensation_already_exists'
  | 'compensation_invariant_failed';

export interface CompensationRefusal {
  readonly ok: false;
  readonly condition: 'A' | 'B' | 'C' | 'D' | 'F' | 'G' | 'H' | 'I';
  readonly code: CompensationRefusalCode;
  readonly message: string;
}

export interface CompensationPlan {
  readonly ok: true;
  /** Signed, exact: the late event's quantity, negated. */
  readonly quantity: string;
  /** The count document that holds the late event, as stored JSON text of `{doctype, name}`. */
  readonly absorbingDocument: string;
  /** Count effect the compensation compensates. */
  readonly countEffectId: string;
  /** The projected expected_erp_book after the compensation (D). */
  readonly projectedExpected: string;
  readonly evidence: Record<string, unknown>;
}

export interface LedgerRow {
  readonly isCancelled: boolean;
  /** `posting_date::text` and `posting_time` as read (site-local); null before migration 0118. */
  readonly postingDate: string | null;
  readonly postingTime: string | null;
  readonly actualQty: string;
  readonly stockUom: string;
  readonly creation: Date;
}

export interface CompensationEvidence {
  readonly session: { readonly state: string; readonly cutAt: Date | null };
  readonly finding: {
    readonly id: string;
    readonly sessionId: string;
    readonly productId: string;
    readonly quantity: string;
    readonly eventType: string;
    readonly eventReference: string;
    readonly sourceSystem: string;
    readonly externalId: string;
    readonly effectId: string;
    readonly erpStamp: Date;
    readonly detectedInState: string;
  };
  readonly late: {
    readonly id: string;
    readonly storeId: string;
    readonly productId: string | null;
    readonly quantity: string;
    readonly unit: string;
    readonly locationId: string | null;
    readonly status: string | null;
    readonly movementType: string;
    readonly origin: string;
    readonly eventType: string | null;
    readonly eventRefId: string | null;
    readonly sourceSystem: string | null;
    readonly externalId: string | null;
    readonly receivedAt: Date;
    readonly integrationState: string | null;
    readonly erpDocumentRef: string | null;
    readonly erpConfirmedAt: Date | null;
  } | null;
  readonly storeId: string;
  /** The line's count-correction effects (`count_session_lines.correction_effect_ids`). */
  readonly countEffects: ReadonlyArray<{
    readonly id: string;
    readonly movementType: string;
    readonly compensates: string | null;
    readonly locationId: string | null;
    readonly status: string | null;
  }>;
  readonly stockCountId: string | null;
  readonly countLine: {
    readonly result: string | null;
    readonly verifiedQtyAfter: string | null;
    readonly countedQuantity: string;
    readonly unit: string;
    readonly intentStatus: string;
    readonly documentRef: string | null;
    readonly postedAt: Date | null;
  } | null;
  readonly countRows: readonly LedgerRow[];
  readonly lateRows: readonly LedgerRow[];
  readonly bin: { readonly quantity: string; readonly readAt: Date; readonly uom: string | null } | null;
  readonly position: {
    readonly operationalPosition: string;
    readonly expectedErpBook: string;
    readonly operationalUnit: string | null;
    readonly erpStockUom: string | null;
  } | null;
}

const SCALE = 6;

/** Exact decimal text to a scaled bigint (up to 6 decimals; sign allowed). Throws on anything else. */
export function dec(value: string): bigint {
  const m = /^(-?)(\d{1,19})(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!m) throw new Error(`not an exact decimal: ${value}`);
  const [, sign, whole, frac = ''] = m;
  const n = BigInt(whole! + frac.padEnd(SCALE, '0'));
  return sign === '-' ? -n : n;
}

export function decText(n: bigint): string {
  const neg = n < 0n;
  const abs = (neg ? -n : n).toString().padStart(SCALE + 1, '0');
  const text = `${abs.slice(0, -SCALE)}.${abs.slice(-SCALE)}`.replace(/\.?0+$/, '');
  return `${neg ? '-' : ''}${text === '' ? '0' : text}`;
}

const POSITION_AFTER_APPROVAL = ['approved', 'posting', 'confirmed', 'needs_attention', 'closed'];

function refuse(
  condition: CompensationRefusal['condition'],
  code: CompensationRefusalCode,
  message: string,
): CompensationRefusal {
  return { ok: false, condition, code, message };
}

/** `YYYY-MM-DD HH:MM:SS.ffffff`, comparable as text; null when the stamp is absent (a row imported before 0118). */
function postingStamp(row: Pick<LedgerRow, 'postingDate' | 'postingTime'>): string | null {
  if (row.postingDate === null || row.postingTime === null) return null;
  const [hms, frac = ''] = row.postingTime.split('.');
  return `${row.postingDate} ${hms}.${frac.padEnd(6, '0')}`;
}

/** Deterministic idempotency key (G): derived only from the immutable references of condition A. */
export function compensationKey(input: {
  readonly sessionId: string;
  readonly countEffectId: string;
  readonly lateEffectId: string;
}): string {
  return createHash('sha256')
    .update(`count_late_compensation|${input.sessionId}|${input.countEffectId}|${input.lateEffectId}`)
    .digest('hex');
}

type Late = NonNullable<CompensationEvidence['late']>;
type CountLine = NonNullable<CompensationEvidence['countLine']>;
type Step<T> = T | CompensationRefusal;
interface Total {
  readonly total: bigint;
  /** The latest posting stamp, `YYYY-MM-DD HH:MM:SS.ffffff` (site-local, comparable as text). */
  readonly stamp: string;
  /** `creation` (epoch ms) of the row at that position: the tie-break of an equal stamp. */
  readonly creation: number;
  readonly uom: string;
}
interface Ledgers {
  readonly line: CountLine;
  readonly countTotal: Total;
  readonly lateTotal: Total;
}

const isRefusal = (v: unknown): v is CompensationRefusal =>
  typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;

/**
 * The ledger rows of one voucher at the counted item: the quantity they add up to and the LATEST of their positions
 * in ERPNext's ledger order, or why they cannot be used. ERPNext orders a warehouse's ledger by posting datetime and
 * then by `creation` (a tie), so a position is the pair (posting stamp, creation), never the stamp alone.
 */
function ledgerTotal(rows: readonly LedgerRow[]): Total | string {
  if (rows.length === 0) return 'no ledger row was read back';
  if (rows.some((r) => r.isCancelled)) return 'a ledger row was cancelled after it was read';
  const uoms = new Set(rows.map((r) => r.stockUom));
  if (uoms.size !== 1) return 'the ledger rows carry different units';
  const positions = rows.map((r) => ({ stamp: postingStamp(r), creation: r.creation.getTime() }));
  if (positions.some((p) => p.stamp === null)) return 'a ledger row has no posting stamp (imported before it was recorded)';
  const total = rows.reduce((sum, r) => sum + dec(r.actualQty), 0n);
  const latest = positions.reduce((m, p) => (comparePositions(p, m) > 0 ? p : m));
  return { total, stamp: latest.stamp as string, creation: latest.creation, uom: [...uoms][0] as string };
}

/** Order two ledger positions: posting stamp first (comparable text), `creation` only on an equal stamp. */
function comparePositions(
  a: { stamp: string | null; creation: number },
  b: { stamp: string | null; creation: number },
): number {
  if (a.stamp !== b.stamp) return (a.stamp as string) < (b.stamp as string) ? -1 : 1;
  return a.creation === b.creation ? 0 : a.creation < b.creation ? -1 : 1;
}

/** The finding's immutable references are the late event's own (never a count correction). */
function referencesAgree(e: CompensationEvidence, late: Late): boolean {
  const f = e.finding;
  return (
    late.id === f.effectId &&
    late.storeId === e.storeId &&
    late.productId === f.productId &&
    late.eventType !== null &&
    late.eventType === f.eventType &&
    (late.eventRefId ?? late.id) === f.eventReference &&
    (late.sourceSystem ?? late.origin) === f.sourceSystem &&
    (late.externalId ?? late.id) === f.externalId &&
    late.movementType !== 'count_correction'
  );
}

/** A: the finding, the late event and the count correction agree by immutable references. */
function checkLink(e: CompensationEvidence): Step<{ late: Late; countEffectId: string; lateQty: bigint }> {
  const { finding, late, session } = e;
  const bad = (message: string) => refuse('A', 'compensation_link_invalid', message);
  if (!POSITION_AFTER_APPROVAL.includes(session.state) || !POSITION_AFTER_APPROVAL.includes(finding.detectedInState)) {
    return bad('Only a late event found after approval can be compensated.');
  }
  if (late === null || session.cutAt === null) return bad('The late event or the Count Cut is missing.');
  if (!referencesAgree(e, late)) return bad('The finding and the late event do not carry the same references.');
  if (!(late.receivedAt.getTime() > session.cutAt.getTime()) || finding.erpStamp.getTime() > session.cutAt.getTime()) {
    return bad('The late event must be learned after the cut and stamped at or before it.');
  }
  const lateQty = dec(late.quantity);
  if (lateQty === 0n || dec(finding.quantity) !== (lateQty < 0n ? -lateQty : lateQty)) {
    return bad('The finding quantity is not the late event quantity.');
  }
  const atPosition = e.countEffects.filter(
    (c) => c.movementType === 'count_correction' && c.locationId === late.locationId && c.status === late.status,
  );
  if (atPosition.length !== 1 || e.stockCountId === null) {
    return bad('The count must have exactly one correction at the late event position.');
  }
  return { late, countEffectId: atPosition[0]!.id, lateQty };
}

/** B (and F): the Connector read back the count and the late event; the absorbing document is named. */
function checkReadBack(e: CompensationEvidence): Step<Ledgers> {
  const line = e.countLine;
  if (
    line === null ||
    line.result !== 'adjusted' ||
    line.intentStatus !== 'posted' ||
    line.verifiedQtyAfter === null ||
    dec(line.verifiedQtyAfter) !== dec(line.countedQuantity)
  ) {
    return refuse(
      'B',
      'compensation_erp_evidence_missing',
      'The count chunk was not posted and verified at its target by the Connector.',
    );
  }
  if (line.documentRef === null || line.documentRef.length === 0) {
    return refuse('F', 'compensation_not_explainable', 'The absorbing ERP document is not named.');
  }
  const countTotal = ledgerTotal(e.countRows);
  if (typeof countTotal === 'string') {
    return refuse('B', 'compensation_erp_evidence_missing', `Count ledger evidence: ${countTotal}.`);
  }
  const lateTotal = ledgerTotal(e.lateRows);
  if (typeof lateTotal === 'string') {
    return refuse('B', 'compensation_erp_evidence_missing', `Late event ledger evidence: ${lateTotal}.`);
  }
  return { line, countTotal, lateTotal };
}

/** C (second half) and H: ERP ordering from the two ledger postings, and the exact quantity the Connector read. */
function checkOrderAndQuantity(late: Late, ledgers: Ledgers, lateQty: bigint): CompensationRefusal | null {
  if (comparePositions(ledgers.lateTotal, ledgers.countTotal) >= 0) {
    return refuse(
      'C',
      'compensation_erp_order_unproven',
      'The late event ledger posting is not earlier than the count ledger posting.',
    );
  }
  if (late.unit !== ledgers.line.unit || ledgers.lateTotal.uom !== ledgers.countTotal.uom) {
    return refuse('H', 'compensation_quantity_mismatch', 'The late event and the count differ in unit.');
  }
  if (ledgers.lateTotal.total !== lateQty) {
    return refuse(
      'H',
      'compensation_quantity_mismatch',
      'The ledger quantity the Connector read is not the late event quantity.',
    );
  }
  return null;
}

/** D: the Bin was read after both confirmations and equals the projected expected ERP book. */
function checkBook(e: CompensationEvidence, late: Late, line: CountLine, compensation: bigint): Step<bigint> {
  const bad = (message: string) => refuse('D', 'compensation_book_inconsistent', message);
  if (e.position === null || e.bin === null) return bad('No pending-aware position or Bin snapshot exists for the line.');
  const confirmations = [late.erpConfirmedAt, line.postedAt]
    .filter((d): d is Date => d !== null)
    .map((d) => d.getTime());
  const newestLedger = Math.max(...[...e.countRows, ...e.lateRows].map((r) => r.creation.getTime()));
  const readAt = e.bin.readAt.getTime();
  if ((confirmations.length > 0 && readAt < Math.max(...confirmations)) || readAt < newestLedger) {
    return bad('The Bin snapshot was read before the late event and the count were confirmed.');
  }
  if (e.bin.uom !== null && e.position.operationalUnit !== null && e.bin.uom !== e.position.operationalUnit) {
    return bad('The Bin unit differs from the operational unit.');
  }
  const bin = dec(e.bin.quantity);
  const projected = dec(e.position.expectedErpBook) + compensation;
  if (projected !== bin || dec(e.position.operationalPosition) + compensation !== bin) {
    return bad(
      'After the compensation the expected ERP book would not equal the Bin: other divergence remains (an unrelated one, or ' +
        'another uncompensated late event or pending effect on the same product). Nothing is masked: resolve it by an ' +
        'authorized recount or the governed ERP break-glass path.',
    );
  }
  return projected;
}

export function evaluateCompensation(e: CompensationEvidence): CompensationPlan | CompensationRefusal {
  const link = checkLink(e);
  if (isRefusal(link)) return link;
  const { late, countEffectId, lateQty } = link;
  // C (first half): the late event must already be ERP book. Judged before the ledger evidence, which a pending
  // event cannot have.
  if (late.integrationState !== 'confirmed' && late.integrationState !== 'external') {
    return refuse(
      'C',
      'compensation_erp_order_unproven',
      'The late event is not ERP book yet (pending or unposted); compensating would misstate expected ERP book.',
    );
  }
  const ledgers = checkReadBack(e);
  if (isRefusal(ledgers)) return ledgers;
  const refusal = checkOrderAndQuantity(late, ledgers, lateQty);
  if (refusal !== null) return refusal;
  const compensation = -lateQty;
  const projected = checkBook(e, late, ledgers.line, compensation);
  if (isRefusal(projected)) return projected;
  return {
    ok: true,
    quantity: decText(compensation),
    absorbingDocument: ledgers.line.documentRef as string,
    countEffectId,
    projectedExpected: decText(projected),
    evidence: {
      countDocument: ledgers.line.documentRef,
      countLedgerPosting: ledgers.countTotal.stamp,
      lateLedgerPosting: ledgers.lateTotal.stamp,
      lateLedgerQuantity: decText(ledgers.lateTotal.total),
      lateIntegrationState: late.integrationState,
      binQuantity: e.bin!.quantity,
      binReadAt: e.bin!.readAt.toISOString(),
      expectedBefore: e.position!.expectedErpBook,
      expectedAfter: decText(projected),
    },
  };
}
