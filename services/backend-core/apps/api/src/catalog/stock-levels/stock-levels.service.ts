/**
 * StockLevelsService — RT-1066: the console read and writes of a product's
 * low-stock thresholds (`catalog/stock-levels.yaml`; decision record
 * `docs/planning/rt-1064-low-stock-thresholds.md`, TH-1 to TH-5) over
 * `product_stock_levels` (0078).
 *
 * DATA ACCESS — raw parameterized SQL under `runWithTenantContext` (tenant
 * RLS, `isPlatformAdmin: false`) plus an explicit `tenant_id` predicate on
 * every statement; the tenant and the actor are the session's (§II, §XII).
 * Each write is ONE transaction: the change, its `audit_events` row and the
 * levels it answers with. Nothing is written to `catalog_change_log`: the POS
 * never uses a threshold (TH-4). Nothing is read from or sent to ERPNext.
 *
 * Invariants:
 *   - Store data follows the operator store scope (`operator-store-scope.ts`),
 *     as on the console catalog: the read lists only the store levels of
 *     stores in the caller's scope that are live; a store write outside the
 *     scope, of another tenant or soft-deleted is the 404.
 *   - The product row is locked `FOR SHARE` for every write, so a product
 *     retire (an UPDATE of `tenant_products`) and a level set never interleave;
 *     the active level of the scope is locked `FOR UPDATE`. Two concurrent
 *     creates of the same scope race on the partial unique index: the loser
 *     is `stale_write` (23505), as on a store override.
 *   - `expectedUpdatedAt` is compared at millisecond precision, the precision
 *     the surface renders. Every accepted write gives the scope a strictly
 *     later `updatedAt` than any level the scope ever had (retired ones
 *     included): before writing, the write checks that `now()` is a later
 *     millisecond and otherwise reruns the transaction. So a level recreated
 *     after a retire never repeats an `updatedAt`, and a retried retire can
 *     never match it (TH-4: 404 or 409 `stale_write`, never a second retire).
 *   - A refused write writes nothing (the transaction rolls back).
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import { MembershipRepository } from "../../context/membership.repository";
import { callerStoreScope, inStoreScope, scopeStoreIds } from "../../context/operator-store-scope";
import type { ResolvedContext } from "../../context/types";
import { criticalAboveReorder, type RetireStockLevelBody, type SetStockLevelBody } from "./stock-levels.bodies";

/** One active level on the wire (`StockLevel`). */
export interface StockLevel {
  readonly reorderLevel: string;
  readonly criticalLevel: string | null;
  readonly updatedAt: string;
}

/** One store's active level on the wire (`StoreStockLevel`). */
export interface StoreStockLevel extends StockLevel {
  readonly storeId: string;
}

/** `ProductStockLevels`. */
export interface ProductStockLevels {
  readonly productId: string;
  readonly tenantLevel: StockLevel | null;
  readonly storeLevels: StoreStockLevel[];
}

/** A product that is absent or of another tenant, a store out of scope, or (retire) no active level → 404. */
export class StockLevelNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "StockLevelNotFoundError";
  }
}

export type StockLevelRefusalCode = "stale_write" | "product_retired" | "critical_above_reorder";

const REFUSAL_STATUS: Readonly<Record<StockLevelRefusalCode, 409 | 422>> = {
  stale_write: 409,
  product_retired: 409,
  critical_above_reorder: 422,
};

/** A write the contract refuses with a 409 / 422 and its code. Nothing is written. */
export class StockLevelRefusedError extends Error {
  readonly status: 409 | 422;
  constructor(readonly code: StockLevelRefusalCode) {
    super(code);
    this.name = "StockLevelRefusedError";
    this.status = REFUSAL_STATUS[code];
  }
}

/** The session context of a read; its store scope bounds the store levels. */
export interface StockLevelsReadInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
}

/** The session context of a write, with the actor and the request id for the audit row. */
export interface StockLevelsWriteInput extends StockLevelsReadInput {
  readonly actorUserId: string;
  readonly requestId: string | null;
}

/** The level a write addresses: the tenant level (`storeId` null) or one store's. */
export interface StockLevelTarget {
  readonly productId: string;
  readonly storeId: string | null;
}

const LEVEL_TARGET = "product_stock_level";

/** Reruns of a write whose transaction began in the scope's latest `updated_at` millisecond. */
const ADVANCE_ATTEMPTS = 5;

/** Thrown inside a transaction to roll it back and rerun it (see the class header). */
class RerunWrite extends Error {
  constructor() {
    super("rerun");
    this.name = "RerunWrite";
  }
}

interface LevelRow {
  readonly store_id: string | null;
  readonly reorder_level: string;
  readonly critical_level: string | null;
  readonly updated_at: Date;
}

interface LockedLevelRow {
  readonly id: string;
  readonly reorder_level: string;
  readonly critical_level: string | null;
  readonly updated_ms: string;
}

const LOCK_PRODUCT_SQL = `
  SELECT retired_at IS NOT NULL AS retired
    FROM tenant_products
   WHERE tenant_id = $1::uuid AND id = $2::uuid
     FOR SHARE`;

const PRODUCT_EXISTS_SQL = `SELECT 1 FROM tenant_products WHERE tenant_id = $1::uuid AND id = $2::uuid`;

const LIVE_STORE_SQL = `SELECT 1 FROM stores WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL`;

/** `$3` NULL = the tenant level, else the store's. */
const SCOPE_SQL = `tenant_id = $1::uuid AND product_id = $2::uuid AND store_id IS NOT DISTINCT FROM $3::uuid`;

const LOCK_ACTIVE_SQL = `
  SELECT id::text AS id, reorder_level::text AS reorder_level, critical_level::text AS critical_level,
         floor(extract(epoch FROM date_trunc('milliseconds', updated_at)) * 1000)::bigint::text AS updated_ms
    FROM product_stock_levels
   WHERE ${SCOPE_SQL} AND retired_at IS NULL
     FOR UPDATE`;

/**
 * Whether this transaction's `now()` is a later millisecond than every level
 * the scope ever had (retired included). True when the scope has none.
 */
const CAN_ADVANCE_SQL = `
  SELECT COALESCE(date_trunc('milliseconds', now()) > date_trunc('milliseconds', max(updated_at)), true) AS can_advance
    FROM product_stock_levels
   WHERE ${SCOPE_SQL}`;

const TENANT_LEVEL_SQL = `
  SELECT NULL::text AS store_id, reorder_level::text AS reorder_level, critical_level::text AS critical_level, updated_at
    FROM product_stock_levels
   WHERE tenant_id = $1::uuid AND product_id = $2::uuid AND store_id IS NULL AND retired_at IS NULL`;

/** `$3` NULL = tenant-wide scope, else the scoped store ids (empty → none). Live stores only. */
const STORE_LEVELS_SQL = `
  SELECT psl.store_id::text AS store_id, psl.reorder_level::text AS reorder_level,
         psl.critical_level::text AS critical_level, psl.updated_at
    FROM product_stock_levels psl
   WHERE psl.tenant_id = $1::uuid AND psl.product_id = $2::uuid
     AND psl.store_id IS NOT NULL AND psl.retired_at IS NULL
     AND ($3::uuid[] IS NULL OR psl.store_id = ANY($3::uuid[]))
     AND EXISTS (SELECT 1 FROM stores s WHERE s.id = psl.store_id AND s.tenant_id = $1::uuid AND s.deleted_at IS NULL)
   ORDER BY psl.store_id`;

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

function toLevel(row: LevelRow): StockLevel {
  return { reorderLevel: row.reorder_level, criticalLevel: row.critical_level, updatedAt: row.updated_at.toISOString() };
}

/** The audit `old` / `new` value of a level. */
function auditValues(row: { readonly reorder_level: string; readonly critical_level: string | null }): {
  reorderLevel: string;
  criticalLevel: string | null;
} {
  return { reorderLevel: row.reorder_level, criticalLevel: row.critical_level };
}

@Injectable()
export class StockLevelsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /** consoleGetProductStockLevels — the tenant level and the store levels of the caller's scope. */
  async read(input: StockLevelsReadInput, productId: string): Promise<ProductStockLevels> {
    return await runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      const product = await client.query(PRODUCT_EXISTS_SQL, [input.tenantId, productId]);
      if (product.rowCount === 0) throw new StockLevelNotFoundError();
      return this.levelsIn(client, input, productId);
    });
  }

  /** consoleSetTenantStockLevel / consoleSetStoreStockLevel — create the active level or replace both values. */
  async set(input: StockLevelsWriteInput, target: StockLevelTarget, body: SetStockLevelBody): Promise<ProductStockLevels> {
    const criticalLevel = body.criticalLevel ?? null;
    return await this.write(input, async (client) => {
      const retired = await this.lockProduct(client, input, target);
      await this.requireStore(client, input, target);
      const current = await this.lockActive(client, input, target);
      requireExpected(current, body.expectedUpdatedAt);
      if (retired) throw new StockLevelRefusedError("product_retired");
      if (criticalAboveReorder(body.reorderLevel, criticalLevel)) {
        throw new StockLevelRefusedError("critical_above_reorder");
      }
      await this.requireAdvance(client, input, target);

      const next = { reorder_level: body.reorderLevel, critical_level: criticalLevel };
      const levelId =
        current === null
          ? await this.insertLevel(client, input, target, next)
          : await this.updateLevel(client, input, current, next);
      await this.audit(client, input, {
        action: target.storeId === null ? "catalog.stock_level.set" : "catalog.store_stock_level.set",
        levelId,
        storeId: target.storeId,
        metadata: {
          product_id: target.productId,
          ...(target.storeId === null ? {} : { store_id: target.storeId }),
          created: current === null,
          old: current === null ? null : auditValues(current),
          new: auditValues(next),
        },
      });
      return this.levelsIn(client, input, target.productId);
    });
  }

  /** consoleRetireTenantStockLevel / consoleRetireStoreStockLevel — soft-retire the active level. */
  async retire(
    input: StockLevelsWriteInput,
    target: StockLevelTarget,
    body: RetireStockLevelBody,
  ): Promise<ProductStockLevels> {
    return await this.write(input, async (client) => {
      // A retire is allowed on a retired product: the lock only proves it exists.
      await this.lockProduct(client, input, target);
      await this.requireStore(client, input, target);
      const current = await this.lockActive(client, input, target);
      if (current === null) throw new StockLevelNotFoundError();
      requireExpected(current, body.expectedUpdatedAt);
      await this.requireAdvance(client, input, target);
      await client.query(
        `UPDATE product_stock_levels SET retired_at = now(), updated_by = $3, correlation_id = $4
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [input.tenantId, current.id, input.actorUserId, input.requestId],
      );
      await this.audit(client, input, {
        action: target.storeId === null ? "catalog.stock_level.retire" : "catalog.store_stock_level.retire",
        levelId: current.id,
        storeId: target.storeId,
        metadata: {
          product_id: target.productId,
          ...(target.storeId === null ? {} : { store_id: target.storeId }),
          old: auditValues(current),
          new: null,
        },
      });
      return this.levelsIn(client, input, target.productId);
    });
  }

  /** The product's active levels as the caller sees them, read in `client`'s transaction. */
  private async levelsIn(client: PoolClient, input: StockLevelsReadInput, productId: string): Promise<ProductStockLevels> {
    const scope = await callerStoreScope(client, this.memberships, input);
    const tenant = await client.query<LevelRow>(TENANT_LEVEL_SQL, [input.tenantId, productId]);
    const stores = await client.query<LevelRow>(STORE_LEVELS_SQL, [input.tenantId, productId, scopeStoreIds(scope)]);
    const tenantRow = tenant.rows[0];
    return {
      productId,
      tenantLevel: tenantRow === undefined ? null : toLevel(tenantRow),
      storeLevels: stores.rows.map((row) => ({ storeId: row.store_id as string, ...toLevel(row) })),
    };
  }

  /** The product row, locked `FOR SHARE`; absent or of another tenant → 404. Returns whether it is retired. */
  private async lockProduct(client: PoolClient, input: StockLevelsWriteInput, target: StockLevelTarget): Promise<boolean> {
    const r = await client.query<{ retired: boolean }>(LOCK_PRODUCT_SQL, [input.tenantId, target.productId]);
    const row = r.rows[0];
    if (row === undefined) throw new StockLevelNotFoundError();
    return row.retired;
  }

  /**
   * A store level's store must be inside the caller's store scope, of the
   * tenant and live, else the 404 (the console catalog rule). No-op for the
   * tenant level.
   */
  private async requireStore(client: PoolClient, input: StockLevelsWriteInput, target: StockLevelTarget): Promise<void> {
    if (target.storeId === null) return;
    const scope = await callerStoreScope(client, this.memberships, input);
    if (!inStoreScope(scope, target.storeId)) throw new StockLevelNotFoundError();
    const store = await client.query(LIVE_STORE_SQL, [target.storeId, input.tenantId]);
    if (store.rowCount === 0) throw new StockLevelNotFoundError();
  }

  /** The scope's active level, locked; null when it has none. */
  private async lockActive(
    client: PoolClient,
    input: StockLevelsWriteInput,
    target: StockLevelTarget,
  ): Promise<LockedLevelRow | null> {
    const r = await client.query<LockedLevelRow>(LOCK_ACTIVE_SQL, [input.tenantId, target.productId, target.storeId]);
    return r.rows[0] ?? null;
  }

  /** Reruns the write when its `now()` is not a later millisecond than the scope's latest `updated_at`. */
  private async requireAdvance(client: PoolClient, input: StockLevelsWriteInput, target: StockLevelTarget): Promise<void> {
    const r = await client.query<{ can_advance: boolean }>(CAN_ADVANCE_SQL, [
      input.tenantId,
      target.productId,
      target.storeId,
    ]);
    if (r.rows[0]?.can_advance !== true) throw new RerunWrite();
  }

  /** A new active level; a concurrent set that created it first is `stale_write`. */
  private async insertLevel(
    client: PoolClient,
    input: StockLevelsWriteInput,
    target: StockLevelTarget,
    next: { readonly reorder_level: string; readonly critical_level: string | null },
  ): Promise<string> {
    const levelId = newId();
    try {
      await client.query(
        `INSERT INTO product_stock_levels
           (id, tenant_id, product_id, store_id, reorder_level, critical_level, created_by, updated_by, correlation_id)
         VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7, $7, $8)`,
        [
          levelId,
          input.tenantId,
          target.productId,
          target.storeId,
          next.reorder_level,
          next.critical_level,
          input.actorUserId,
          input.requestId,
        ],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new StockLevelRefusedError("stale_write");
      throw err;
    }
    return levelId;
  }

  /** Replaces both values of the locked active level (the trigger stamps `updated_at`). */
  private async updateLevel(
    client: PoolClient,
    input: StockLevelsWriteInput,
    current: LockedLevelRow,
    next: { readonly reorder_level: string; readonly critical_level: string | null },
  ): Promise<string> {
    await client.query(
      `UPDATE product_stock_levels
          SET reorder_level = $3::numeric, critical_level = $4::numeric, updated_by = $5, correlation_id = $6
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [input.tenantId, current.id, next.reorder_level, next.critical_level, input.actorUserId, input.requestId],
    );
    return current.id;
  }

  private async audit(
    client: PoolClient,
    input: StockLevelsWriteInput,
    event: {
      readonly action: string;
      readonly levelId: string;
      readonly storeId: string | null;
      readonly metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events
         (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        newId(),
        input.actorUserId,
        input.tenantId,
        event.storeId,
        event.action,
        LEVEL_TARGET,
        event.levelId,
        input.requestId,
        JSON.stringify(event.metadata),
      ],
    );
  }

  /** One tenant transaction, rerun while it began in the scope's latest `updated_at` millisecond. */
  private async write<T>(input: StockLevelsWriteInput, work: (client: PoolClient) => Promise<T>): Promise<T> {
    // sequential: retry loop with backoff; each attempt must finish before the next starts.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, work);
      } catch (err) {
        if (!(err instanceof RerunWrite) || attempt >= ADVANCE_ATTEMPTS) throw err;
        await new Promise((resolve) => setTimeout(resolve, attempt));
      }
    }
  }
}

/** The precondition: `null` asserts there is no active level; otherwise its `updatedAt` (ms). */
function requireExpected(current: LockedLevelRow | null, expected: number | null): void {
  if (current === null && expected === null) return;
  if (current === null || expected === null || Number(current.updated_ms) !== expected) {
    throw new StockLevelRefusedError("stale_write");
  }
}
