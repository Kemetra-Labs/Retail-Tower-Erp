/**
 * RT-1507 (spec 049 §8.3) — the domain functions of the console catalog product, identifier and brand writes, extracted
 * from `console-catalog.write.service.ts` with no wire change. The single-product console writes call them with one
 * item; the product import's publish calls them with the whole batch inside ONE transaction, so the import cannot
 * diverge from the single-product rules (same checks, same refusals, same audit actions and metadata, same
 * `catalog_change_log` triggers into the POS delta).
 *
 * Every function runs on the caller's client, inside its open transaction and under its tenant context (RLS), with an
 * explicit `tenant_id` predicate. Each is set-based: the cost of a batch is a handful of statements, not a handful per
 * product. The order of checks for one item is the single-product writes' order (404, retired, precondition, category,
 * brand, millisecond advance); across items every check runs for all of them before the next.
 *
 * Invariants kept from the writes: no price is ever written (O-2); `expectedUpdatedAt` is compared at millisecond
 * precision and a write whose transaction began in the row's own `updated_at` millisecond is rerun (`RerunWrite`) so a
 * stale precondition can never match the new `updatedAt`; a unique-index race is a refusal, never a 500.
 */
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import { insertAuditRowsInTransaction, type TransactionalAuditRow } from "../../audit";
import { rebuildOfferPackForCatalogChanges } from "../../offers";
import { CatalogWriteRefusedError } from "./console-catalog.refusal";
import { CatalogProductNotFoundError } from "./console-catalog.service";

/** The actor and request of a write, with the tenant (the session's, never the request's). */
export interface DomainContext {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
}

/** Where an import-written row came from: carried into the item's audit metadata (decision 423, OD-13). */
export interface ImportProvenance {
  readonly importBatchId: string;
  readonly rowNumber: number;
}

const PRODUCT_TARGET = "tenant_product";
const IDENTIFIER_TARGET = "product_alias";
const BRAND_TARGET = "tenant_product_brand";

/** The 0097 partial unique index: one ACTIVE brand per (tenant, name). */
const BRAND_NAME_INDEX = "UQ_idx_tenant_product_brands_tenant_name";

/** Thrown inside a transaction to roll it back and rerun it (the row's `updated_at` millisecond rule). */
export class RerunWrite extends Error {
  constructor() {
    super("rerun");
    this.name = "RerunWrite";
  }
}

/**
 * The row's `updated_at` in epoch milliseconds, and whether this transaction's `now()` is a later millisecond.
 */
export const UPDATED_MS_SQL = `
         floor(extract(epoch FROM date_trunc('milliseconds', updated_at)) * 1000)::bigint::text AS updated_ms,
         date_trunc('milliseconds', now()) > date_trunc('milliseconds', updated_at) AS can_advance`;

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

/** A unique violation of the active-brand-name index (any other 23505 propagates). */
export function isBrandNameConflict(err: unknown): boolean {
  return isUniqueViolation(err) && (err as { constraint?: unknown }).constraint === BRAND_NAME_INDEX;
}

/** The editable simple fields of a product. */
interface ProductFields extends Record<string, unknown> {
  readonly name: string;
  readonly description: string | null;
  readonly categoryId: string | null;
  readonly brandId: string | null;
  readonly taxCategory: string;
  readonly isActive: boolean;
}

/** `before` with every key the request sent (`null` included) replaced; absent keys keep their value. */
export function applyPatch<T extends Record<string, unknown>>(before: T, patch: { readonly [K in keyof T]?: T[K] | undefined }): T {
  const after: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) after[key] = value;
  }
  return after as T;
}

/** The audit `old` / `new` of the fields whose value changed. */
export function changes<T extends Record<string, unknown>>(before: T, after: T): { old: Partial<T>; new: Partial<T> } {
  const old: Partial<T> = {};
  const next: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (before[key] !== after[key]) {
      old[key] = before[key];
      next[key] = after[key];
    }
  }
  return { old, new: next };
}

/** The precondition: the row's `updated_at` (ms) must be the one the caller read. */
export function requireExpected(row: { readonly updated_ms: string }, body: { readonly expectedUpdatedAt: number }): void {
  if (Number(row.updated_ms) !== body.expectedUpdatedAt) throw new CatalogWriteRefusedError("stale_write");
}

/** Reruns the write when its `now()` is in the row's own `updated_at` millisecond. */
export function requireAdvance(row: { readonly can_advance: boolean }): void {
  if (!row.can_advance) throw new RerunWrite();
}

/** A locked product row. */
export interface LockedProduct {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly category_id: string | null;
  readonly brand_id: string | null;
  readonly tax_category: string;
  readonly is_active: boolean;
  readonly retired: boolean;
  readonly updated_ms: string;
  readonly can_advance: boolean;
}

// FOR NO KEY UPDATE, not FOR UPDATE (RT-1337): the offer Pack writes take FOR KEY SHARE on this row through
// their foreign keys while holding the tenant offers lock; FOR UPDATE here would deadlock against them
// once this transaction reaches that lock. A product edit changes no key column, and two edits still queue.
// Rows are locked in id order so two batches cannot deadlock each other.
const LOCK_PRODUCTS_SQL = `
  SELECT id::text AS id, name, description, category_id::text AS category_id, brand_id::text AS brand_id, tax_category,
         is_active, retired_at IS NOT NULL AS retired,${UPDATED_MS_SQL}
    FROM tenant_products
   WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])
   ORDER BY id
     FOR NO KEY UPDATE`;

/** The products locked for this write, by id; one absent (or of another tenant) → 404. */
export async function lockProductsIn(client: PoolClient, tenantId: string, ids: readonly string[]): Promise<Map<string, LockedProduct>> {
  const wanted = [...new Set(ids)];
  const r = await client.query<LockedProduct>(LOCK_PRODUCTS_SQL, [tenantId, wanted]);
  if (r.rows.length !== wanted.length) throw new CatalogProductNotFoundError();
  return new Map(r.rows.map((row) => [row.id, row]));
}

/** How many of `ids` name an active (not retired) row of `table` of the tenant. */
async function countUsable(client: PoolClient, table: "tenant_product_categories" | "tenant_product_brands", tenantId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) AND retired_at IS NULL`,
    [tenantId, ids],
  );
  return Number((r.rows[0] as { n: string }).n);
}

const distinct = (values: ReadonlyArray<string | null | undefined>): string[] => [...new Set(values.filter((v): v is string => typeof v === "string"))];

/** Every category must be an active one of the tenant, else 422 `category_unavailable`. */
async function requireUsableCategories(client: PoolClient, tenantId: string, ids: readonly string[]): Promise<void> {
  if ((await countUsable(client, "tenant_product_categories", tenantId, ids)) !== ids.length) throw new CatalogWriteRefusedError("category_unavailable");
}

/** RT-1334: every brand must be an active one of the tenant, else 422 `brand_unavailable`. */
async function requireUsableBrands(client: PoolClient, tenantId: string, ids: readonly string[]): Promise<void> {
  if ((await countUsable(client, "tenant_product_brands", tenantId, ids)) !== ids.length) throw new CatalogWriteRefusedError("brand_unavailable");
}

function auditRow(ctx: DomainContext, event: Pick<TransactionalAuditRow, "action" | "targetType" | "targetId" | "storeId" | "metadata">): TransactionalAuditRow {
  return { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, requestId: ctx.requestId, ...event };
}

const provenanceMetadata = (provenance: ImportProvenance | undefined): Record<string, unknown> =>
  provenance === undefined ? {} : { import_batch_id: provenance.importBatchId, row_number: provenance.rowNumber };

/** A product to create (consoleCreateCatalogProduct's fields). */
export interface NewProduct extends ProductFields {
  readonly provenance?: ImportProvenance;
}

/** New products with no price, identifier or override; their ids, in order. Audited `catalog.product.create`. */
export async function createProductsIn(client: PoolClient, ctx: DomainContext, products: readonly NewProduct[]): Promise<string[]> {
  if (products.length === 0) return [];
  await requireUsableCategories(client, ctx.tenantId, distinct(products.map((p) => p.categoryId)));
  await requireUsableBrands(client, ctx.tenantId, distinct(products.map((p) => p.brandId)));
  const ids = products.map(() => newId());
  await client.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, description, category_id, brand_id, is_active, tax_category, created_by, updated_by, correlation_id)
     SELECT x.id, $1::uuid, x.name, x.description, x.category_id, x.brand_id, x.is_active, x.tax_category, $2::uuid, $2::uuid, $3::uuid
       FROM unnest($4::uuid[], $5::text[], $6::text[], $7::uuid[], $8::uuid[], $9::boolean[], $10::text[])
            AS x(id, name, description, category_id, brand_id, is_active, tax_category)`,
    [
      ctx.tenantId,
      ctx.actorUserId,
      ctx.requestId,
      ids,
      products.map((p) => p.name),
      products.map((p) => p.description),
      products.map((p) => p.categoryId),
      products.map((p) => p.brandId),
      products.map((p) => p.isActive),
      products.map((p) => p.taxCategory),
    ],
  );
  await insertAuditRowsInTransaction(
    client,
    products.map((p, i) =>
      auditRow(ctx, {
        action: "catalog.product.create",
        targetType: PRODUCT_TARGET,
        targetId: ids[i] as string,
        storeId: null,
        metadata: {
          product_id: ids[i],
          new: { name: p.name, description: p.description, categoryId: p.categoryId, brandId: p.brandId, taxCategory: p.taxCategory, isActive: p.isActive },
          ...provenanceMetadata(p.provenance),
        },
      }),
    ),
  );
  // RT-1337: a new product can match a live offer's category or brand rule.
  await rebuildOfferPackForCatalogChanges(client, ctx.tenantId, {
    productIds: ids,
    categoryIds: products.map((p) => p.categoryId),
    brandIds: products.map((p) => p.brandId),
  });
  return ids;
}

/** A product to check, and (with a `patch`) to change. `expectedUpdatedAt` is epoch milliseconds. */
export interface ProductUpdate {
  readonly productId: string;
  readonly expectedUpdatedAt: number;
  /** The fields to set; absent = check only (an identifier-only import row keeps its product's precondition). */
  readonly patch?: { readonly [K in keyof ProductFields]?: ProductFields[K] | undefined } | undefined;
  readonly provenance?: ImportProvenance;
}

/** Locks the products and applies the single-product checks to each, in the write's order. */
async function checkProductUpdates(client: PoolClient, ctx: DomainContext, updates: readonly ProductUpdate[]): Promise<Map<string, LockedProduct>> {
  const locked = await lockProductsIn(client, ctx.tenantId, updates.map((u) => u.productId));
  const rows = updates.map((u) => ({ update: u, row: locked.get(u.productId) as LockedProduct }));
  for (const { row } of rows) if (row.retired) throw new CatalogWriteRefusedError("product_retired");
  for (const { update, row } of rows) requireExpected(row, { expectedUpdatedAt: update.expectedUpdatedAt });
  const patches = rows.flatMap(({ update }) => (update.patch === undefined ? [] : [update.patch]));
  await requireUsableCategories(client, ctx.tenantId, distinct(patches.map((p) => (typeof p.categoryId === "string" ? p.categoryId : null))));
  await requireUsableBrands(client, ctx.tenantId, distinct(patches.map((p) => (typeof p.brandId === "string" ? p.brandId : null))));
  for (const { update, row } of rows) if (update.patch !== undefined) requireAdvance(row);
  return locked;
}

const fieldsOf = (row: LockedProduct): ProductFields => ({
  name: row.name,
  description: row.description,
  categoryId: row.category_id,
  brandId: row.brand_id,
  taxCategory: row.tax_category,
  isActive: row.is_active,
});

/**
 * Checks every product (exists, not retired, `updated_at` as expected) and applies each patch. Audited
 * `catalog.product.update`. Two updates of one product are one update: the caller merges them first.
 */
export async function updateProductsIn(client: PoolClient, ctx: DomainContext, updates: readonly ProductUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  if (new Set(updates.map((u) => u.productId)).size !== updates.length) throw new Error("a product appears twice in one update batch");
  const locked = await checkProductUpdates(client, ctx, updates);
  const writes = updates.flatMap((u) => {
    if (u.patch === undefined) return [];
    const before = fieldsOf(locked.get(u.productId) as LockedProduct);
    return [{ update: u, before, after: applyPatch(before, u.patch) }];
  });
  if (writes.length === 0) return;
  await client.query(
    `UPDATE tenant_products p
        SET name = x.name, description = x.description, category_id = x.category_id, brand_id = x.brand_id,
            tax_category = x.tax_category, is_active = x.is_active, updated_by = $2::uuid, correlation_id = $3::uuid
       FROM unnest($4::uuid[], $5::text[], $6::text[], $7::uuid[], $8::uuid[], $9::text[], $10::boolean[])
            AS x(id, name, description, category_id, brand_id, tax_category, is_active)
      WHERE p.tenant_id = $1::uuid AND p.id = x.id`,
    [
      ctx.tenantId,
      ctx.actorUserId,
      ctx.requestId,
      writes.map((w) => w.update.productId),
      writes.map((w) => w.after.name),
      writes.map((w) => w.after.description),
      writes.map((w) => w.after.categoryId),
      writes.map((w) => w.after.brandId),
      writes.map((w) => w.after.taxCategory),
      writes.map((w) => w.after.isActive),
    ],
  );
  await insertAuditRowsInTransaction(
    client,
    writes.map((w) =>
      auditRow(ctx, {
        action: "catalog.product.update",
        targetType: PRODUCT_TARGET,
        targetId: w.update.productId,
        storeId: null,
        metadata: { product_id: w.update.productId, ...changes(w.before, w.after), ...provenanceMetadata(w.update.provenance) },
      }),
    ),
  );
  // RT-1337: a category, brand or active change can move a product into or out of a live offer's set.
  await rebuildOfferPackForCatalogChanges(client, ctx.tenantId, {
    productIds: writes.map((w) => w.update.productId),
    categoryIds: writes.flatMap((w) => [w.before.categoryId, w.after.categoryId]),
    brandIds: writes.flatMap((w) => [w.before.brandId, w.after.brandId]),
  });
}

/** An identifier to add to a product (the contract's identifier key, plus the product). */
export interface NewIdentifier {
  readonly productId: string;
  readonly identifierType: string;
  readonly value: string;
  readonly storeId: string | null;
  readonly sourceSystem: string | null;
  readonly provenance?: ImportProvenance;
}

/**
 * New active identifiers on products the caller has checked (live, locked); a value already active in its scope is
 * `alias_conflict` (one of the partial unique indexes: the code never says which, FR-042). Audited
 * `catalog.product_identifier.add`.
 */
export async function insertIdentifiersIn(client: PoolClient, ctx: DomainContext, identifiers: readonly NewIdentifier[]): Promise<void> {
  if (identifiers.length === 0) return;
  const ids = identifiers.map(() => newId());
  try {
    await client.query(
      `INSERT INTO product_aliases
         (id, tenant_id, product_id, identifier_type, value, source_system, store_id, created_by, correlation_id)
       SELECT x.id, $1::uuid, x.product_id, x.identifier_type, x.value, x.source_system, x.store_id, $2::uuid, $3::uuid
         FROM unnest($4::uuid[], $5::uuid[], $6::text[], $7::text[], $8::text[], $9::uuid[])
              AS x(id, product_id, identifier_type, value, source_system, store_id)`,
      [
        ctx.tenantId,
        ctx.actorUserId,
        ctx.requestId,
        ids,
        identifiers.map((i) => i.productId),
        identifiers.map((i) => i.identifierType),
        identifiers.map((i) => i.value),
        identifiers.map((i) => i.sourceSystem),
        identifiers.map((i) => i.storeId),
      ],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new CatalogWriteRefusedError("alias_conflict");
    throw err;
  }
  await insertAuditRowsInTransaction(
    client,
    identifiers.map((i, n) =>
      auditRow(ctx, {
        action: "catalog.product_identifier.add",
        targetType: IDENTIFIER_TARGET,
        targetId: ids[n] as string,
        storeId: i.storeId,
        metadata: {
          product_id: i.productId,
          identifier_type: i.identifierType,
          value: i.value,
          store_id: i.storeId,
          source_system: i.sourceSystem,
          ...provenanceMetadata(i.provenance),
        },
      }),
    ),
  );
}

/** A brand to create. */
export interface NewBrand {
  readonly name: string;
  readonly provenance?: ImportProvenance;
}

/** New active brands; their ids, in order. A name an active brand holds is `brand_name_conflict`. Audited `catalog.brand.create`. */
export async function createBrandsIn(client: PoolClient, ctx: DomainContext, brands: readonly NewBrand[]): Promise<string[]> {
  if (brands.length === 0) return [];
  const ids = brands.map(() => newId());
  try {
    await client.query(
      `INSERT INTO tenant_product_brands (id, tenant_id, name, created_by)
       SELECT x.id, $1::uuid, x.name, $2::uuid FROM unnest($3::uuid[], $4::text[]) AS x(id, name)`,
      [ctx.tenantId, ctx.actorUserId, ids, brands.map((b) => b.name)],
    );
  } catch (err) {
    if (isBrandNameConflict(err)) throw new CatalogWriteRefusedError("brand_name_conflict");
    throw err;
  }
  await insertAuditRowsInTransaction(
    client,
    brands.map((b, i) =>
      auditRow(ctx, {
        action: "catalog.brand.create",
        targetType: BRAND_TARGET,
        targetId: ids[i] as string,
        storeId: null,
        metadata: { brand_id: ids[i], new: { name: b.name }, ...provenanceMetadata(b.provenance) },
      }),
    ),
  );
  return ids;
}
