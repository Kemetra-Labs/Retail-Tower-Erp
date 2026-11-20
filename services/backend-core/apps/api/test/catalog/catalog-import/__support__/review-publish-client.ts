/**
 * RT-1507 — a small HTTP client over the scoped harness for the review / preview / publish / cancel specs, and the
 * database reads they check. `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import type { Pool } from "pg";
import type request from "supertest";

import type { ScopedHttpHarness } from "../../../_helpers/scoped-http-harness";
import { SES_OWNER_ALL } from "../../erpnext-reconciliation/__support__/read-store-scope";
import { TENANT_A } from "../../__support__/isolation-harness";
import { CAT_DRINKS } from "../../console-catalog/__support__/console-catalog-fixture";

export const IMPORTS = "/api/v1/catalog/imports";
export const OWNER_A_USER = "0a000000-0000-7000-8000-0000019202a3";
const ACTOR = "0a000000-0000-7000-8000-0000001507e1";

export interface Batch {
  batchId: string;
  state: string;
  version: number;
  mode: string;
  mapping: Array<{ columnNumber: number; target: string }> | null;
  suggestedMapping: Array<{ columnNumber: number; target: string }>;
  columns: Array<{ columnNumber: number; header: string; samples: string[] }>;
  counts: Record<string, number> | null;
  previewHash: string | null;
  publishable: boolean;
  expiresAt: string | null;
  publishedAt: string | null;
}

export interface ProductRef {
  productId: string;
  name: string;
  identifiers: Array<{ type: string; value: string }>;
}

export interface RowBody {
  rowNumber: number;
  status: string;
  cells: Array<string | null>;
  reviewReason: string | null;
  productId: string | null;
  resolution: { action: string; productId: string | null; decidedAt: string } | null;
  issues: Array<{ code: string; severity: string; field: string | null }>;
  outcome: {
    match: string;
    matchedProduct: ProductRef | null;
    candidates: Array<{ productId: string }>;
    fieldChanges: Array<{ field: string; before: string | null; after: string | null }>;
    identifierAdds: Array<{ type: string; value: string }>;
    identifiersNotAdded: Array<{ type: string; value: string }>;
    brandToCreate: string | null;
  };
}

export interface Preview {
  batchId: string;
  version: number;
  previewHash: string;
  mode: string;
  publishable: boolean;
  counts: Record<string, number>;
  brandsToCreate: string[];
  productsToCreate: number;
  productsToUpdate: number;
  identifiersToAdd: number;
  deactivations: Array<{ rowNumber: number; product: ProductRef }>;
  newProductsWithoutPrice: number;
  rowsWithPriceNotImported: number;
}

export interface Summary {
  brandsCreated: number;
  productsCreated: number;
  productsUpdated: number;
  identifiersAdded: number;
  productsDeactivated: number;
  rowsUnchanged: number;
  rowsExcluded: number;
}

let seq = 0;
export const newKey = (): string => {
  seq += 1;
  return `rt1507-key-${String(seq).padStart(8, "0")}-${Date.now()}`;
};

/** The raw bytes of a CSV as an upload body. */
const csvOf = (text: string): Buffer => Buffer.from(text, "utf8");

/** The client of one harness. */
export function importClient(h: ScopedHttpHarness): {
  open(text: string | Buffer, mode?: string, session?: string): Promise<Batch>;
  validated(text: string, mode?: string): Promise<Batch>;
  allRows(id: string, status?: string): Promise<RowBody[]>;
  resolve(session: string | null, id: string, row: number, body: object): request.Test;
  preview(session: string | null, id: string): request.Test;
  publish(session: string | null, id: string, body: object, key?: string): request.Test;
  cancel(session: string | null, id: string, expectedVersion: number): request.Test;
  validate(session: string | null, id: string, expectedVersion: number): request.Test;
  expectError(res: request.Response, status: number, code: string): void;
} {
  const upload = (session: string | null, bytes: Buffer, mode: string): request.Test =>
    h
      .post(`${IMPORTS}?mode=${mode}`, session, bytes)
      .set("Content-Type", "application/octet-stream")
      .serialize((body: unknown) => body as string)
      .set("Origin", "http://127.0.0.1")
      .set("Idempotency-Key", newKey());
  const validate = (session: string | null, id: string, expectedVersion: number): request.Test => h.post(`${IMPORTS}/${id}/validate`, session, { expectedVersion });
  const open = async (text: string | Buffer, mode = "upsert", session = SES_OWNER_ALL): Promise<Batch> =>
    (await upload(session, typeof text === "string" ? csvOf(text) : text, mode).expect(201)).body as Batch;
  return {
    open,
    validate,
    async validated(text, mode = "upsert") {
      const batch = await open(text, mode);
      await h.put(`${IMPORTS}/${batch.batchId}/mapping`, SES_OWNER_ALL, { expectedVersion: 1, columns: batch.suggestedMapping }).expect(200);
      return (await validate(SES_OWNER_ALL, batch.batchId, 2).expect(200)).body as Batch;
    },
    async allRows(id, status) {
      const out: RowBody[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 100; page += 1) {
        const query: Record<string, string | number> = { limit: 200 };
        if (status !== undefined) query["status"] = status;
        if (cursor !== undefined) query["cursor"] = cursor;
        const res = await h.get(`${IMPORTS}/${id}/rows`, SES_OWNER_ALL, query).expect(200);
        out.push(...(res.body.items as RowBody[]));
        if (res.body.nextCursor === null) return out;
        cursor = res.body.nextCursor as string;
      }
      throw new Error("row list did not end");
    },
    resolve: (session, id, row, body) => h.put(`${IMPORTS}/${id}/rows/${row}/resolution`, session, body),
    preview: (session, id) => h.get(`${IMPORTS}/${id}/preview`, session),
    publish: (session, id, body, key = newKey()) => h.post(`${IMPORTS}/${id}/publish`, session, body).set("Idempotency-Key", key),
    cancel: (session, id, expectedVersion) => h.post(`${IMPORTS}/${id}/cancel`, session, { expectedVersion }),
    expectError(res, status, code) {
      expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
      h.conforms("Error", res.body);
    },
  };
}

/** A product of tenant A with a SKU (and optionally a barcode), for the specs that publish and must not disturb the shared fixture. */
export async function seedProductA(
  admin: Pool,
  p: { name: string; sku?: string; barcode?: string; barcodes?: string[]; categoryId?: string | null; active?: boolean },
): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO tenant_products (id, tenant_id, name, category_id, is_active, tax_category, created_by, updated_by)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'standard', $5, $5) RETURNING id::text AS id`,
    [TENANT_A, p.name, p.categoryId ?? null, p.active ?? true, ACTOR],
  );
  const id = (r.rows[0] as { id: string }).id;
  const alias = (type: string, value: string): Promise<unknown> =>
    admin.query(`INSERT INTO product_aliases (tenant_id, product_id, identifier_type, value, created_by) VALUES ($1, $2, $3, $4, $5)`, [TENANT_A, id, type, value, ACTOR]);
  if (p.sku !== undefined) await alias("sku", p.sku);
  for (const barcode of [...(p.barcode === undefined ? [] : [p.barcode]), ...(p.barcodes ?? [])]) await alias("barcode", barcode);
  return id;
}

export const DRINKS = CAT_DRINKS;

/** Every audit row of an action for tenant A since `since`, in order. */
export async function auditsOf(admin: Pool, action: string, since: Date): Promise<Array<{ target_id: string; actor_user_id: string | null; metadata: Record<string, unknown> }>> {
  const r = await admin.query(
    `SELECT target_id::text AS target_id, actor_user_id::text AS actor_user_id, metadata
       FROM audit_events WHERE tenant_id = $1 AND action = $2 AND occurred_at >= $3 ORDER BY occurred_at, id`,
    [TENANT_A, action, since],
  );
  return r.rows;
}

/** The raw state of one batch row. */
export async function batchRow(admin: Pool, id: string): Promise<{ state: string; version: number; preview_hash: string | null; counts: unknown; publish_summary: unknown; expires_at: Date | null; closed_at: Date | null; published_at: Date | null }> {
  const r = await admin.query(`SELECT state, version, preview_hash, counts, publish_summary, expires_at, closed_at, published_at FROM catalog_import_batches WHERE id = $1`, [id]);
  return r.rows[0];
}

/** Wipes the imports of both tenants between tests (the batches' delete trigger is disabled around it). */
export async function resetImports(admin: Pool): Promise<void> {
  await admin.query(`UPDATE catalog_import_batches SET state = 'cancelled', closed_at = now(), expires_at = NULL, preview_hash = NULL WHERE state IN ('draft', 'validated')`);
  await admin.query(`DELETE FROM catalog_import_rows`);
  await admin.query(`ALTER TABLE catalog_import_batches DISABLE TRIGGER catalog_import_batches_no_delete_row`);
  await admin.query(`DELETE FROM catalog_import_batches`);
  await admin.query(`ALTER TABLE catalog_import_batches ENABLE TRIGGER catalog_import_batches_no_delete_row`);
  await admin.query(`DELETE FROM catalog_import_mapping_profiles`);
}
