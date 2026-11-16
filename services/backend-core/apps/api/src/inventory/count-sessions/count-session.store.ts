/**
 * Count Session persistence — Jira RT-1420. Raw SQL on the tenant-context
 * client (FORCE RLS: every statement sees only the caller's tenant). The
 * service owns the transaction and the rules; this file owns the SQL and the
 * wire projections (contract `CountSession`, `CountVarianceLine`,
 * `CountLateEventFinding`, `CountObservation`).
 */
import { ConflictException } from '@nestjs/common';
import { newId } from '@data-pulse-2/shared';
import type { PoolClient } from 'pg';

import { formatQuantity, parseQuantity } from '../decimal-quantity';
import {
  COUNT_VARIANCE_FLAGS,
  lineQuantities,
  lateAssessment,
  refusalFor,
  type CountRefusalCode,
  type CountSessionState,
  type CountVarianceFlag,
  type PositionQuantity,
} from './count-session.rules';

export const LIVE_STATES: readonly CountSessionState[] = [
  'open',
  'cut_taken',
  'submitted',
  'approved',
  'posting',
  'needs_attention',
];

export interface SessionRow {
  id: string;
  tenant_id: string;
  store_id: string;
  state: CountSessionState;
  scope_product_ids: string[];
  note: string | null;
  opened_by: string;
  opened_at: Date;
  cut_at: Date | null;
  cut_watermark: string | null;
  cut_taken_by: string | null;
  submitted_by: string | null;
  submitted_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  approval_policy: 'strict_separation' | 'small_merchant_exception' | null;
  self_approved: boolean | null;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  updated_at: Date;
}

export interface LineRow {
  session_id: string;
  tenant_product_ref: string;
  stocking_unit: string | null;
  expected_total: string | null;
  line_version: number;
  reset_after_seq: string;
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  acknowledgement_note: string | null;
  acknowledged_version: number | null;
  refusal_code: CountRefusalCode | null;
  stock_count_id: string | null;
  correction_effect_ids: string[] | null;
}

export interface CountSessionBody {
  readonly id: string;
  readonly storeId: string;
  readonly state: CountSessionState;
  readonly scope: { readonly kind: 'products'; readonly productIds: string[] };
  readonly note: string | null;
  readonly cut: {
    readonly watermark: string;
    readonly cutAt: string;
    readonly takenBy: string;
  } | null;
  readonly openedBy: string;
  readonly openedAt: string;
  readonly counterIds: string[];
  readonly submittedBy: string | null;
  readonly submittedAt: string | null;
  readonly approval: {
    readonly approvedBy: string;
    readonly approvedAt: string;
    readonly policy: 'strict_separation' | 'small_merchant_exception';
    readonly selfApproved: boolean;
  } | null;
  readonly cancellation: {
    readonly cancelledBy: string;
    readonly cancelledAt: string;
    readonly reason: string;
  } | null;
  readonly lateEventFindingCount: number;
  readonly updatedAt: string;
}

export interface ObservationBody {
  readonly productId: string;
  readonly locationId: string;
  readonly inventoryStatus: string;
  readonly countedQuantity: string;
  readonly stockingUnit: string;
  readonly countedBy: string;
  readonly countedAt: string;
}

export interface VarianceLineBody {
  readonly productId: string;
  readonly lineVersion: string;
  readonly stockingUnit: string;
  readonly expectedQuantity: string;
  readonly countedQuantity: string;
  readonly varianceQuantity: string;
  readonly flags: CountVarianceFlag[];
  readonly acknowledgementRequired: boolean;
  readonly acknowledgement: {
    readonly acknowledgedBy: string;
    readonly acknowledgedAt: string;
    readonly note: string | null;
  } | null;
  readonly refusal: { readonly code: CountRefusalCode; readonly message: string } | null;
  readonly observations: Array<{
    locationId: string;
    inventoryStatus: string;
    countedQuantity: string;
  }>;
}

export interface FindingBody {
  readonly id: string;
  readonly sessionId: string;
  readonly productId: string;
  readonly assessment: 'understated' | 'overstated';
  readonly quantity: string;
  readonly linkedEvent: {
    readonly eventType: string;
    readonly reference: string;
    readonly sourceSystem: string;
    readonly externalId: string;
    readonly effectId: string | null;
  };
  readonly oversellRisk: boolean;
  readonly erpStamp: string;
  readonly detectedAt: string;
  readonly detectedInState: CountSessionState;
}

const SESSION_COLUMNS = `id, tenant_id, store_id, state, scope_product_ids, note, opened_by, opened_at, cut_at,
  cut_watermark, cut_taken_by, submitted_by, submitted_at, approved_by, approved_at, approval_policy, self_approved,
  cancelled_by, cancelled_at, cancel_reason, updated_at`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function loadSession(
  client: PoolClient,
  storeId: string,
  sessionId: string,
  lock: boolean,
): Promise<SessionRow | undefined> {
  const r = await client.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM count_sessions WHERE id = $1 AND store_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [sessionId, storeId],
  );
  return r.rows[0];
}

export async function loadLines(client: PoolClient, sessionId: string): Promise<LineRow[]> {
  const r = await client.query<LineRow>(
    `SELECT session_id, tenant_product_ref, stocking_unit, expected_total::text AS expected_total, line_version,
            reset_after_seq::text AS reset_after_seq, acknowledged_by, acknowledged_at, acknowledgement_note,
            acknowledged_version, refusal_code, stock_count_id, correction_effect_ids
       FROM count_session_lines WHERE session_id = $1 ORDER BY tenant_product_ref`,
    [sessionId],
  );
  return r.rows;
}

export async function sessionBody(client: PoolClient, row: SessionRow): Promise<CountSessionBody> {
  const counters = await client.query<{ counted_by: string }>(
    `SELECT DISTINCT counted_by FROM count_observations WHERE session_id = $1 ORDER BY counted_by`,
    [row.id],
  );
  const findings = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM count_late_event_findings WHERE session_id = $1`,
    [row.id],
  );
  return {
    id: row.id,
    storeId: row.store_id,
    state: row.state,
    scope: { kind: 'products', productIds: row.scope_product_ids },
    note: row.note,
    cut:
      row.cut_at && row.cut_watermark && row.cut_taken_by
        ? {
            watermark: row.cut_watermark,
            cutAt: row.cut_at.toISOString(),
            takenBy: row.cut_taken_by,
          }
        : null,
    openedBy: row.opened_by,
    openedAt: row.opened_at.toISOString(),
    counterIds: counters.rows.map((c) => c.counted_by),
    submittedBy: row.submitted_by,
    submittedAt: iso(row.submitted_at),
    approval:
      row.approved_by && row.approved_at && row.approval_policy && row.self_approved !== null
        ? {
            approvedBy: row.approved_by,
            approvedAt: row.approved_at.toISOString(),
            policy: row.approval_policy,
            selfApproved: row.self_approved,
          }
        : null,
    cancellation:
      row.cancelled_by && row.cancelled_at && row.cancel_reason
        ? {
            cancelledBy: row.cancelled_by,
            cancelledAt: row.cancelled_at.toISOString(),
            reason: row.cancel_reason,
          }
        : null,
    lateEventFindingCount: Number(findings.rows[0]?.n ?? '0'),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function counterIds(client: PoolClient, sessionId: string): Promise<string[]> {
  const r = await client.query<{ counted_by: string }>(
    `SELECT DISTINCT counted_by FROM count_observations WHERE session_id = $1`,
    [sessionId],
  );
  return r.rows.map((x) => x.counted_by);
}

// ---- Effective observations and expected positions -------------------------

interface EffectiveObservation extends PositionQuantity {
  readonly stockingUnit: string;
  readonly countedBy: string;
  readonly countedAt: Date;
}

/** The latest observation of each position after the line's last reset. */
async function effectiveObservations(
  client: PoolClient,
  sessionId: string,
  productId: string,
  resetAfterSeq: string,
): Promise<EffectiveObservation[]> {
  const r = await client.query<{
    location_id: string;
    inventory_status: string;
    counted_quantity: string;
    stocking_unit: string;
    counted_by: string;
    counted_at: Date;
  }>(
    `SELECT DISTINCT ON (location_id, inventory_status)
            location_id, inventory_status, counted_quantity::text AS counted_quantity, stocking_unit, counted_by, counted_at
       FROM count_observations
      WHERE session_id = $1 AND tenant_product_ref = $2 AND seq > $3::bigint
      ORDER BY location_id, inventory_status, seq DESC`,
    [sessionId, productId, resetAfterSeq],
  );
  return r.rows.map((o) => ({
    locationId: o.location_id,
    inventoryStatus: o.inventory_status,
    quantity: o.counted_quantity,
    stockingUnit: o.stocking_unit,
    countedBy: o.counted_by,
    countedAt: o.counted_at,
  }));
}

async function expectedPositions(
  client: PoolClient,
  sessionId: string,
  productId: string,
): Promise<PositionQuantity[]> {
  const r = await client.query<{
    location_id: string;
    inventory_status: string;
    expected_quantity: string;
  }>(
    `SELECT location_id, inventory_status, expected_quantity::text AS expected_quantity
       FROM count_session_expected WHERE session_id = $1 AND tenant_product_ref = $2`,
    [sessionId, productId],
  );
  return r.rows.map((e) => ({
    locationId: e.location_id,
    inventoryStatus: e.inventory_status,
    quantity: e.expected_quantity,
  }));
}

// ---- Review lines ------------------------------------------------------------

const REFUSAL_MESSAGES: Readonly<Record<CountRefusalCode, string>> = {
  count_up_without_valuation_history:
    'The counted quantity is above expected for an item with no stock or valuation history; it cannot post.',
  count_line_unmapped: 'The product is not mapped to an ERP item; it cannot post.',
  count_line_uom_mismatch:
    'The counted unit differs from the product stocking unit; it cannot post.',
};

/** Flags the existing reconciliation and integration data already know for a product of the store. */
async function externalFlags(
  client: PoolClient,
  storeId: string,
  productId: string,
): Promise<Set<CountVarianceFlag>> {
  const flags = new Set<CountVarianceFlag>();
  const recon = await client.query<{ mismatch_class: string }>(
    `SELECT res.mismatch_class
       FROM erpnext_reconciliation_result res
      WHERE res.source_ref_id = $2 AND res.result_state = 'open'
        AND res.run_id = (SELECT r.id FROM erpnext_reconciliation_run r
                           WHERE r.store_id = $1 AND r.kind = 'stock' AND r.status = 'completed'
                           ORDER BY r.finished_at DESC NULLS LAST, r.id DESC LIMIT 1)`,
    [storeId, productId],
  );
  for (const { mismatch_class: c } of recon.rows) {
    if (c === 'quantity_divergence') flags.add('divergence');
    if (c === 'erp_snapshot_stale') flags.add('stale_snapshot');
    if (c === 'expected_pending_erp' || c === 'expected_pending_retail') flags.add('pending');
    if (c === 'unmapped_item') flags.add('unmapped');
    if (c === 'uom_mismatch') flags.add('uom_mismatch');
  }
  const pending = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM stock_movements m
       JOIN inventory_effect_integration ei ON ei.effect_id = m.id
      WHERE m.store_id = $1 AND m.tenant_product_ref = $2
        AND ei.state IN ('not_posted', 'pending', 'rejected', 'reconciliation_required')`,
    [storeId, productId],
  );
  if (Number(pending.rows[0]?.n ?? '0') > 0) flags.add('pending');
  const mapped = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM erpnext_item_map WHERE tenant_product_id = $1 AND state = 'confirmed'`,
    [productId],
  );
  if (Number(mapped.rows[0]?.n ?? '0') === 0) flags.add('unmapped');
  return flags;
}

/** ERP has seen stock for the product at the store: some effect is confirmed or ERP-external. */
async function hasValuationHistory(
  client: PoolClient,
  storeId: string,
  productId: string,
): Promise<boolean> {
  const r = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM stock_movements m
       JOIN inventory_effect_integration ei ON ei.effect_id = m.id
      WHERE m.store_id = $1 AND m.tenant_product_ref = $2 AND ei.state IN ('confirmed', 'external')`,
    [storeId, productId],
  );
  return Number(r.rows[0]?.n ?? '0') > 0;
}

export interface BuiltLine {
  readonly body: VarianceLineBody;
  readonly row: LineRow;
  readonly observed: EffectiveObservation[];
  readonly expected: PositionQuantity[];
}

export async function buildLine(
  client: PoolClient,
  session: SessionRow,
  row: LineRow,
): Promise<BuiltLine> {
  const productId = row.tenant_product_ref;
  const observed = await effectiveObservations(client, session.id, productId, row.reset_after_seq);
  const expected = await expectedPositions(client, session.id, productId);
  const q = lineQuantities(
    row.expected_total ?? '0.0000',
    observed.map((o) => o.quantity),
  );
  const flags = await externalFlags(client, session.store_id, productId);
  const unit = row.stocking_unit ?? observed[0]?.stockingUnit ?? '';
  if (observed.some((o) => o.stockingUnit !== unit)) flags.add('uom_mismatch');
  const ordered = COUNT_VARIANCE_FLAGS.filter((f) => flags.has(f));
  const refusalCode = refusalFor({
    flags: ordered,
    varianceQuantity: q.varianceQuantity,
    hasValuationHistory: await hasValuationHistory(client, session.store_id, productId),
  });
  const acknowledgementRequired = ordered.some(
    (f) => f === 'divergence' || f === 'stale_snapshot' || f === 'pending',
  );
  const acknowledged =
    row.acknowledged_by && row.acknowledged_at && row.acknowledged_version === row.line_version;
  return {
    row,
    observed,
    expected,
    body: {
      productId,
      lineVersion: String(row.line_version),
      stockingUnit: unit,
      expectedQuantity: q.expectedTotal,
      countedQuantity: q.countedTotal,
      varianceQuantity: q.varianceQuantity,
      flags: ordered,
      acknowledgementRequired,
      acknowledgement: acknowledged
        ? {
            acknowledgedBy: row.acknowledged_by!,
            acknowledgedAt: row.acknowledged_at!.toISOString(),
            note: row.acknowledgement_note,
          }
        : null,
      refusal: refusalCode ? { code: refusalCode, message: REFUSAL_MESSAGES[refusalCode] } : null,
      observations: observed.map((o) => ({
        locationId: o.locationId,
        inventoryStatus: o.inventoryStatus,
        countedQuantity: o.quantity,
      })),
    },
  };
}

// ---- Late pre-cut events (G6-4) ----------------------------------------------

export interface ScanOutcome {
  readonly inserted: number;
  /** The session as the scan left it (re-read), or the same row when nothing changed. */
  readonly session: SessionRow;
}

/**
 * Find effects the session's frozen expected quantity cannot contain: received
 * after the cut, but stamped at or before it. A POS effect is stamped by its
 * `occurred_at`; an ERP-origin effect by the ERP stamp Backend-Core recorded
 * (`erp_confirmed_at` = the ledger row's `creation`, 0042 / RT-1288). Each is
 * recorded once per (session, effect). Before approval the affected lines are
 * invalidated (their observations are set aside, the line version moves) and a
 * submitted session returns to `cut_taken`; after approval the session becomes
 * `needs_attention`. Never moves stock.
 */
export async function scanLateEvents(
  client: PoolClient,
  session: SessionRow,
): Promise<ScanOutcome> {
  if (!session.cut_at || !['cut_taken', 'submitted', 'approved'].includes(session.state)) {
    return { inserted: 0, session };
  }
  const found = await client.query<{
    id: string;
    tenant_product_ref: string;
    quantity: string;
    event_type: string | null;
    event_ref_id: string | null;
    source_system: string | null;
    external_id: string | null;
    origin: string;
    stamp: Date;
  }>(
    `SELECT m.id, m.tenant_product_ref, m.quantity::text AS quantity, m.event_type, m.event_ref_id::text AS event_ref_id,
            m.source_system, m.external_id, m.origin,
            CASE WHEN m.origin = 'erp_external' THEN COALESCE(ei.erp_confirmed_at, m.occurred_at) ELSE m.occurred_at END AS stamp
       FROM stock_movements m
       LEFT JOIN inventory_effect_integration ei ON ei.effect_id = m.id
      WHERE m.store_id = $1 AND m.tenant_product_ref = ANY($2::uuid[])
        AND m.received_at > $3::timestamptz AND m.movement_type <> 'count_correction'
        AND (CASE WHEN m.origin = 'erp_external' THEN COALESCE(ei.erp_confirmed_at, m.occurred_at) ELSE m.occurred_at END) <= $3::timestamptz
        AND NOT EXISTS (SELECT 1 FROM count_late_event_findings f WHERE f.session_id = $4 AND f.effect_id = m.id)
      ORDER BY m.received_at, m.id`,
    [session.store_id, session.scope_product_ids, session.cut_at, session.id],
  );
  if (found.rows.length === 0) return { inserted: 0, session };

  const affected = new Set<string>();
  for (const e of found.rows) {
    const a = lateAssessment(e.quantity);
    await client.query(
      `INSERT INTO count_late_event_findings
         (id, tenant_id, store_id, session_id, tenant_product_ref, assessment, quantity, event_type, event_reference,
          source_system, external_id, effect_id, oversell_risk, erp_stamp, detected_in_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7::numeric(19,4), $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (session_id, effect_id) DO NOTHING`,
      [
        newId(),
        session.tenant_id,
        session.store_id,
        session.id,
        e.tenant_product_ref,
        a.assessment,
        a.quantity,
        e.event_type ?? 'unknown',
        e.event_ref_id ?? e.id,
        e.source_system ?? e.origin,
        e.external_id ?? e.id,
        e.id,
        a.oversellRisk,
        e.stamp,
        session.state,
      ],
    );
    affected.add(e.tenant_product_ref);
  }

  if (session.state === 'approved') {
    await client.query(
      `UPDATE count_sessions SET state = 'needs_attention', updated_at = now() WHERE id = $1`,
      [session.id],
    );
  } else {
    // Before approval: set the affected lines' observations aside and return them to review.
    await client.query(
      `UPDATE count_session_lines l
          SET reset_after_seq = COALESCE((SELECT max(o.seq) FROM count_observations o
                                           WHERE o.session_id = l.session_id AND o.tenant_product_ref = l.tenant_product_ref), 0),
              line_version = l.line_version + 1,
              acknowledged_by = NULL, acknowledged_at = NULL, acknowledged_version = NULL, acknowledgement_note = NULL,
              updated_at = now()
        WHERE l.session_id = $1 AND l.tenant_product_ref = ANY($2::uuid[])`,
      [session.id, [...affected]],
    );
    if (session.state === 'submitted') {
      await client.query(
        `UPDATE count_sessions SET state = 'cut_taken', submitted_by = NULL, submitted_at = NULL, updated_at = now() WHERE id = $1`,
        [session.id],
      );
    }
  }
  const reread = await loadSession(client, session.store_id, session.id, false);
  return { inserted: found.rows.length, session: reread ?? session };
}

export function findingBody(r: {
  id: string;
  session_id: string;
  tenant_product_ref: string;
  assessment: 'understated' | 'overstated';
  quantity: string;
  event_type: string;
  event_reference: string;
  source_system: string;
  external_id: string;
  effect_id: string;
  oversell_risk: boolean;
  erp_stamp: Date;
  detected_at: Date;
  detected_in_state: CountSessionState;
}): FindingBody {
  return {
    id: r.id,
    sessionId: r.session_id,
    productId: r.tenant_product_ref,
    assessment: r.assessment,
    quantity: formatQuantity(parseQuantity(r.quantity)),
    linkedEvent: {
      eventType: r.event_type,
      reference: r.event_reference,
      sourceSystem: r.source_system,
      externalId: r.external_id,
      effectId: r.effect_id,
    },
    oversellRisk: r.oversell_risk,
    erpStamp: r.erp_stamp.toISOString(),
    detectedAt: r.detected_at.toISOString(),
    detectedInState: r.detected_in_state,
  };
}

export function scopeConflict(): ConflictException {
  return new ConflictException({
    code: 'count_scope_in_use',
    message: 'A product is already in the scope of another live Count Session of this store.',
  });
}
