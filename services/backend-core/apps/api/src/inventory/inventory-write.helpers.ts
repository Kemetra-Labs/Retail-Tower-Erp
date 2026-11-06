/**
 * Shared write-path primitives of the Inventory domain (RT-1221 PR 2).
 *
 * The manual movement path (InventoryService) and its collaborators
 * StockTransferService, StockCountService and InventoryBackfill run these on
 * the caller's tenant-context client, inside the caller's transaction. They
 * were private methods of InventoryService; their SQL and behaviour are
 * unchanged. CrossUnitError and the unit-guard predicate moved here with them
 * and stay importable from inventory.service.ts.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  emit,
  INVENTORY_STATUSES,
  OUTBOX_EVENT_TYPES,
  type InventoryStatus,
} from '@data-pulse-2/db';
import type { PoolClient } from 'pg';

import { UUID_RE_I } from '../common/ids';
import { recordInventoryNegativeBalance } from '../observability/metrics/api.metrics';
import { parseQuantity } from './decimal-quantity';
import {
  DEFAULT_INVENTORY_STATUS,
  NOT_POSTED,
  type EffectPosition,
  type MovementRow,
} from './inventory.types';

export const AUDIT_TARGET_TYPE_MOVEMENT = 'stock_movement';

/**
 * Raised when a movement's `stockingUnit` ≠ the product's established unit
 * (FR-022). The controller maps it to a 400 ValidationFailure. Carries both
 * units for a non-leaky, actionable message.
 */
export class CrossUnitError extends BadRequestException {
  constructor(
    public readonly expectedUnit: string,
    public readonly suppliedUnit: string,
  ) {
    super(
      `stockingUnit '${suppliedUnit}' does not match the product's stocking unit '${expectedUnit}'`,
    );
  }
}

/** The established-unit EXCLUDE constraint added in migration 0016 (issue #465). */
export const UNIT_GUARD_CONSTRAINT = 'stock_movements_one_unit_per_product';

/** True when `v` is a well-formed UUID string (for the UUID-typed outbox correlation_id). */
function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE_I.test(v);
}

/**
 * True when `err` is the established-unit EXCLUDE violation (migration 0016):
 * SQLSTATE 23P01 on the `stock_movements_one_unit_per_product` constraint.
 * This fires ONLY under true concurrency — two movements that both passed the
 * sequential `assertUnitMatchesEstablished` pre-check (saw no established unit)
 * and both inserted; the DB constraint is the path-independent backstop. The
 * sequential path throws `CrossUnitError` from the pre-check before any INSERT,
 * so this predicate is exercised by a direct unit test, not the Docker harness.
 */
export function isUnitExclusionViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23P01' &&
    (err as { constraint?: unknown }).constraint === UNIT_GUARD_CONSTRAINT
  );
}

/**
 * The addressed store(s) and product must exist in the CURRENT tenant
 * (RT-61). Runs on the tenant-context client, so RLS hides other tenants'
 * rows: an unknown, soft-deleted or cross-tenant reference is a
 * non-disclosing 404 (FR-051). Without it a write reached the
 * `stock_movements` foreign keys — which do not apply RLS — and either
 * failed as a 500 or accepted another tenant's store / product id.
 */
export async function assertReferencesInTenant(
  client: PoolClient,
  refs: { readonly storeIds: readonly string[]; readonly tenantProductRef?: string | null },
): Promise<void> {
  const storeIds = [...new Set(refs.storeIds)];
  const found = await client.query<{ id: string }>(
    `SELECT id FROM stores WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [storeIds],
  );
  if (found.rows.length !== storeIds.length) throw new NotFoundException('Not Found');

  const productRef = refs.tenantProductRef ?? null;
  if (productRef !== null) {
    const product = await client.query<{ id: string }>(
      `SELECT id FROM tenant_products WHERE id = $1`,
      [productRef],
    );
    if (!product.rows[0]) throw new NotFoundException('Not Found');
  }
}

/**
 * RT-432 (RT-290 G4-6): the position a write lands at. Without an explicit
 * location the store's `primary` location; without an explicit status
 * `sellable`. Runs on the tenant-context client, so RLS hides other tenants'
 * locations: an explicit location that is not one of THIS store's locations
 * in this tenant is a non-disclosing 404 (FR-051), and an inactive one is a
 * 400. The composite FK (stock_location_id, store_id, tenant_id) is the
 * database backstop for both. A store with no visible primary location is
 * not a store of this tenant (0044 gives every store one): 404.
 */
export async function resolvePosition(
  client: PoolClient,
  storeId: string,
  explicit: {
    readonly stockLocationId?: string | null;
    readonly inventoryStatus?: InventoryStatus | null;
  } = {},
): Promise<EffectPosition> {
  const inventoryStatus = explicit.inventoryStatus ?? DEFAULT_INVENTORY_STATUS;
  if (!INVENTORY_STATUSES.includes(inventoryStatus)) {
    throw new BadRequestException(
      `inventoryStatus must be one of ${INVENTORY_STATUSES.join(', ')}`,
    );
  }
  const location = explicit.stockLocationId
    ? await client.query<{ id: string; is_active: boolean }>(
        `SELECT id, is_active FROM stock_locations WHERE id = $1 AND store_id = $2`,
        [explicit.stockLocationId, storeId],
      )
    : await client.query<{ id: string; is_active: boolean }>(
        `SELECT id, is_active FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`,
        [storeId],
      );
  const row = location.rows[0];
  if (!row) throw new NotFoundException('Not Found');
  if (!row.is_active) {
    throw new BadRequestException('stockLocationId names an inactive stock location');
  }
  return { stockLocationId: row.id, inventoryStatus };
}

/**
 * Throw `CrossUnitError` if the product already has movements at the store in
 * a stocking unit different from `suppliedUnit` (FR-022). Runs on the same
 * RLS-active client as the insert.
 *
 * Concurrency caveat (v1, best-effort at the app layer): this is a
 * read-before-insert under READ COMMITTED, so two concurrent FIRST movements
 * for the same `(store, product)` in different units could both see "no
 * established unit" and both commit, leaving divergent units. For manual entry
 * this is rare. A hard guarantee belongs at the data layer (a UNIQUE
 * `(store_id, tenant_product_ref, stocking_unit)`-style trigger/constraint, or
 * a per-key advisory lock) — that touches `packages/db/**` (a [GATED] path
 * outside this slice's allowed_files), so it is a documented follow-up, not
 * silently reached into here.
 */
export async function assertUnitMatchesEstablished(
  client: PoolClient,
  storeId: string,
  tenantProductRef: string,
  suppliedUnit: string,
): Promise<void> {
  const r = await client.query<{ stocking_unit: string }>(
    `SELECT stocking_unit FROM stock_movements
      WHERE store_id = $1 AND tenant_product_ref = $2
      ORDER BY received_at ASC, id ASC
      LIMIT 1`,
    [storeId, tenantProductRef],
  );
  const established = r.rows[0]?.stocking_unit;
  if (established !== undefined && established !== suppliedUnit) {
    throw new CrossUnitError(established, suppliedUnit);
  }
}

/**
 * RT-425 (RT-289 G2-3, Q2): give each just-written Retail effect its
 * integration record in state `not_posted`, in the SAME transaction as the
 * effect INSERT. No ERP posting intent represents a manual movement,
 * transfer or count, so the divergence stays explicit (decision 730).
 */
export async function recordNotPosted(
  client: PoolClient,
  tenantId: string,
  effectIds: readonly string[],
): Promise<void> {
  await client.query(
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state)
     SELECT effect_id, $1, $3 FROM unnest($2::uuid[]) AS effect_id`,
    [tenantId, effectIds, NOT_POSTED],
  );
}

/**
 * Run a stock_movements INSERT and translate the established-unit EXCLUDE
 * violation (migration 0016) into the same `CrossUnitError` (400) the
 * sequential pre-check throws — so the rare concurrent-race path returns a
 * clean 400, not a raw 500. `assertUnitMatchesEstablished` remains the
 * friendly common-path 400; this is the backstop for the true-concurrency
 * window the pre-check can't close under READ COMMITTED. On the violation we
 * re-query the now-established unit (one extra SELECT, only when the race
 * actually fired) so the error carries the same (expected, supplied) shape.
 */
export async function insertMovementRow(
  client: PoolClient,
  sql: string,
  params: readonly unknown[],
  context: {
    readonly storeId: string;
    readonly tenantProductRef: string | null;
    readonly suppliedUnit: string;
  },
): Promise<{ rows: MovementRow[] }> {
  try {
    return await client.query<MovementRow>(sql, params as unknown[]);
  } catch (err: unknown) {
    if (isUnitExclusionViolation(err) && context.tenantProductRef !== null) {
      const established = await client.query<{ stocking_unit: string }>(
        `SELECT stocking_unit FROM stock_movements
          WHERE store_id = $1 AND tenant_product_ref = $2
          ORDER BY received_at ASC, id ASC
          LIMIT 1`,
        [context.storeId, context.tenantProductRef],
      );
      throw new CrossUnitError(
        established.rows[0]?.stocking_unit ?? context.suppliedUnit,
        context.suppliedUnit,
      );
    }
    throw err;
  }
}

/**
 * Emit the negative-balance SIGNAL (009-SIGNAL-NEGBAL / FR-024) if the
 * post-write derived on-hand for a (store, product) is below zero. Called
 * after an outbound write (manual outbound / transfer_out / sale-linked
 * backfill) on the SAME RLS-active client, INSIDE the write transaction so the
 * SUM includes the just-appended row.
 *
 * Allow-and-flag: this is a signal, never an error. It NEVER throws — a metric
 * failure must not roll back or block a legitimate movement. A null
 * `tenantProductRef` (ad-hoc) has no product on-hand to flag, so it is skipped.
 */
export async function flagIfNegativeOnHand(
  client: PoolClient,
  storeId: string,
  tenantProductRef: string | null,
): Promise<void> {
  if (tenantProductRef === null) return;
  try {
    const r = await client.query<{ quantity: string }>(
      `SELECT COALESCE(SUM(quantity), 0)::numeric(19,4)::text AS quantity
         FROM stock_movements
        WHERE store_id = $1 AND tenant_product_ref = $2`,
      [storeId, tenantProductRef],
    );
    if (parseQuantity(r.rows[0]?.quantity ?? '0') < 0n) {
      recordInventoryNegativeBalance();
    }
  } catch {
    // Signal-only: never let a metric/probe failure affect the write (FR-024).
  }
}

/**
 * Emit the `inventory.movement.created` outbox event (009 / issue #465 part B)
 * on the CALLER's client, IN-TRANSACTION with the movement append + its audit
 * row — so the event is committed iff the movement is (atomic; a rollback
 * drops both). Call this at exactly the same site + under the same guard as
 * the audit INSERT (the genuine-append branch only — never the backfill dedup
 * early-return, or a redelivered backfill would double-emit and break FR-033).
 * Payload carries IDs + provenance ONLY — no money, no PII (§XIV), mirroring
 * the audit metadata. `movementIds` is an array so the transfer path (two
 * linked legs, one logical operation) names both legs.
 */
export async function emitMovementCreated(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly movementIds: readonly string[];
    readonly movementType: string;
    readonly tenantProductRef?: string | null;
    readonly correlationId?: string | null;
    readonly provenance?: Record<string, unknown>;
  },
): Promise<void> {
  await emit(client, {
    eventType: OUTBOX_EVENT_TYPES.INVENTORY_MOVEMENT_CREATED,
    tenantId: input.tenantId,
    storeId: input.storeId,
    payload: {
      movementIds: input.movementIds,
      movementType: input.movementType,
      tenantProductRef: input.tenantProductRef ?? null,
      ...input.provenance,
    },
    // outbox_events.correlation_id is UUID — only forward a well-formed UUID;
    // a non-UUID upstream tag (or the audit-style text correlation) must NOT
    // fail the movement write. The full value, if any, is on the audit row.
    correlationId: isUuid(input.correlationId) ? input.correlationId : null,
  });
}
