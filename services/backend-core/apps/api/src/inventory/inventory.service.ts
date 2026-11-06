/**
 * InventoryService — 009-US1-ONHAND (T033).
 *
 * The first runtime surface of the Inventory domain: the two READ operations.
 *   - getOnHand          — the derived (compute-on-read) signed SUM of a
 *                          (tenant, store, product)'s movements (FR-003). NO
 *                          materialized balance (R1/plan §10).
 *   - listStockMovements — a store's movements, newest first in keyset pages
 *                          (FR-004, RT-731).
 *
 * Tenant isolation: every query runs inside `runWithTenantContext` (sets
 * `app.current_tenant` in a transaction so RLS is active and fail-closed) —
 * the same primitive 005 reconciliation reuses. NO manual `SET LOCAL`, no new
 * primitive. Store scope is the `WHERE store_id = $1` clause + object-level
 * authz at the controller (0014 has tenant RLS only, no store policy).
 *
 * Compute-on-read SUM: `COALESCE(SUM(quantity), 0)` — over zero rows SUM is
 * NULL, so COALESCE makes an empty key a deterministic "0" (FR-005). The SUM is
 * done in SQL (numeric precision; never fetch-and-sum in JS). On-hand MAY be
 * negative (allow-and-flag, FR-024) — `negativeBalance` flags it.
 *
 * Projection: explicit columns only — the lineage `idempotency_key` and the
 * `source_system`/`external_id` dedup pair are NOT in the contract's
 * `StockMovement` projection and are never returned (§IV).
 *
 * Write path (009-US2-MANUAL, T044):
 *   - createStockMovement — append a manual inbound / outbound / adjustment
 *     (write-off = reason-coded outbound, FR-002). Append-only (FR-001): one
 *     INSERT, never an UPDATE/DELETE. Tenant / store / actor are resolved
 *     server-side from the principal + path — NEVER the body (FR-052/§XII; the
 *     controller's strict Zod DTO rejects any such body key). The movement's
 *     `stockingUnit` MUST match the product's ESTABLISHED unit — the unit its
 *     existing movements were recorded in (there is no catalog stocking-unit
 *     column; the first movement establishes it). A mismatch is a typed
 *     `CrossUnitError` → 400 (FR-022). `adjustment` requires a `reason`. Each
 *     successful create writes ONE audit event in the SAME transaction (audit
 *     and state cannot diverge — the 005 catalog write idiom). On-hand MAY go
 *     negative (allow-and-flag, FR-024) — never rejected here.
 *
 * Outbox: the create path emits audit-in-transaction ONLY (mirroring the
 * shipped 005 catalog write). An async outbox event for inventory movements is
 * a DEFERRED, [GATED] follow-up — it needs a new `INVENTORY_MOVEMENT_*` type
 * registered in `OUTBOX_EVENT_TYPES` (packages/db/**, a forbidden path outside
 * this slice's allowed_files; same pattern as the 008 `sale.captured` deferral).
 *
 * Transfer / count / backfill writes are authored in 009-US5/US6/US4. Since
 * RT-1221 PR 2 they live in StockTransferService, StockCountService and
 * InventoryBackfill; this service delegates its public methods to them, and
 * the shared write primitives are in inventory-write.helpers.ts.
 *
 * Position (RT-432; RT-290 G4-1…G4-6): every movement a write path appends
 * lands at an explicit (stock location, inventory status) of its own store —
 * the store's `primary` location and `sellable` unless a manual movement names
 * another location / status. Movements recorded before 0044 have no position
 * and are READ as (the store's primary location, sellable) with
 * `positionInterpreted: true`; they are never updated (G4-5). On-hand stays the
 * total over every location and status (973) and adds a per-status breakdown.
 */
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext, INVENTORY_STATUSES } from '@data-pulse-2/db';
import { newId } from '@data-pulse-2/shared';
import type { Pool } from 'pg';

import { PG_POOL } from '../auth/auth.module';
import { formatQuantity, parseQuantity } from './decimal-quantity';
import {
  MOVEMENT_OCCURRED_AT_KEY_SQL,
  StockMovementCursorError,
  decodeStockMovementCursor,
  encodeStockMovementCursor,
  type StockMovementCursorBinding,
  type StockMovementKeyset,
  type StockMovementScope,
} from './movement-list.cursor';
import {
  encodeTrackingIdentityCursor,
  type TrackingIdentityCursor,
} from './tracking-identity.cursor';

import { asNotPosted, toMovementBody, toTrackingIdentityBody } from './inventory.mappers';
import {
  DEFAULT_INVENTORY_STATUS,
  MANUAL_MOVEMENT_TYPES,
  MOVEMENT_COLUMNS,
  MOVEMENT_COLUMNS_WITH_INTEGRATION,
  MOVEMENT_POSITION_JOIN,
  MOVEMENT_SCOPE_PREDICATES,
  type BackfillRestockInboundInput,
  type CreateStockMovementInput,
  type CreateStockTransferInput,
  type MovementRow,
  type OnHandBody,
  type RecordStockCountInput,
  type StockCountResultBody,
  type StockLocationListBody,
  type StockMovementBody,
  type StockMovementListBody,
  type StockTransferBody,
  type TrackingIdentityRow,
  type TrackingIdentityListBody,
} from './inventory.types';
import {
  AUDIT_TARGET_TYPE_MOVEMENT,
  assertReferencesInTenant,
  assertUnitMatchesEstablished,
  emitMovementCreated,
  flagIfNegativeOnHand,
  insertMovementRow,
  recordNotPosted,
  resolvePosition,
} from './inventory-write.helpers';
import { InventoryBackfill } from './inventory-backfill';
import { StockCountService } from './stock-count.service';
import { StockTransferService } from './stock-transfer.service';

// RT-1221 PR 1: the declarations below moved to inventory.types.ts /
// inventory.mappers.ts; the names that were public here stay importable from
// this module.
export { toMovementBody, toTrackingIdentityBody } from './inventory.mappers';
export { MOVEMENT_COLUMNS } from './inventory.types';
export type {
  BackfillRestockInboundInput,
  CreateStockMovementInput,
  CreateStockTransferInput,
  MovementRow,
  OnHandBody,
  RecordStockCountInput,
  StockCountResultBody,
  StockLocationListBody,
  StockMovementBody,
  StockMovementListBody,
  StockTransferBody,
  TrackingIdentityBody,
  TrackingIdentityListBody,
} from './inventory.types';
// RT-1221 PR 2: the unit guard moved to inventory-write.helpers.ts with the
// write primitives; these names stay importable from this module.
export {
  CrossUnitError,
  UNIT_GUARD_CONSTRAINT,
  isUnitExclusionViolation,
} from './inventory-write.helpers';

const AUDIT_ACTION_MOVEMENT_CREATE = 'inventory.movement.create';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;


@Injectable()
export class InventoryService {
  private readonly transfers: StockTransferService;
  private readonly counts: StockCountService;
  private readonly backfill: InventoryBackfill;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    this.transfers = new StockTransferService(pool);
    this.counts = new StockCountService(pool);
    this.backfill = new InventoryBackfill(pool);
  }

  /**
   * Derived on-hand for a (tenant, store, product): COALESCE(SUM(quantity), 0).
   * Empty key ⇒ "0" (FR-005). Negative ⇒ negativeBalance=true (FR-024).
   */
  getOnHand(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly productId: string;
  }): Promise<OnHandBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<OnHandBody> => {
        await assertReferencesInTenant(client, { storeIds: [input.storeId] });
        // Store scope is the WHERE clause + object-level authz at the
        // controller; 0014 has tenant RLS only (no store policy), so no
        // app.current_store GUC is needed.
        // RT-432: ONE statement, so the total and its per-status split come from
        // the same snapshot (two statements under READ COMMITTED could see
        // different commits and break "the entries sum to quantity"). SUM in
        // SQL at the column's numeric(19,4) scale (uniform "7.0000" wire
        // format); the total is the exact BigInt sum of the group rows. A
        // movement recorded before 0044 has no status and counts as sellable
        // (G4-5). stocking_unit is consistent per product (FR-022, 0016); NULL
        // when there are no movements.
        const byStatus = await client.query<{
          inventory_status: string;
          quantity: string;
          stocking_unit: string;
        }>(
          `SELECT COALESCE(inventory_status, '${DEFAULT_INVENTORY_STATUS}') AS inventory_status,
                  SUM(quantity)::numeric(19,4)::text AS quantity,
                  MIN(stocking_unit) AS stocking_unit
             FROM stock_movements
            WHERE store_id = $1 AND tenant_product_ref = $2
            GROUP BY 1`,
          [input.storeId, input.productId],
        );
        const quantity = formatQuantity(
          byStatus.rows.reduce((sum, row) => sum + parseQuantity(row.quantity), 0n),
        );
        const statusQuantities = INVENTORY_STATUSES.map((status) => ({
          inventoryStatus: status,
          quantity:
            byStatus.rows.find((row) => row.inventory_status === status)?.quantity ?? '0.0000',
        }));
        return {
          storeId: input.storeId,
          productId: input.productId,
          quantity,
          stockingUnit: byStatus.rows[0]?.stocking_unit ?? null,
          negativeBalance: parseQuantity(quantity) < 0n,
          sellableQuantity:
            statusQuantities.find((q) => q.inventoryStatus === DEFAULT_INVENTORY_STATUS)
              ?.quantity ?? '0.0000',
          statusQuantities,
        };
      },
    );
  }

  /**
   * List movements for a (tenant, store) newest first (occurred_at DESC, id
   * DESC) in keyset pages (RT-731). `productId` set ⇒ that product; omitted ⇒
   * `scope` decides: `adhoc` (the default) lists the ad-hoc (NULL-product)
   * movements, which roll up to no product on-hand (SC-001 / data-model
   * Entity 2), and `all` lists every movement of the store. `cursor` is the
   * opaque `nextCursor` of the previous page; one not issued for this tenant,
   * store and filters is a 400, refused before any read.
   */
  async listStockMovements(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly productId?: string | null | undefined;
    readonly scope?: StockMovementScope | undefined;
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
  }): Promise<StockMovementListBody> {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const productId = input.productId ?? null;
    const binding: StockMovementCursorBinding = {
      tenantId: input.tenantId,
      storeId: input.storeId,
      productId,
      scope: productId === null ? (input.scope ?? 'adhoc') : null,
    };
    let after: StockMovementKeyset | null = null;
    if (input.cursor !== undefined) {
      try {
        after = decodeStockMovementCursor(binding, input.cursor);
      } catch (err: unknown) {
        if (err instanceof StockMovementCursorError) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
    }
    return await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockMovementListBody> => {
        await assertReferencesInTenant(client, { storeIds: [input.storeId] });
        // productId → that product; else scope: adhoc → NULL product, all → any.
        const productPredicate =
          binding.scope === null
            ? 'm.tenant_product_ref = $2::uuid'
            : MOVEMENT_SCOPE_PREDICATES[binding.scope];
        // RT-425: each effect carries its integration state (LEFT JOIN: an
        // effect without an integration record projects null). One extra row
        // tells whether another page exists.
        const r = await client.query<MovementRow & { occurred_at_key: string }>(
          `SELECT ${MOVEMENT_COLUMNS_WITH_INTEGRATION},
                  ${MOVEMENT_OCCURRED_AT_KEY_SQL} AS occurred_at_key
             FROM stock_movements m
             LEFT JOIN inventory_effect_integration i ON i.effect_id = m.id
             ${MOVEMENT_POSITION_JOIN}
            WHERE m.store_id = $1 AND ${productPredicate}
              AND ($3::timestamptz IS NULL OR (m.occurred_at, m.id) < ($3::timestamptz, $4::uuid))
            ORDER BY m.occurred_at DESC, m.id DESC
            LIMIT $5`,
          [input.storeId, productId, after?.occurredAtKey ?? null, after?.id ?? null, limit + 1],
        );
        const page = r.rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(toMovementBody),
          nextCursor:
            r.rows.length > limit && last
              ? encodeStockMovementCursor(binding, {
                  occurredAtKey: last.occurred_at_key,
                  id: last.id,
                })
              : null,
        };
      },
    );
  }

  /**
   * RT-432 (RT-290 G4-1): the stock locations of a (tenant, store), primary
   * first, then by code. Read-only; locations are created with their store.
   */
  listStockLocations(input: {
    readonly tenantId: string;
    readonly storeId: string;
  }): Promise<StockLocationListBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockLocationListBody> => {
        await assertReferencesInTenant(client, { storeIds: [input.storeId] });
        const r = await client.query<{
          id: string;
          store_id: string;
          code: string;
          name: string;
          kind: string;
          is_active: boolean;
        }>(
          `SELECT id, store_id, code, name, kind, is_active
             FROM stock_locations
            WHERE store_id = $1
            ORDER BY (kind = 'primary') DESC, code ASC, id ASC`,
          [input.storeId],
        );
        return {
          items: r.rows.map((l) => ({
            id: l.id,
            storeId: l.store_id,
            code: l.code,
            name: l.name,
            kind: l.kind,
            isActive: l.is_active,
          })),
        };
      },
    );
  }

  /**
   * RT-448 (RT-50 G7-2): the tenant's tracking identities of one product,
   * ordered by kind, then expiry (earliest first, none last), then code, in
   * keyset pages of at most MAX_LIMIT (a serial product has one identity per
   * unit). Read-only; identities are ERP-born (G7-3) and nothing creates one yet
   * (RT-453). A product outside the tenant is a non-disclosing 404 (FR-051):
   * RLS hides other tenants' products and identities alike.
   */
  async listTrackingIdentities(input: {
    readonly tenantId: string;
    readonly productId: string;
    readonly limit?: number | undefined;
    readonly cursor?: TrackingIdentityCursor | undefined;
  }): Promise<TrackingIdentityListBody> {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    return await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<TrackingIdentityListBody> => {
        const product = await client.query<{ id: string }>(
          `SELECT id FROM tenant_products WHERE id = $1`,
          [input.productId],
        );
        if (!product.rows[0]) throw new NotFoundException('Not Found');
        const after = input.cursor;
        // Keyset page over (kind, expiry NULLS LAST, code, id); a missing
        // expiry sorts as 'infinity'. One extra row tells whether more exist.
        const r = await client.query<TrackingIdentityRow>(
          `SELECT id, tenant_product_ref, kind, code, expiry_date::text AS expiry_date,
                  manufactured_on::text AS manufactured_on, origin,
                  COALESCE(expiry_date, 'infinity'::date)::text AS sort_expiry
             FROM tracking_identities
            WHERE tenant_product_ref = $1
              AND ($2::text IS NULL
                   OR (kind, COALESCE(expiry_date, 'infinity'::date), code, id)
                      > ($2::text, $3::date, $4::text, $5::uuid))
            ORDER BY kind ASC, COALESCE(expiry_date, 'infinity'::date) ASC, code ASC, id ASC
            LIMIT $6`,
          [
            input.productId,
            after?.kind ?? null,
            after?.expiry ?? null,
            after?.code ?? null,
            after?.id ?? null,
            limit + 1,
          ],
        );
        const page = r.rows.slice(0, limit);
        const last = page[page.length - 1];
        return {
          items: page.map(toTrackingIdentityBody),
          nextCursor:
            r.rows.length > limit && last
              ? encodeTrackingIdentityCursor({
                  productId: input.productId,
                  kind: last.kind,
                  expiry: last.sort_expiry,
                  code: last.code,
                  id: last.id,
                })
              : null,
        };
      },
    );
  }

  /**
   * Append a manual movement (inbound / outbound / adjustment). Append-only:
   * one INSERT inside one `runWithTenantContext` transaction, plus one audit
   * event in the SAME transaction. Returns the persisted `toBody` projection.
   *
   * Validation (all server-side; the body never carries tenant/store/actor):
   *   - sign agrees with type (FR-022): inbound>0, outbound<0, adjustment≠0;
   *   - adjustment requires a non-empty reason (FR-012);
   *   - the supplied stockingUnit matches the product's ESTABLISHED unit, if the
   *     product already has movements (FR-022) — first movement / ad-hoc
   *     null-product establishes its own unit, no prior to compare against.
   * On-hand MAY go negative — never rejected (allow-and-flag, FR-024).
   */
  async createStockMovement(input: CreateStockMovementInput): Promise<StockMovementBody> {
    const { reason, stockingUnit } = this.validateManualMovementInput(input);

    const tenantProductRef = input.tenantProductRef ?? null;
    const movementId = newId();
    const auditId = newId();

    return await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockMovementBody> => {
        await assertReferencesInTenant(client, {
          storeIds: [input.storeId],
          tenantProductRef,
        });
        // ---- Cross-unit check (FR-022) -----------------------------------
        // The product's established unit is the unit of its existing movements
        // at this store (no catalog stocking-unit column). Skip for ad-hoc
        // null-product and for a product's very first movement.
        if (tenantProductRef !== null) {
          await assertUnitMatchesEstablished(
            client,
            input.storeId,
            tenantProductRef,
            stockingUnit,
          );
        }

        // ---- Position (RT-432, RT-290 G4-6) ------------------------------
        const position = await resolvePosition(client, input.storeId, {
          stockLocationId: input.stockLocationId ?? null,
          inventoryStatus: input.inventoryStatus ?? null,
        });

        // ---- Append-only INSERT ------------------------------------------
        // tenant_id / store_id / created_by are the server-resolved values
        // (principal + path), never the body. occurred_at defaults to now()
        // when omitted; received_at defaults in the schema (security clock).
        const inserted = await insertMovementRow(
          client,
          // RT-425: a manual movement is its own governed `adjustment` Business
          // Event (RT-289 G2-1, decision 838), identified by the movement id.
          `INSERT INTO stock_movements
             (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
              tenant_product_ref, reason, occurred_at, sale_id, sale_line_id,
              terminal_event_ref, created_by, event_type, event_ref_id,
              stock_location_id, inventory_status)
           VALUES
             ($1, $2, $3, $4, $5::numeric(19,4), $6, $7, $8,
              COALESCE($9::timestamptz, now()), $10, $11, $12, $13, 'adjustment', $1,
              $14, $15)
           RETURNING ${MOVEMENT_COLUMNS}`,
          [
            movementId,
            input.tenantId,
            input.storeId,
            input.movementType,
            input.quantity,
            stockingUnit,
            tenantProductRef,
            reason,
            input.occurredAt ?? null,
            input.saleId ?? null,
            input.saleLineId ?? null,
            input.terminalEventRef ?? null,
            input.userId,
            position.stockLocationId,
            position.inventoryStatus,
          ],
          { storeId: input.storeId, tenantProductRef, suppliedUnit: stockingUnit },
        );
        const row = inserted.rows[0];
        if (!row) {
          throw new Error('InventoryService.createStockMovement: INSERT returned no row');
        }
        await recordNotPosted(client, input.tenantId, [row.id]);

        // ---- Audit event in the SAME transaction (FR-013, SC-007) --------
        // Atomic with the movement INSERT: a failure on either rolls both back.
        await client.query(
          `INSERT INTO audit_events
             (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            auditId,
            input.userId,
            input.tenantId,
            AUDIT_ACTION_MOVEMENT_CREATE,
            AUDIT_TARGET_TYPE_MOVEMENT,
            row.id,
            '{}',
          ],
        );

        // Outbox emit IN-TRANSACTION with the movement + audit (issue #465 B).
        await emitMovementCreated(client, {
          tenantId: input.tenantId,
          storeId: input.storeId,
          movementIds: [row.id],
          movementType: row.movement_type,
          tenantProductRef,
        });

        // ---- Negative-balance signal (FR-024) ----------------------------
        // An outbound that drove on-hand below zero is flagged, never rejected.
        if (input.movementType === 'outbound') {
          await flagIfNegativeOnHand(client, input.storeId, tenantProductRef);
        }

        return toMovementBody(asNotPosted(row));
      },
    );
  }

  /**
   * Pre-DB validation for a manual movement: FR-002 type rules, the
   * numeric(19,4)-scale sign/zero rules, and the adjustment-reason rule.
   * The row persists as numeric(19,4); the sign/zero rules are evaluated on
   * the value AT THAT SCALE so a sub-0.0001 input (e.g. "0.00004") that
   * Postgres would round to 0.0000 cannot slip past the non-zero / adjustment
   * rules and persist as a zero-quantity movement. (The DTO regex also bounds
   * this at the boundary; this is the defense-in-depth half for direct
   * callers.)
   */
  private validateManualMovementInput(input: CreateStockMovementInput): {
    reason: string | null;
    stockingUnit: string;
  } {
    if (!MANUAL_MOVEMENT_TYPES.includes(input.movementType)) {
      // write-off is a reason-coded outbound, NOT a type (FR-002); transfer /
      // count_correction are produced by their own operations only.
      throw new BadRequestException(
        `movementType must be one of ${MANUAL_MOVEMENT_TYPES.join(', ')}`,
      );
    }
    const qty = parseQuantity(input.quantity);
    if (qty === 0n) {
      throw new BadRequestException('quantity must be non-zero at numeric(19,4) scale');
    }
    if (input.movementType === 'inbound' && qty < 0n) {
      throw new BadRequestException('inbound quantity must be positive');
    }
    if (input.movementType === 'outbound' && qty > 0n) {
      throw new BadRequestException('outbound quantity must be negative');
    }
    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : null;
    if (input.movementType === 'adjustment' && reason === null) {
      throw new BadRequestException('adjustment requires a reason');
    }
    const stockingUnit = input.stockingUnit.trim();
    if (stockingUnit.length === 0) {
      throw new BadRequestException('stockingUnit is required');
    }
    return { reason, stockingUnit };
  }

  /**
   * Create an intra-tenant transfer as linked transfer_out / transfer_in
   * movements in one transaction (009-US5, FR-020). See
   * StockTransferService.createStockTransfer.
   */
  createStockTransfer(input: CreateStockTransferInput): Promise<StockTransferBody> {
    return this.transfers.createStockTransfer(input);
  }

  /**
   * Record a physical stock count and append a count_correction for any
   * variance (009-US6, FR-021). See StockCountService.recordStockCount.
   */
  recordStockCount(input: RecordStockCountInput): Promise<StockCountResultBody> {
    return this.counts.recordStockCount(input);
  }

  /**
   * Append a provenance-deduplicated void/refund/return restock inbound
   * (009-RESTOCK, FR-025/R6). See InventoryBackfill.backfillRestockInbound.
   */
  backfillRestockInbound(input: BackfillRestockInboundInput): Promise<StockMovementBody> {
    return this.backfill.backfillRestockInbound(input);
  }
}
