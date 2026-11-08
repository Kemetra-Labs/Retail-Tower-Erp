/**
 * SafetyHistoryService — Jira RT-1081 (RT-455 TR-3a / TR-3b / II-3 / II-4;
 * owner decisions OD-0..OD-8, RT-455 comment 15233). Contract:
 * `inventory/inventory.yaml` 1.10.0-draft.
 *
 *   - listHolds: the tenant's holds, active or released, newest first
 *     (`placed_at DESC, id DESC`), filtered by status, kind, identity and
 *     product. Holds are tenant-level (RT-449 H2): not store-scoped.
 *   - listRecalls: the tenant's recalls as summaries with their hold counts,
 *     newest first (`created_at DESC, id DESC`; `effective_at` may be
 *     backdated, so it is not the order key).
 *   - listExpiryCorrections: one identity's expiry history, newest first. An
 *     identity outside the tenant is a non-disclosing 404.
 *
 * Read-only, under the tenant's RLS context. Keyset pages as
 * `listStockMovements` (RT-731): the cursor is decoded and checked against the
 * operation, the tenant and the normalized filters before any read (400 on a
 * foreign token), and its position is ANDed with them. A filter id of another
 * tenant matches nothing (RLS) and answers an empty page.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, type TrackingHoldKind } from '@data-pulse-2/db';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../../auth/auth.module';
import { HOLD_COLUMNS, toHoldBody, type HoldRow, type TrackingHoldBody } from './safety.common';
import {
  decodeSafetyHistoryCursorOrReject,
  encodeSafetyHistoryCursor,
  instantKeySql,
  type SafetyHistoryCursorBinding,
} from './safety-history.cursor';
import {
  CORRECTION_COLUMNS,
  toCorrectionBody,
  type CorrectionRow,
  type ExpiryCorrectionBody,
} from './identity-expiry.service';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export type HoldStatusFilter = 'active' | 'released' | 'all';

export interface ListHoldsInput {
  readonly tenantId: string;
  readonly status?: HoldStatusFilter | undefined;
  readonly kind?: TrackingHoldKind | undefined;
  readonly trackingIdentityId?: string | undefined;
  readonly productId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListRecallsInput {
  readonly tenantId: string;
  readonly productId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListExpiryCorrectionsInput {
  readonly tenantId: string;
  readonly trackingIdentityId: string;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** Contract `TrackingHoldList`. */
export interface TrackingHoldListBody {
  readonly items: TrackingHoldBody[];
  readonly nextCursor: string | null;
}

/** Contract `InventoryRecallSummary`. */
export interface InventoryRecallSummaryBody {
  readonly id: string;
  readonly tenantProductRef: string;
  readonly reasonCode: string;
  readonly reference: string;
  readonly note: string | null;
  readonly effectiveAt: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly holdCount: number;
  readonly activeHoldCount: number;
}

/** Contract `InventoryRecallSummaryList`. */
export interface InventoryRecallSummaryListBody {
  readonly items: InventoryRecallSummaryBody[];
  readonly nextCursor: string | null;
}

/** Contract `TrackingIdentityExpiryCorrectionList`. */
export interface ExpiryCorrectionListBody {
  readonly items: ExpiryCorrectionBody[];
  readonly nextCursor: string | null;
}

interface Keyed {
  readonly id: string;
  readonly at_key: string;
}

interface RecallSummaryRow extends Keyed {
  readonly tenant_product_ref: string;
  readonly reason_code: string;
  readonly reference: string;
  readonly note: string | null;
  readonly effective_at: Date;
  readonly created_by: string;
  readonly created_at: Date;
  readonly hold_count: number;
  readonly active_hold_count: number;
}

/** `status` filter → the `released_at` predicate (no user input reaches the SQL text). */
const HOLD_STATUS_PREDICATES: Record<HoldStatusFilter, string> = {
  active: 'h.released_at IS NULL',
  released: 'h.released_at IS NOT NULL',
  all: 'TRUE',
};

@Injectable()
export class SafetyHistoryService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  listHolds(input: ListHoldsInput): Promise<TrackingHoldListBody> {
    const status = input.status ?? 'all';
    const binding = bind('tracking_holds', input.tenantId, [
      status,
      input.kind ?? null,
      input.trackingIdentityId ?? null,
      input.productId ?? null,
    ]);
    const after = decodeSafetyHistoryCursorOrReject(binding, input.cursor);
    const limit = clampLimit(input.limit);
    return this.read(input.tenantId, async (client) => {
      const r = await client.query<HoldRow & Keyed>(
        `SELECT ${prefixed(HOLD_COLUMNS, 'h')}, ${instantKeySql('h.placed_at')} AS at_key
           FROM tracking_holds h
          WHERE h.tenant_id = $1 AND ${HOLD_STATUS_PREDICATES[status]}
            AND ($2::text IS NULL OR h.kind = $2)
            AND ($3::uuid IS NULL OR h.tracking_identity_id = $3)
            AND ($4::uuid IS NULL OR h.tenant_product_ref = $4)
            AND ($5::timestamptz IS NULL OR (h.placed_at, h.id) < ($5::timestamptz, $6::uuid))
          ORDER BY h.placed_at DESC, h.id DESC
          LIMIT $7`,
        [
          input.tenantId,
          input.kind ?? null,
          input.trackingIdentityId ?? null,
          input.productId ?? null,
          after?.atKey ?? null,
          after?.id ?? null,
          limit + 1,
        ],
      );
      return page(r.rows, limit, binding, toHoldBody);
    });
  }

  listRecalls(input: ListRecallsInput): Promise<InventoryRecallSummaryListBody> {
    const binding = bind('inventory_recalls', input.tenantId, [input.productId ?? null]);
    const after = decodeSafetyHistoryCursorOrReject(binding, input.cursor);
    const limit = clampLimit(input.limit);
    return this.read(input.tenantId, async (client) => {
      const r = await client.query<RecallSummaryRow>(
        `SELECT r.id, r.tenant_product_ref, r.reason_code, r.reference, r.note, r.effective_at,
                r.created_by, r.created_at, ${instantKeySql('r.created_at')} AS at_key,
                (SELECT count(*)::int FROM tracking_holds h
                  WHERE h.tenant_id = r.tenant_id AND h.recall_id = r.id) AS hold_count,
                (SELECT count(*)::int FROM tracking_holds h
                  WHERE h.tenant_id = r.tenant_id AND h.recall_id = r.id
                    AND h.released_at IS NULL) AS active_hold_count
           FROM inventory_recalls r
          WHERE r.tenant_id = $1
            AND ($2::uuid IS NULL OR r.tenant_product_ref = $2)
            AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $5`,
        [input.tenantId, input.productId ?? null, after?.atKey ?? null, after?.id ?? null, limit + 1],
      );
      return page(r.rows, limit, binding, toRecallSummary);
    });
  }

  listExpiryCorrections(input: ListExpiryCorrectionsInput): Promise<ExpiryCorrectionListBody> {
    const binding = bind('expiry_corrections', input.tenantId, [input.trackingIdentityId]);
    const after = decodeSafetyHistoryCursorOrReject(binding, input.cursor);
    const limit = clampLimit(input.limit);
    return this.read(input.tenantId, async (client) => {
      const identity = await client.query(
        `SELECT 1 FROM tracking_identities WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, input.trackingIdentityId],
      );
      if (identity.rowCount === 0) throw new NotFoundException('Not Found');
      const r = await client.query<CorrectionRow & Keyed>(
        `SELECT ${CORRECTION_COLUMNS}, ${instantKeySql('created_at')} AS at_key
           FROM tracking_identity_expiry_corrections
          WHERE tenant_id = $1 AND tracking_identity_id = $2
            AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $5`,
        [input.tenantId, input.trackingIdentityId, after?.atKey ?? null, after?.id ?? null, limit + 1],
      );
      return page(r.rows, limit, binding, toCorrectionBody);
    });
  }

  private read<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, fn);
  }
}

function bind(
  op: SafetyHistoryCursorBinding['op'],
  tenantId: string,
  filters: ReadonlyArray<string | null>,
): SafetyHistoryCursorBinding {
  return { op, tenantId, filters };
}


function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

/** One page of `limit` rows; the extra row fetched tells whether another page exists. */
function page<R extends Keyed, B>(
  rows: readonly R[],
  limit: number,
  binding: SafetyHistoryCursorBinding,
  toBody: (row: R) => B,
): { items: B[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: items.map(toBody),
    nextCursor:
      rows.length > limit && last ? encodeSafetyHistoryCursor(binding, { atKey: last.at_key, id: last.id }) : null,
  };
}

/** `HOLD_COLUMNS` qualified with a table alias. */
function prefixed(columns: string, alias: string): string {
  return columns
    .split(',')
    .map((c) => `${alias}.${c.trim()}`)
    .join(', ');
}

function toRecallSummary(row: RecallSummaryRow): InventoryRecallSummaryBody {
  return {
    id: row.id,
    tenantProductRef: row.tenant_product_ref,
    reasonCode: row.reason_code,
    reference: row.reference,
    note: row.note,
    effectiveAt: row.effective_at.toISOString(),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    holdCount: row.hold_count,
    activeHoldCount: row.active_hold_count,
  };
}
