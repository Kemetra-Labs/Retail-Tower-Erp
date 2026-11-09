/**
 * Void and refund terminal-event provenance (RT-1295: moved unchanged from
 * `sales.service.ts`, which uses them in `recordVoid` / `recordRefund`).
 *
 * A terminal event is deduplicated on (tenant, source_system, external_id).
 * That key is NOT scoped by sale, so a recorded provenance replays only when
 * it points at the SAME sale (FR-013); otherwise it is a provenance conflict
 * that never discloses the other sale. Every query runs on the caller's
 * tenant-context transaction client (RLS).
 */
import type { PoolClient } from "pg";

import type { RecordRefundRequestDto } from "./dto/record-refund-request.dto";
import type { RecordVoidRequestDto } from "./dto/record-void-request.dto";
import { TerminalEventProvenanceConflictError } from "./sale-errors";
import { VoidApprovalInvalidError } from "./void-approval";

export interface TerminalEventProjection {
  readonly eventRef: string;
  readonly saleRef: string;
  readonly kind: "void" | "refund";
  readonly recordedAt: string;
  /** Present (non-null) only for refunds. */
  readonly posRefundAmount: string | null;
  /** Present (non-null) only for refunds. */
  readonly currencyCode: string | null;
}

export interface TerminalEventResult {
  readonly projection: TerminalEventProjection;
  /** false when a re-delivery resolved to an existing terminal event. */
  readonly created: boolean;
  /**
   * RT-530: the approval a void was recorded under, for its `sale.voided` audit
   * (ids and a policy label only; never a PIN or a payload). Absent for a
   * refund and for a pre-RT-530 void.
   */
  readonly audit?: VoidAuditMetadata;
}

/** The approver and approval of a void, as the audit event carries them. */
export interface VoidAuditMetadata {
  readonly approver_user_id: string;
  readonly requester_user_id: string;
  readonly approval_id: string;
  readonly policy_version: string;
}

/**
 * A refund provenance already recorded: a deterministic replay only if it
 * points at the SAME sale (FR-013); otherwise a conflict (never echo the
 * caller's ref). Null when the provenance is unused.
 */
export async function replayRefundByProvenance(
  client: PoolClient,
  tenantId: string,
  body: RecordRefundRequestDto,
  saleRef: string,
): Promise<TerminalEventResult | null> {
  const existing = await client.query<{
    id: string;
    sale_id: string;
    refunded_at: Date;
    pos_refund_amount: string;
    currency_code: string;
  }>(
    `SELECT id, sale_id, refunded_at, pos_refund_amount, currency_code
       FROM sale_refunds
      WHERE tenant_id = $1 AND source_system = $2 AND external_id = $3
      LIMIT 1`,
    [tenantId, body.sourceSystem, body.externalId],
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (row.sale_id !== saleRef) {
    throw new TerminalEventProvenanceConflictError();
  }
  return {
    projection: toTerminalEvent("refund", row.id, row.sale_id, row.refunded_at, row.pos_refund_amount, row.currency_code),
    created: false,
  };
}

interface VoidProvenanceRow {
  id: string;
  sale_id: string;
  /** RT-577: the void a credit reversal created (never replayed by recordVoid). */
  credit_linked: boolean;
  voided_at: Date;
  approval_id: string | null;
  approved_by_user_id: string | null;
  requested_by_user_id: string | null;
  approval_policy_version: string | null;
}

/**
 * RT-530: an approval id reused for another void (the single-use index) -> 422.
 * RT-577: also one a credit return consumed (the shared ledger, filled for a
 * void by the 0054 sale_voids trigger).
 */
export function mapApprovalReuseViolation(err: unknown): unknown {
  const pg = err as { code?: string; constraint?: string };
  if (
    pg.code === "23505" &&
    (pg.constraint === "uq_sale_voids_tenant_approval" || pg.constraint === "sale_approval_uses_pkey")
  ) {
    return new VoidApprovalInvalidError();
  }
  return err;
}

export async function findVoidByProvenance(
  client: PoolClient,
  tenantId: string,
  body: RecordVoidRequestDto,
): Promise<VoidProvenanceRow | null> {
  const r = await client.query<VoidProvenanceRow>(
    `SELECT v.id, v.sale_id, v.voided_at, v.approval_id::text AS approval_id,
            v.approved_by_user_id::text AS approved_by_user_id,
            v.requested_by_user_id::text AS requested_by_user_id,
            v.approval_policy_version,
            EXISTS (SELECT 1 FROM sale_credit_reversals c WHERE c.void_id = v.id) AS credit_linked
       FROM sale_voids v
      WHERE v.tenant_id = $1 AND v.source_system = $2 AND v.external_id = $3
      LIMIT 1`,
    [tenantId, body.sourceSystem, body.externalId],
  );
  return r.rows[0] ?? null;
}

/**
 * A void provenance is a deterministic REPLAY only if it points at the SAME
 * sale (FR-013). The unique index is (tenant, source_system, external_id) —
 * NOT scoped by sale — so the existing row may belong to a different sale;
 * that is a conflict and never discloses the other sale.
 */
export function replayVoid(row: VoidProvenanceRow, saleRef: string): TerminalEventResult {
  if (row.sale_id !== saleRef) {
    throw new TerminalEventProvenanceConflictError();
  }
  const audit = voidAuditOf(row);
  return {
    projection: toTerminalEvent("void", row.id, row.sale_id, row.voided_at, null, null),
    created: false,
    ...(audit === undefined ? {} : { audit }),
  };
}

/** The approval a stored void carries, or undefined for a pre-RT-530 void. */
function voidAuditOf(row: VoidProvenanceRow): VoidAuditMetadata | undefined {
  if (
    row.approval_id === null ||
    row.approved_by_user_id === null ||
    row.requested_by_user_id === null ||
    row.approval_policy_version === null
  ) {
    return undefined;
  }
  return {
    approver_user_id: row.approved_by_user_id,
    requester_user_id: row.requested_by_user_id,
    approval_id: row.approval_id,
    policy_version: row.approval_policy_version,
  };
}

export function toTerminalEvent(
  kind: "void" | "refund",
  eventRef: string,
  saleRef: string,
  recordedAt: Date,
  posRefundAmount: string | null,
  currencyCode: string | null,
): TerminalEventProjection {
  return {
    eventRef,
    saleRef,
    kind,
    recordedAt: recordedAt.toISOString(),
    posRefundAmount,
    currencyCode,
  };
}
