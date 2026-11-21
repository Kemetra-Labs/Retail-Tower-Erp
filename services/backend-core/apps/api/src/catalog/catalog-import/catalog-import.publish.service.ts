/**
 * CatalogImportPublishService — RT-1507 (spec 049 slice S5): `consolePublishCatalogImport`.
 *
 * ONE database transaction under the tenant's RLS context, serialised per tenant by an advisory lock (spec 049 8.2), in the
 * contract's order of checks, each stopping the call:
 *   404 (the batch); a `published` batch answers `200` with its stored summary when the `previewHash` is the batch's (a
 *   replay under a new key) and `409 import_batch_closed` otherwise; `import_batch_closed` (cancelled, expired or lapsed);
 *   `version_conflict`; `import_batch_not_validated` (a `draft`); `preview_changed` (the hash is not the batch's);
 *   `import_not_publishable` (a row still `needs_review` or `error`); the stale re-check (every matched product's
 *   `updatedAt`, every identifier to add still free, every category and brand still active, every brand to create still
 *   absent) -> `409 stale_validation`.
 * Then every write, through the SAME domain functions as the single-product console writes
 * (`console-catalog.domain.ts`): the brands, the products (create, then update), the identifiers, the audit rows
 * (`import_batch_id` and the source row number on each), the rows' `product_id` and the batch's own `published` transition
 * with its summary. The updates are conditional (`expectedUpdatedAt`) and the inserts rely on the unique indexes, so a
 * race with a single-product edit or an identifier claim rolls the whole transaction back and is answered `409
 * stale_validation`, never a 500; the batch then returns to `draft` at the next version in a second transaction. Any other
 * failure rolls everything back and nothing is written.
 *
 * No price is written and there is no approval step (OD-2, OD-12: the hook is reserved). The brand, category and product
 * names come from the staged rows through the same parse validate used.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../database";
import { CatalogWriteRefusedError } from "../console-catalog/console-catalog.refusal";
import {
  createBrandsIn,
  createProductsIn,
  insertIdentifiersIn,
  lockProductsIn,
  RerunWrite,
  updateProductsIn,
  type DomainContext,
  type ImportProvenance,
  type NewProduct,
  type ProductUpdate,
} from "../console-catalog/console-catalog.domain";
import { CatalogProductNotFoundError } from "../console-catalog/console-catalog.service";
import { toBatchBody, type BatchRow, type CatalogImportBatchBody } from "./catalog-import.projections";
import {
  activeIdsByName,
  catalogueChanged,
  loadPlanRows,
  lockTenantPublish,
  markBatchPublished,
  markBatchStale,
  readPublishSummary,
  setRowProducts,
  type CatalogueExpectations,
  type LoadedPlanRow,
} from "./catalog-import.publish-repository";
import { inTenant, ImportBatchNotFoundError, writeBatchAudit, type ImportWriteInput } from "./catalog-import.service";
import { lockBatch } from "./catalog-import.validate-repository";
import { ImportBatchRefusedError } from "./import-batch-refusal";
import type { ColumnMapping } from "./import-mapping";
import { explicitValues } from "./import-explicit-values";
import { planPublish, summaryOf, type PlannedUpdate, type PublishPlan } from "./import-publish-plan";
import type { PublishBody } from "./import-resolve-body";
import { parseRows, type ParsedRow } from "./import-row-parse";

/** The contract's `CatalogImportPublishResult`. */
export interface PublishResultBody {
  readonly batch: CatalogImportBatchBody;
  readonly summary: Record<string, number>;
}

/** The result, and whether it is a replay of an already published batch (`Idempotent-Replayed: true`). */
export interface PublishOutcome {
  readonly body: PublishResultBody;
  readonly replayed: boolean;
}

/** The catalogue is no longer what the batch was validated against (rolls the transaction back). */
class StaleValidationSignal extends Error {
  constructor() {
    super("stale validation");
    this.name = "StaleValidationSignal";
  }
}

/** The domain refusals a concurrent single-product write or identifier claim can cause between validate and publish. */
const STALE_CODES: ReadonlySet<string> = new Set(["stale_write", "product_retired", "alias_conflict", "category_unavailable", "brand_unavailable", "brand_name_conflict"]);

/** SQLSTATE of a deadlock and of a serialization failure: a concurrent write won, so the validation is stale (never a 500). */
const CONTENTION_SQLSTATES: ReadonlySet<string> = new Set(["40P01", "40001"]);

function isStale(err: unknown): boolean {
  if (err instanceof StaleValidationSignal || err instanceof RerunWrite || err instanceof CatalogProductNotFoundError) return true;
  if (err instanceof CatalogWriteRefusedError) return STALE_CODES.has(err.code);
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && CONTENTION_SQLSTATES.has(code);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The values of a product a `ready_create` row creates (re-parsed from its staged cells, as validate did). */
interface CreateValues {
  readonly rowNumber: number;
  readonly parsed: ParsedRow;
  readonly adds: ReadonlyArray<{ readonly type: string; readonly value: string }>;
}

function createValuesOf(batch: BatchRow, rows: readonly LoadedPlanRow[], plan: PublishPlan): CreateValues[] {
  const creating = rows.filter((r) => r.status === "ready_create");
  const parsed = parseRows(batch.mapping as ColumnMapping[], creating.map((r) => ({ rowNumber: r.rowNumber, cells: r.cells ?? [] })));
  return plan.creates.map((c, i) => ({ rowNumber: c.rowNumber, parsed: parsed[i] as ParsedRow, adds: c.adds }));
}

/** The category and brand names the writes reference, so the stale re-check and the id lookups see the same sets. */
function referencedNames(plan: PublishPlan, creates: readonly CreateValues[]): { categories: string[]; existingBrands: string[] } {
  const categories = new Set<string>();
  const brands = new Set<string>();
  for (const c of creates) {
    if (c.parsed.category !== null) categories.add(c.parsed.category.value);
    if (c.parsed.brand !== null) brands.add(c.parsed.brand.value);
  }
  for (const u of plan.updates) {
    for (const change of u.changes) {
      if (change.field === "category" && change.after !== null) categories.add(change.after);
      if (change.field === "brand" && change.after !== null) brands.add(change.after);
    }
  }
  for (const b of plan.brands) brands.delete(b.name);
  return { categories: [...categories], existingBrands: [...brands] };
}

function expectationsOf(plan: PublishPlan, creates: readonly CreateValues[]): CatalogueExpectations {
  const names = referencedNames(plan, creates);
  return {
    products: plan.updates.map((u) => ({ productId: u.productId, matchedText: u.matchedText })),
    identifiers: [...creates.flatMap((c) => c.adds), ...plan.updates.flatMap((u) => u.adds)].map((i) => ({ type: i.type as "sku" | "barcode" | "plu", value: i.value })),
    categories: names.categories,
    existingBrands: names.existingBrands,
    newBrands: plan.brands.map((b) => b.name),
    skuReceivers: plan.updates.filter((u) => u.adds.some((a) => a.type === "sku")).map((u) => u.productId),
  };
}

/** The product patch of a planned update: the field changes, category and brand by id. */
function patchOf(update: PlannedUpdate, categoryIds: ReadonlyMap<string, string>, brandIds: ReadonlyMap<string, string>): NonNullable<ProductUpdate["patch"]> {
  const patch: Record<string, unknown> = {};
  for (const c of update.changes) {
    if (c.field === "name") patch["name"] = c.after;
    else if (c.field === "description") patch["description"] = c.after;
    else if (c.field === "tax_category") patch["taxCategory"] = c.after;
    else if (c.field === "is_active") patch["isActive"] = c.after === "true";
    else if (c.field === "category") patch["categoryId"] = idOf(categoryIds, c.after);
    else patch["brandId"] = idOf(brandIds, c.after);
  }
  return patch;
}

/** The id of an active category or brand the stale re-check confirmed; a vanished one is a stale validation. */
function idOf(ids: ReadonlyMap<string, string>, name: string | null): string | null {
  if (name === null) return null;
  const id = ids.get(name);
  if (id === undefined) throw new StaleValidationSignal();
  return id;
}

@Injectable()
export class CatalogImportPublishService {
  private readonly logger = new Logger(CatalogImportPublishService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Publishes the validated, publishable batch in one transaction; see the file header. */
  async publish(input: ImportWriteInput, batchId: string, body: PublishBody): Promise<PublishOutcome> {
    try {
      return await inTenant(this.pool, input.tenantId, (client) => this.attempt(client, input, batchId, body));
    } catch (err) {
      if (!isStale(err)) throw err;
      // The attempt rolled back. The batch returns to draft (only if it is still the validated batch at this version); if that
      // second transaction fails the answer is still the stale refusal (the batch stays validated, and a retry is refused again).
      await inTenant(this.pool, input.tenantId, (client) => markBatchStale(client, input.tenantId, batchId, body.expectedVersion)).catch((e: unknown) => {
        this.logger.error(`could not return import batch ${batchId} to draft after a stale publish: ${e instanceof Error ? e.message : String(e)}`);
      });
      throw new ImportBatchRefusedError("stale_validation");
    }
  }

  private async attempt(client: PoolClient, input: ImportWriteInput, batchId: string, body: PublishBody): Promise<PublishOutcome> {
    await lockTenantPublish(client, input.tenantId);
    const batch = await lockBatch(client, input.tenantId, batchId);
    if (batch === null) throw new ImportBatchNotFoundError();
    if (batch.state === "published") return this.replay(client, input.tenantId, batch, body);
    if ((batch.state !== "draft" && batch.state !== "validated") || batch.past_expiry) throw new ImportBatchRefusedError("import_batch_closed");
    if (batch.version !== body.expectedVersion) throw new ImportBatchRefusedError("version_conflict");
    if (batch.state !== "validated") throw new ImportBatchRefusedError("import_batch_not_validated");
    if (batch.preview_hash !== body.previewHash) throw new ImportBatchRefusedError("preview_changed");
    const rows = await loadPlanRows(client, input.tenantId, batchId, true);
    if (rows.some((r) => r.status === "needs_review" || r.status === "error")) throw new ImportBatchRefusedError("import_not_publishable");
    const plan = planPublish(rows, await explicitValues(client, input.tenantId, batch, rows));
    if (plan.conflictingProducts.length > 0) throw new ImportBatchRefusedError("import_not_publishable");
    if (plan.staleProducts.length > 0) throw new StaleValidationSignal();
    // Lock every product the publish updates BEFORE anything can take the tenant offers lock (the catalog hook of the creates):
    // a console edit or retire locks the product first and the offers lock second, so the reverse order here would deadlock.
    // In id order, as every batch lock does.
    await lockProductsIn(client, input.tenantId, plan.updates.map((u) => u.productId));
    const creates = createValuesOf(batch, rows, plan);
    if (await catalogueChanged(client, input.tenantId, expectationsOf(plan, creates))) throw new StaleValidationSignal();
    return { body: await this.write(client, input, batch, plan, creates), replayed: false };
  }

  /** A `published` batch: its stored result for its own `previewHash`, `409 import_batch_closed` for any other. */
  private async replay(client: PoolClient, tenantId: string, batch: BatchRow, body: PublishBody): Promise<PublishOutcome> {
    if (batch.preview_hash !== body.previewHash) throw new ImportBatchRefusedError("import_batch_closed");
    const summary = await readPublishSummary(client, tenantId, batch.id);
    return { body: { batch: toBatchBody(batch), summary: summary ?? {} }, replayed: true };
  }

  /** Every write of the publish, on the transaction's client. */
  private async write(client: PoolClient, input: ImportWriteInput, batch: BatchRow, plan: PublishPlan, creates: readonly CreateValues[]): Promise<PublishResultBody> {
    const ctx: DomainContext = {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      requestId: input.requestId !== null && UUID_RE.test(input.requestId) ? input.requestId : null,
    };
    const provenance = (rowNumber: number): ImportProvenance => ({ importBatchId: batch.id, rowNumber });
    const newBrandIds = await createBrandsIn(client, ctx, plan.brands.map((b) => ({ name: b.name, provenance: provenance(b.rowNumber) })));
    const names = referencedNames(plan, creates);
    const categoryIds = await activeIdsByName(client, "tenant_product_categories", input.tenantId, names.categories);
    const brandIds = await activeIdsByName(client, "tenant_product_brands", input.tenantId, names.existingBrands);
    plan.brands.forEach((b, i) => brandIds.set(b.name, newBrandIds[i] as string));

    const products: NewProduct[] = creates.map((c) => ({
      name: c.parsed.name?.value as string,
      description: c.parsed.description?.value ?? null,
      categoryId: idOf(categoryIds, c.parsed.category?.value ?? null),
      brandId: idOf(brandIds, c.parsed.brand?.value ?? null),
      taxCategory: c.parsed.taxCategory?.value as string,
      isActive: c.parsed.isActive?.value ?? true,
      provenance: provenance(c.rowNumber),
    }));
    const createdIds = await createProductsIn(client, ctx, products);
    await updateProductsIn(
      client,
      ctx,
      plan.updates.map((u) => ({
        productId: u.productId,
        expectedUpdatedAt: Number(u.matchedMs),
        patch: u.changes.length === 0 ? undefined : patchOf(u, categoryIds, brandIds),
        provenance: provenance(u.rowNumbers[0] as number),
      })),
    );
    await insertIdentifiersIn(client, ctx, [
      ...creates.flatMap((c, i) => c.adds.map((a) => ({ productId: createdIds[i] as string, identifierType: a.type, value: a.value, storeId: null, sourceSystem: null, provenance: provenance(c.rowNumber) }))),
      ...plan.updates.flatMap((u) => u.adds.map((a) => ({ productId: u.productId, identifierType: a.type, value: a.value, storeId: null, sourceSystem: null, provenance: provenance(a.rowNumber) }))),
    ]);
    await setRowProducts(client, input.tenantId, batch.id, [
      ...creates.map((c, i) => ({ rowNumber: c.rowNumber, productId: createdIds[i] as string })),
      ...plan.updates.flatMap((u) => u.rowNumbers.map((rowNumber) => ({ rowNumber, productId: u.productId }))),
    ]);
    const summary = summaryOf(plan);
    const published = await markBatchPublished(client, input.tenantId, batch.id, summary);
    await writeBatchAudit(client, input, "catalog.import.publish", published, { summary });
    return { batch: toBatchBody(published), summary };
  }
}
