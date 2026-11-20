/**
 * ConsoleCatalogWriteService — RT-738 (CAT-W1 + CAT-W2): the interim, audited
 * console writes of the Tenant Catalog (`catalog/console-catalog.yaml`
 * 1.1.0-draft). Interim: direct writes of the current model, before Catalog
 * Change Sets (decision 400).
 *
 * DATA ACCESS — raw parameterized SQL under `runWithTenantContext` (tenant
 * RLS, `isPlatformAdmin: false`) plus an explicit `tenant_id` predicate on
 * every statement; the tenant and the actor are the session's (§II, §XII).
 * Each write is ONE transaction: the change, its `audit_events` row and the
 * detail it answers with. The existing `catalog_change_log` triggers (0015)
 * record every product, identifier and override change for the POS
 * read-down, so nothing else is written here.
 *
 * Like `ReconciliationService`, the writes own their SQL instead of calling
 * `TenantCatalogService` / `StoreOverrideService` / `ProductAliasesService`:
 * those open their own transaction (or write their own audit row), so they
 * cannot share the write + audit transaction the contract requires.
 *
 * Invariants:
 *   - Price is never written (O-2): no write sets a default price, and an
 *     override's price is kept as is; retiring an override with a price is
 *     refused (`price_override_present`).
 *   - Store data follows the operator store scope (`operator-store-scope.ts`),
 *     as on the reads, and a soft-deleted store is the 404 for every scope
 *     (owner decision on RT-730). Override writes pin `app.current_store` to
 *     the one store (the `store_product_overrides_tenant_write` policy).
 *   - `expectedUpdatedAt` is compared at millisecond precision, the precision
 *     the surface renders. The `set_updated_at` trigger stamps `now()` (the
 *     transaction start), so before changing a row the write checks that
 *     `now()` is a later millisecond than the row's `updated_at` and, if not,
 *     reruns the transaction: every accepted write gives a strictly later
 *     `updatedAt`, so a stale precondition can never match it.
 *   - A unique-index race on an identifier is `alias_conflict`; on an
 *     override it is `stale_write`. Both roll the transaction back.
 *   - RT-1334 (brands): a product's `brandId` must name an active brand of the
 *     tenant (`brand_unavailable`); the composite FK of 0097 is the backstop.
 *     A brand create or rename to a name an active brand of the tenant holds
 *     is `brand_name_conflict`, read from the partial unique index (so a race
 *     is refused the same way). A rename takes `expectedUpdatedAt` and the
 *     same strictly-later `updatedAt` rule as a product. Both are audited in
 *     their transaction; neither touches the POS change log.
 */
import { Inject, Injectable } from "@nestjs/common";
import { rebuildOfferPackForCatalogChanges } from "../../offers";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../database";
import { MembershipRepository } from "../../context/membership.repository";
import { inStoreScope, readScope } from "../../context/operator-store-scope";
import type { StoreScope } from "../../context/store-scope";
import {
  applyPatch,
  changes,
  createBrandsIn,
  createProductsIn,
  insertIdentifiersIn,
  isBrandNameConflict,
  isUniqueViolation,
  lockProductsIn,
  type LockedProduct,
  RerunWrite,
  requireAdvance,
  requireExpected,
  UPDATED_MS_SQL,
  updateProductsIn,
} from "./console-catalog.domain";
import { CatalogWriteRefusedError } from "./console-catalog.refusal";
import { toBrand, type BrandRow, type ConsoleCatalogBrand, type ConsoleCatalogProductDetail } from "./console-catalog.projections";
import {
  BRANDS_SQL,
  CatalogProductNotFoundError,
  CatalogStoreNotInScopeError,
  ConsoleCatalogReadService,
  type ScopedCatalogReadInput,
} from "./console-catalog.service";
import type {
  CreateCatalogBrandBody,
  CreateCatalogProductBody,
  ProductIdentifierKeyBody,
  RenameCatalogBrandBody,
  RetireBody,
  UpdateCatalogProductBody,
  UpsertStoreOverrideBody,
} from "./console-catalog.write-bodies";
import { findCallerRoleCode } from "../../context";

// RT-1507: the refusals moved to `console-catalog.refusal.ts` (shared with the domain functions); same names.
export { CatalogWriteRefusedError };

/** The session context of a write, with the actor and the request id for the audit row. */
export interface CatalogWriteInput extends ScopedCatalogReadInput {
  readonly actorUserId: string;
  readonly requestId: string | null;
}

/** RT-1334: a brand that is absent, of another tenant or retired → the non-disclosing 404. */
export class CatalogBrandNotFoundError extends Error {
  constructor() {
    super("brand not found");
    this.name = "CatalogBrandNotFoundError";
  }
}

/** The brand a rename addresses (path `brandId`, already parsed). */
export interface BrandTarget {
  readonly brandId: string;
}

/** The product a write addresses (path `productId`, already parsed). */
export interface ProductTarget {
  readonly productId: string;
}

/** The product and store a store-override write addresses. */
export interface OverrideTarget extends ProductTarget {
  readonly storeId: string;
}

/** The caller's access to a store in scope: the role code that gates tax overrides (O-4). */
interface StoreAccess {
  readonly roleCode: string | null;
}

/** Roles that may change a store tax override (O-4). */
const TAX_OVERRIDE_ROLES: ReadonlySet<string> = new Set(["owner", "tenant_admin"]);

const PRODUCT_TARGET = "tenant_product";
const IDENTIFIER_TARGET = "product_alias";
const OVERRIDE_TARGET = "store_product_override";
const BRAND_TARGET = "tenant_product_brand";

/** Reruns of a write whose transaction began in the row's `updated_at` millisecond. */
const ADVANCE_ATTEMPTS = 5;

interface BrandLockRow {
  readonly name: string;
  readonly updated_ms: string;
  readonly can_advance: boolean;
}

interface OverrideLockRow {
  readonly id: string;
  readonly is_active: boolean | null;
  readonly tax_category: string | null;
  readonly has_price: boolean;
  readonly updated_ms: string;
  readonly can_advance: boolean;
}

const LOCK_BRAND_SQL = `
  SELECT name,${UPDATED_MS_SQL}
    FROM tenant_product_brands
   WHERE tenant_id = $1::uuid AND id = $2::uuid AND retired_at IS NULL
     FOR NO KEY UPDATE`;

/** Exported for the import's validate (RT-1505 part B), so a deleted store is treated as it is here. */
export const LIVE_STORE_SQL = `SELECT 1 FROM stores WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL`;

const LOCK_OVERRIDE_SQL = `
  SELECT id::text AS id, is_active, tax_category, price IS NOT NULL AS has_price,${UPDATED_MS_SQL}
    FROM store_product_overrides
   WHERE tenant_id = $1::uuid AND product_id = $2::uuid AND store_id = $3::uuid AND retired_at IS NULL
     FOR UPDATE`;

@Injectable()
export class ConsoleCatalogWriteService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
    private readonly reads: ConsoleCatalogReadService,
  ) {}

  /** consoleCreateCatalogProduct — a new product with no price, identifier or override. */
  async createProduct(input: CatalogWriteInput, body: CreateCatalogProductBody): Promise<ConsoleCatalogProductDetail> {
    return await this.write(input, async (client) => {
      const [productId] = await createProductsIn(client, input, [
        {
          name: body.name,
          description: body.description ?? null,
          categoryId: body.categoryId ?? null,
          brandId: body.brandId ?? null,
          taxCategory: body.taxCategory,
          isActive: body.isActive ?? true,
        },
      ]);
      return this.reads.detailIn(client, input, productId as string);
    });
  }

  /** RT-1334 consoleCreateCatalogBrand — a new active brand; a taken active name is `brand_name_conflict`. */
  async createBrand(input: CatalogWriteInput, body: CreateCatalogBrandBody): Promise<ConsoleCatalogBrand> {
    return await this.write(input, async (client) => {
      const [brandId] = await createBrandsIn(client, input, [{ name: body.name }]);
      return this.brandIn(client, input, brandId as string);
    });
  }

  /**
   * RT-1334 consoleRenameCatalogBrand — the name of one active brand of the
   * tenant (else the 404), under `expectedUpdatedAt`; a name another active
   * brand holds is `brand_name_conflict`. Its products keep the brand.
   */
  async renameBrand(
    input: CatalogWriteInput,
    target: BrandTarget,
    body: RenameCatalogBrandBody,
  ): Promise<ConsoleCatalogBrand> {
    const { brandId } = target;
    return await this.write(input, async (client) => {
      const r = await client.query<BrandLockRow>(LOCK_BRAND_SQL, [input.tenantId, brandId]);
      const current = r.rows[0];
      if (current === undefined) throw new CatalogBrandNotFoundError();
      requireExpected(current, body);
      requireAdvance(current);
      try {
        await client.query(`UPDATE tenant_product_brands SET name = $3 WHERE tenant_id = $1::uuid AND id = $2::uuid`, [
          input.tenantId,
          brandId,
          body.name,
        ]);
      } catch (err) {
        if (isBrandNameConflict(err)) throw new CatalogWriteRefusedError("brand_name_conflict");
        throw err;
      }
      await this.audit(client, input, {
        action: "catalog.brand.rename",
        targetType: BRAND_TARGET,
        targetId: brandId,
        storeId: null,
        metadata: { brand_id: brandId, old: { name: current.name }, new: { name: body.name } },
      });
      return this.brandIn(client, input, brandId);
    });
  }

  /** consoleUpdateCatalogProduct — the given simple fields; never price, status or tracking. */
  async updateProduct(
    input: CatalogWriteInput,
    target: ProductTarget,
    body: UpdateCatalogProductBody,
  ): Promise<ConsoleCatalogProductDetail> {
    const { productId } = target;
    return await this.write(input, async (client) => {
      const { expectedUpdatedAt, ...patch } = body;
      await updateProductsIn(client, input, [{ productId, expectedUpdatedAt, patch }]);
      return this.reads.detailIn(client, input, productId);
    });
  }

  /** consoleRetireCatalogProduct — sets `retired_at`; identifiers and overrides stay. */
  async retireProduct(input: CatalogWriteInput, target: ProductTarget, body: RetireBody): Promise<ConsoleCatalogProductDetail> {
    const { productId } = target;
    return await this.write(input, async (client) => {
      const current = await this.lockProduct(client, input, target);
      requireLiveProduct(current);
      requireExpected(current, body);
      requireAdvance(current);
      await client.query(
        `UPDATE tenant_products SET retired_at = now(), updated_by = $3, correlation_id = $4
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [input.tenantId, productId, input.actorUserId, input.requestId],
      );
      await this.audit(client, input, {
        action: "catalog.product.retire",
        targetType: PRODUCT_TARGET,
        targetId: productId,
        storeId: null,
        metadata: { product_id: productId, old: { status: current.is_active ? "active" : "inactive" }, new: { status: "retired" } },
      });
      // RT-1337: a retired product leaves every live offer's eligible set.
      await rebuildOfferPackForCatalogChanges(client, input.tenantId, {
        productIds: [productId],
        categoryIds: [current.category_id],
        brandIds: [current.brand_id],
      });
      return this.reads.detailIn(client, input, productId);
    });
  }

  /** consoleAddProductIdentifier — a new active identifier; an active duplicate in its scope is `alias_conflict`. */
  async addIdentifier(
    input: CatalogWriteInput,
    target: ProductTarget,
    key: ProductIdentifierKeyBody,
  ): Promise<ConsoleCatalogProductDetail> {
    const { productId } = target;
    return await this.write(input, async (client) => {
      const current = await this.lockProduct(client, input, target);
      const storeId = key.storeId ?? null;
      if (storeId !== null) await this.requireStoreInScope(client, input, { storeId });
      if (current.retired) throw new CatalogWriteRefusedError("product_retired");
      await insertIdentifiersIn(client, input, [
        { productId, identifierType: key.identifierType, value: key.value, storeId, sourceSystem: key.sourceSystem ?? null },
      ]);
      return this.reads.detailIn(client, input, productId);
    });
  }

  /** consoleRetireProductIdentifier — the active identifier of this product with exactly this key. */
  async retireIdentifier(
    input: CatalogWriteInput,
    target: ProductTarget,
    key: ProductIdentifierKeyBody,
  ): Promise<ConsoleCatalogProductDetail> {
    const { productId } = target;
    return await this.write(input, async (client) => {
      await this.lockProduct(client, input, target);
      const storeId = key.storeId ?? null;
      if (storeId !== null) await this.requireStoreInScope(client, input, { storeId });
      const retired = await client.query<{ id: string }>(
        `UPDATE product_aliases SET retired_at = now()
          WHERE tenant_id = $1::uuid AND product_id = $2::uuid AND identifier_type = $3 AND value = $4
            AND store_id IS NOT DISTINCT FROM $5::uuid AND source_system IS NOT DISTINCT FROM $6::text
            AND retired_at IS NULL
          RETURNING id::text AS id`,
        [input.tenantId, productId, key.identifierType, key.value, storeId, key.sourceSystem ?? null],
      );
      const row = retired.rows[0];
      if (row === undefined) throw new CatalogProductNotFoundError();
      await this.audit(client, input, {
        action: "catalog.product_identifier.retire",
        targetType: IDENTIFIER_TARGET,
        targetId: row.id,
        storeId,
        metadata: identifierMetadata(target, key),
      });
      return this.reads.detailIn(client, input, productId);
    });
  }

  /** consoleUpsertStoreOverride — sets or clears `isActive` / `taxCategory`; the price is kept. */
  async upsertOverride(
    input: CatalogWriteInput,
    target: OverrideTarget,
    body: UpsertStoreOverrideBody,
  ): Promise<ConsoleCatalogProductDetail> {
    const { productId, storeId } = target;
    return await this.write(input, async (client) => {
      const product = await this.lockProduct(client, input, target);
      const access = await this.requireStoreInScope(client, input, target);
      if ("taxCategory" in body) requireTaxRole(access);
      requireLiveProduct(product);

      const current = await this.lockOverride(client, input, target);
      requireOverrideExpected(current, body);
      const before: OverrideFields = { isActive: current?.is_active ?? null, taxCategory: current?.tax_category ?? null };
      const { expectedUpdatedAt: _precondition, ...patch } = body;
      const after = applyPatch(before, patch);
      requireNotEmpty(after, current);

      const overrideId =
        current === null
          ? await this.insertOverride(client, input, { productId, storeId, fields: after })
          : await this.updateOverride(client, input, current, after);
      await this.audit(client, input, {
        action: "catalog.store_override.upsert",
        targetType: OVERRIDE_TARGET,
        targetId: overrideId,
        storeId,
        metadata: { product_id: productId, store_id: storeId, created: current === null, ...changes(before, after) },
      });
      return this.reads.detailIn(client, input, productId);
    });
  }

  /** consoleRetireStoreOverride — retires the store's active override, unless it carries a price. */
  async retireOverride(
    input: CatalogWriteInput,
    target: OverrideTarget,
    body: RetireBody,
  ): Promise<ConsoleCatalogProductDetail> {
    const { productId, storeId } = target;
    return await this.write(input, async (client) => {
      await this.lockProduct(client, input, target);
      const access = await this.requireStoreInScope(client, input, target);
      const current = await this.lockOverride(client, input, target);
      if (current === null) throw new CatalogProductNotFoundError();
      if (current.tax_category !== null) requireTaxRole(access);
      if (current.has_price) throw new CatalogWriteRefusedError("price_override_present");
      requireExpected(current, body);
      await client.query(
        `UPDATE store_product_overrides SET retired_at = now(), updated_by = $3, correlation_id = $4
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [input.tenantId, current.id, input.actorUserId, input.requestId],
      );
      await this.audit(client, input, {
        action: "catalog.store_override.retire",
        targetType: OVERRIDE_TARGET,
        targetId: current.id,
        storeId,
        metadata: {
          product_id: productId,
          store_id: storeId,
          old: { isActive: current.is_active, taxCategory: current.tax_category },
        },
      });
      return this.reads.detailIn(client, input, productId);
    });
  }

  /** The store's active override of the product, locked, with `app.current_store` pinned to the store. */
  private async lockOverride(
    client: PoolClient,
    input: CatalogWriteInput,
    target: OverrideTarget,
  ): Promise<OverrideLockRow | null> {
    // Pins `app.current_store` to the one store an override write touches.
    await client.query("SELECT set_config('app.current_store', $1, true)", [target.storeId]);
    const locked = await client.query<OverrideLockRow>(LOCK_OVERRIDE_SQL, [
      input.tenantId,
      target.productId,
      target.storeId,
    ]);
    return locked.rows[0] ?? null;
  }

  /** A new active override; a concurrent upsert that created it first is `stale_write`. */
  private async insertOverride(
    client: PoolClient,
    input: CatalogWriteInput,
    row: OverrideTarget & { readonly fields: OverrideFields },
  ): Promise<string> {
    const overrideId = newId();
    try {
      await client.query(
        `INSERT INTO store_product_overrides
           (id, tenant_id, store_id, product_id, is_active, tax_category, created_by, updated_by, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8)`,
        [
          overrideId,
          input.tenantId,
          row.storeId,
          row.productId,
          row.fields.isActive,
          row.fields.taxCategory,
          input.actorUserId,
          input.requestId,
        ],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new CatalogWriteRefusedError("stale_write");
      throw err;
    }
    return overrideId;
  }

  /** Changes the locked override's availability and tax category; its price is untouched. */
  private async updateOverride(
    client: PoolClient,
    input: CatalogWriteInput,
    current: OverrideLockRow,
    fields: OverrideFields,
  ): Promise<string> {
    requireAdvance(current);
    await client.query(
      `UPDATE store_product_overrides
          SET is_active = $3, tax_category = $4, updated_by = $5, correlation_id = $6
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [input.tenantId, current.id, fields.isActive, fields.taxCategory, input.actorUserId, input.requestId],
    );
    return current.id;
  }

  /** The product row, locked for this write; absent or of another tenant → 404. */
  private async lockProduct(client: PoolClient, input: CatalogWriteInput, target: ProductTarget): Promise<LockedProduct> {
    return (await lockProductsIn(client, input.tenantId, [target.productId])).get(target.productId) as LockedProduct;
  }

  /** The brand as the contract renders it, read in the write's transaction. */
  private async brandIn(client: PoolClient, input: CatalogWriteInput, brandId: string): Promise<ConsoleCatalogBrand> {
    const r = await client.query<BrandRow>(BRANDS_SQL, [input.tenantId, brandId]);
    const row = r.rows[0];
    if (row === undefined) throw new CatalogBrandNotFoundError();
    return toBrand(row);
  }

  /**
   * The store must be live, of the tenant and inside the caller's store scope
   * (the reads' rule), else the 404. Returns the caller's access to it.
   */
  private async requireStoreInScope(
    client: PoolClient,
    input: CatalogWriteInput,
    target: { readonly storeId: string },
  ): Promise<StoreAccess> {
    // RT-1470: a session platform admin decides as an owner (tenant-wide), member or not.
    const roleCode = await findCallerRoleCode(this.memberships, client, input);
    const scope: StoreScope = readScope({ context: input.context, roleCode });
    if (!inStoreScope(scope, target.storeId)) throw new CatalogStoreNotInScopeError();
    const store = await client.query(LIVE_STORE_SQL, [target.storeId, input.tenantId]);
    if (store.rowCount === 0) throw new CatalogStoreNotInScopeError();
    return { roleCode };
  }

  private async audit(
    client: PoolClient,
    input: CatalogWriteInput,
    event: {
      readonly action: string;
      readonly targetType: string;
      readonly targetId: string;
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
        event.targetType,
        event.targetId,
        input.requestId,
        JSON.stringify(event.metadata),
      ],
    );
  }

  /** One tenant transaction, rerun while it began in the changed row's `updated_at` millisecond. */
  private async write<T>(input: CatalogWriteInput, work: (client: PoolClient) => Promise<T>): Promise<T> {
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

interface OverrideFields extends Record<string, unknown> {
  readonly isActive: boolean | null;
  readonly taxCategory: string | null;
}

function requireLiveProduct(product: LockedProduct): void {
  if (product.retired) throw new CatalogWriteRefusedError("product_retired");
}

/** The override precondition: `null` asserts there is no active override. */
function requireOverrideExpected(
  current: OverrideLockRow | null,
  body: { readonly expectedUpdatedAt: number | null },
): void {
  const expected = body.expectedUpdatedAt;
  if (current === null && expected === null) return;
  if (current === null || expected === null) throw new CatalogWriteRefusedError("stale_write");
  requireExpected(current, { expectedUpdatedAt: expected });
}

/** Only owner / tenant_admin change a store tax override (O-4). */
function requireTaxRole(access: StoreAccess): void {
  if (!TAX_OVERRIDE_ROLES.has(access.roleCode ?? "")) throw new CatalogWriteRefusedError("tax_override_forbidden");
}

/** An override must keep at least one overridden field (the price counts, though it is never written here). */
function requireNotEmpty(fields: OverrideFields, current: OverrideLockRow | null): void {
  const hasPrice = current?.has_price ?? false;
  const overridden = [fields.isActive !== null, fields.taxCategory !== null, hasPrice].filter(Boolean).length;
  if (overridden === 0) throw new CatalogWriteRefusedError("override_empty");
}

function identifierMetadata(target: ProductTarget, key: ProductIdentifierKeyBody): Record<string, unknown> {
  return {
    product_id: target.productId,
    identifier_type: key.identifierType,
    value: key.value,
    store_id: key.storeId ?? null,
    source_system: key.sourceSystem ?? null,
  };
}
