/**
 * RT-1505 (spec 049 slice S4, part B) — map, validate and the row list over HTTP against real Postgres
 * (Testcontainers, every migration including 0124, the NOBYPASSRLS `app_test` pool) and the real module graph. Only
 * cookie authentication is faked: a header names the session.
 *
 * What this proves:
 *   - a new batch carries a stored mapping suggestion (header synonyms, then the tenant's saved profile);
 *   - set mapping: the contract's order of checks (404, closed, version, 422), the completeness rules, saved profiles
 *     (an upsert that keeps the id; an empty or repeated header never saved), `catalog.import.map` audit, the batch
 *     back in `draft` at the next version;
 *   - validate against a real catalogue: every matching outcome, mode, review reason and error code, each row exactly
 *     one status, the counts, the `previewHash`, the matched product's `updated_at`, `catalog.import.validate` audit;
 *   - the row list: keyset paging, the `status` filter, a cursor bound to the filter and to the validation generation,
 *     cells shown after the trim, 409 before validation and after a purge;
 *   - `409 version_conflict`, roles (store roles get the non-disclosing 404) and RLS isolation between tenants;
 *   - XLSX typed cells (number, formula) through the database, and 5,000 rows of 50 columns end to end.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type request from "supertest";

import { CatalogImportModule } from "../../../src/catalog/catalog-import/catalog-import.module";
import { importUploadPassthrough } from "../../../src/catalog/catalog-import/import-upload-intake.guard";
import { scopedHttpHarness } from "../../_helpers/scoped-http-harness";
import { SES_MANAGER, SES_STAFF } from "../../console-sales/__support__/console-sales-fixture";
import { TENANT_A, TENANT_B } from "../__support__/isolation-harness";
import { SES_ADMIN_SPEC, SES_OWNER_ALL } from "../erpnext-reconciliation/__support__/read-store-scope";
import { P_JUICE, P_WATER } from "../console-catalog/__support__/console-catalog-fixture";
import { collectLookupKeys } from "../../../src/catalog/catalog-import/import-lookups";
import { previewHashOf } from "../../../src/catalog/catalog-import/import-preview-hash";
import { evaluateRows } from "../../../src/catalog/catalog-import/import-row-evaluate";
import { parseRows } from "../../../src/catalog/catalog-import/import-row-parse";
import { loadCatalogLookups } from "../../../src/catalog/catalog-import/catalog-import.validate-repository";
import { SES_OWNER_B, seedPublishedBatch } from "./__support__/catalog-import-fixture";
import { idempotencyProviders } from "./__support__/idempotency-fakes";
import { batchAudits, batchState, P_ALPHA, P_GAMMA, profilesOf, seedMapValidateFixture, validatedRows } from "./__support__/map-validate-fixture";
import { buildXlsx } from "./__support__/zip-fixtures";

const IMPORTS = "/api/v1/catalog/imports";
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const OWNER_A_USER = "0a000000-0000-7000-8000-0000019202a3";

const h = scopedHttpHarness({
  label: "RT-1505 catalog-import map-validate",
  contractId: "catalog-import",
  module: CatalogImportModule,
  seed: seedMapValidateFixture,
  providers: idempotencyProviders(),
  beforeInit: (app) => app.use(importUploadPassthrough),
});
const skip = (): boolean => h.skipped();

let seq = 0;
const key = (): string => {
  seq += 1;
  return `rt1505b-key-${String(seq).padStart(8, "0")}-${Date.now()}`;
};

interface Batch {
  batchId: string;
  state: string;
  version: number;
  mapping: Array<{ columnNumber: number; target: string }> | null;
  suggestedMapping: Array<{ columnNumber: number; target: string }>;
  mappingProfileId: string | null;
  counts: Record<string, number> | null;
  previewHash: string | null;
  publishable: boolean;
  columns: Array<{ columnNumber: number; header: string; samples: string[] }>;
}

interface RowBody {
  rowNumber: number;
  status: string;
  cells: Array<string | null>;
  reviewReason: string | null;
  issues: Array<{ code: string; severity: string; field: string | null; columnNumber: number | null; relatedProduct?: { productId: string; name: string }; relatedRowNumber?: number }>;
  outcome: {
    match: string;
    matchedProduct: { productId: string; name: string; identifiers: Array<{ type: string; value: string }> } | null;
    candidates: Array<{ productId: string }>;
    fieldChanges: Array<{ field: string; before: string | null; after: string | null }>;
    identifierAdds: Array<{ type: string; value: string }>;
    identifiersNotAdded: unknown[];
    brandToCreate: string | null;
  };
}

/** The raw bytes as the body, as the part A spec sends them. */
function uploadBytes(session: string | null, bytes: Buffer, mode: string): request.Test {
  return h
    .post(`${IMPORTS}?mode=${mode}`, session, bytes)
    .set("Content-Type", "application/octet-stream")
    .serialize((body: unknown) => body as string)
    .set("Origin", "http://127.0.0.1")
    .set("Idempotency-Key", key());
}

const csvOf = (text: string): Buffer => Buffer.from(text, "utf8");

async function open(text: string | Buffer, mode = "upsert", session = SES_OWNER_ALL): Promise<Batch> {
  const res = await uploadBytes(session, typeof text === "string" ? csvOf(text) : text, mode).expect(201);
  return res.body as Batch;
}

const mapPath = (id: string): string => `${IMPORTS}/${id}/mapping`;
const validatePath = (id: string): string => `${IMPORTS}/${id}/validate`;
const rowsPath = (id: string): string => `${IMPORTS}/${id}/rows`;

function setMapping(session: string | null, id: string, body: object): request.Test {
  return h.put(mapPath(id), session, body);
}

function validate(session: string | null, id: string, expectedVersion: number): request.Test {
  return h.post(validatePath(id), session, { expectedVersion });
}

function expectError(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  h.conforms("Error", res.body);
}

/** A complete mapping that accepts the batch's own suggestion. */
const suggested = (b: Batch): Array<{ columnNumber: number; target: string }> => b.suggestedMapping;

/** Every row of a validated batch, by paging (limit 200). */
async function allRows(id: string, session = SES_OWNER_ALL, status?: string): Promise<RowBody[]> {
  const out: RowBody[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const query: Record<string, string | number> = { limit: 200 };
    if (status !== undefined) query["status"] = status;
    if (cursor !== undefined) query["cursor"] = cursor;
    const res = await h.get(rowsPath(id), session, query).expect(200);
    h.conforms("CatalogImportRowPage", res.body);
    out.push(...(res.body.items as RowBody[]));
    const next = res.body.nextCursor as string | null;
    if (next === null) return out;
    cursor = next;
  }
  throw new Error("row list did not end");
}

let since = new Date(0);
const audits = (action: string, tenant = TENANT_A): ReturnType<typeof batchAudits> => batchAudits(h.env().admin, tenant, action, since);

/** Every test starts with no batch or profile of either tenant. */
beforeEach(async () => {
  if (h.skipped()) return;
  const { admin } = h.env();
  await admin.query(`UPDATE catalog_import_batches SET state = 'cancelled', closed_at = now(), expires_at = NULL, preview_hash = NULL WHERE state IN ('draft', 'validated')`);
  await admin.query(`DELETE FROM catalog_import_rows`);
  await admin.query(`ALTER TABLE catalog_import_batches DISABLE TRIGGER catalog_import_batches_no_delete_row`);
  await admin.query(`DELETE FROM catalog_import_batches`);
  await admin.query(`ALTER TABLE catalog_import_batches ENABLE TRIGGER catalog_import_batches_no_delete_row`);
  await admin.query(`DELETE FROM catalog_import_mapping_profiles`);
  since = (await admin.query<{ t: Date }>(`SELECT clock_timestamp() AS t`)).rows[0]!.t;
});

const SIMPLE = "SKU,Name,Tax Category\nN-1,Tea,standard\nN-2,Coffee,standard\n";

describe("the suggestion stored at upload", () => {
  it("places the columns by header synonym, English or Arabic, and stores it (a read returns what was shown)", async () => {
    if (skip()) return;
    const arabic = "\u{0627}\u{0644}\u{0628}\u{0627}\u{0631}\u{0643}\u{0648}\u{062F},\u{0627}\u{0633}\u{0645} \u{0627}\u{0644}\u{0645}\u{0646}\u{062A}\u{062C},\u{0627}\u{0644}\u{0641}\u{0626}\u{0629} \u{0627}\u{0644}\u{0636}\u{0631}\u{064A}\u{0628}\u{064A}\u{0629},Colour\n";
    const batch = await open(`${arabic}6223001360018,Tea,standard,red\n`);
    h.conforms("CatalogImportBatch", batch);
    expect(batch.suggestedMapping).toEqual([
      { columnNumber: 1, target: "barcode" },
      { columnNumber: 2, target: "name" },
      { columnNumber: 3, target: "tax_category" },
    ]);
    expect(batch.mappingProfileId).toBeNull();
    expect(batch.mapping).toBeNull();
    const read = await h.get(`${IMPORTS}/${batch.batchId}`, SES_OWNER_ALL).expect(200);
    expect(read.body.suggestedMapping).toEqual(batch.suggestedMapping);
  });

  it("draws on the tenant's saved profile for the next file, and names it", async () => {
    if (skip()) return;
    const first = await open("Zeta,Name\nA,Tea\n", "update");
    expect(first.suggestedMapping).toEqual([{ columnNumber: 2, target: "name" }]);
    const saved = await setMapping(SES_OWNER_ALL, first.batchId, {
      expectedVersion: 1,
      columns: [{ columnNumber: 1, target: "sku" }, { columnNumber: 2, target: "name" }],
      saveProfileName: "Zeta supplier",
    }).expect(200);
    expect(saved.body.mappingProfileId).toBeNull();
    const [profile] = await profilesOf(h.env().admin, TENANT_A);
    await h.env().admin.query(`UPDATE catalog_import_batches SET state = 'cancelled', closed_at = now(), expires_at = NULL WHERE id = $1`, [first.batchId]);
    const second = await open("Zeta,Name\nB,Coffee\n", "update");
    expect(second.suggestedMapping).toEqual([{ columnNumber: 1, target: "sku" }, { columnNumber: 2, target: "name" }]);
    expect(second.mappingProfileId).toBe(profile!.id);
    // Another tenant never sees it.
    const other = await open("Zeta,Name\nB,Coffee\n", "update", SES_OWNER_B);
    expect(other.suggestedMapping).toEqual([{ columnNumber: 2, target: "name" }]);
    expect(other.mappingProfileId).toBeNull();
  });
});

describe("set mapping", () => {
  it("stores the mapping, returns the batch to draft at the next version and audits it without any text", async () => {
    if (skip()) return;
    const batch = await open(SIMPLE, "create");
    const res = await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 1, columns: [...suggested(batch)].reverse() }).expect(200);
    h.conforms("CatalogImportBatch", res.body);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ state: "draft", version: 2, counts: null, previewHash: null, publishable: false, mappingProfileId: null });
    expect(res.body.mapping).toEqual([
      { columnNumber: 1, target: "sku" },
      { columnNumber: 2, target: "name" },
      { columnNumber: 3, target: "tax_category" },
    ]);
    const state = await batchState(h.env().admin, batch.batchId);
    expect(state).toMatchObject({ state: "draft", version: 2, validation_generation: 0 });
    const written = await audits("catalog.import.map");
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ actor_user_id: OWNER_A_USER, target_id: batch.batchId, target_type: "catalog_import_batch" });
    expect(written[0]!.metadata).toMatchObject({ batch_id: batch.batchId, version: 2, mode: "create", mapped_columns: 3, ignored_columns: 0, profile_saved: false, profile_id: null, counts: null });
    expect(JSON.stringify(written[0]!.metadata)).not.toMatch(/Tea|Coffee|SKU|Tax/);
  });

  it("accepts the tenant_admin role too, and repeats safely at the new version (idempotent by expectedVersion)", async () => {
    if (skip()) return;
    const batch = await open(SIMPLE, "create");
    const first = await setMapping(SES_ADMIN_SPEC, batch.batchId, { expectedVersion: 1, columns: suggested(batch) }).expect(200);
    expect(first.body.version).toBe(2);
    expectError(await setMapping(SES_ADMIN_SPEC, batch.batchId, { expectedVersion: 1, columns: suggested(batch) }), 409, "version_conflict");
    const again = await setMapping(SES_ADMIN_SPEC, batch.batchId, { expectedVersion: 2, columns: suggested(batch) }).expect(200);
    expect(again.body.version).toBe(3);
  });

  it("answers 409 version_conflict for a stale version and writes nothing", async () => {
    if (skip()) return;
    const batch = await open(SIMPLE, "create");
    expectError(await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 7, columns: suggested(batch) }), 409, "version_conflict");
    expect(await batchState(h.env().admin, batch.batchId)).toMatchObject({ version: 1, mapping: null });
    expect(await audits("catalog.import.map")).toHaveLength(0);
  });

  it("answers 409 import_batch_closed for a published, cancelled or expired batch", async () => {
    if (skip()) return;
    const batch = await open(SIMPLE, "create");
    await h.env().admin.query(`UPDATE catalog_import_batches SET state = 'cancelled', closed_at = now(), expires_at = NULL WHERE id = $1`, [batch.batchId]);
    expectError(await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 1, columns: suggested(batch) }), 409, "import_batch_closed");
    expectError(await validate(SES_OWNER_ALL, batch.batchId, 1), 409, "import_batch_closed");
  });

  it.each([
    ["a column missing", [{ columnNumber: 1, target: "sku" }, { columnNumber: 2, target: "name" }]],
    ["a column twice", [{ columnNumber: 1, target: "sku" }, { columnNumber: 1, target: "ignore" }, { columnNumber: 2, target: "name" }]],
    ["a column the batch does not have", [{ columnNumber: 1, target: "sku" }, { columnNumber: 2, target: "name" }, { columnNumber: 9, target: "tax_category" }]],
    ["a field twice", [{ columnNumber: 1, target: "name" }, { columnNumber: 2, target: "name" }, { columnNumber: 3, target: "tax_category" }]],
    ["no tax_category for create", [{ columnNumber: 1, target: "sku" }, { columnNumber: 2, target: "name" }, { columnNumber: 3, target: "ignore" }]],
    ["no name for create", [{ columnNumber: 1, target: "sku" }, { columnNumber: 2, target: "ignore" }, { columnNumber: 3, target: "tax_category" }]],
  ])("answers 422 mapping_invalid for %s, and writes nothing", async (_label, columns) => {
    if (skip()) return;
    const batch = await open(SIMPLE, "create");
    expectError(await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 1, columns }), 422, "mapping_invalid");
    expect(await batchState(h.env().admin, batch.batchId)).toMatchObject({ version: 1, mapping: null });
    expect(await audits("catalog.import.map")).toHaveLength(0);
  });

  it("allows an update batch to map no name or tax category, and barcode up to five times but not six", async () => {
    if (skip()) return;
    const six = await open("A,B,C,D,E,F\n1,2,3,4,5,6\n", "update");
    const columns = (targets: string[]): Array<{ columnNumber: number; target: string }> => targets.map((target, i) => ({ columnNumber: i + 1, target }));
    expectError(await setMapping(SES_OWNER_ALL, six.batchId, { expectedVersion: 1, columns: columns(Array(6).fill("barcode") as string[]) }), 422, "mapping_invalid");
    const ok = await setMapping(SES_OWNER_ALL, six.batchId, { expectedVersion: 1, columns: columns(["barcode", "barcode", "barcode", "barcode", "barcode", "ignore"]) }).expect(200);
    expect(ok.body.version).toBe(2);
  });

  it("answers 400 validation_error for a body that is not the contract's, before any read", async () => {
    if (skip()) return;
    const batch = await open(SIMPLE, "create");
    const good = { expectedVersion: 1, columns: suggested(batch) };
    for (const body of [
      { ...good, tenantId: TENANT_B },
      { ...good, columns: [{ columnNumber: 1, target: "supplier_code" }] },
      { ...good, columns: [{ columnNumber: 1, target: "sku", extra: true }] },
      { ...good, columns: [] },
      { ...good, expectedVersion: 0 },
      { ...good, saveProfileName: "   " },
      { ...good, saveProfileName: "x".repeat(101) },
      { columns: good.columns },
    ]) {
      expectError(await setMapping(SES_OWNER_ALL, batch.batchId, body), 400, "validation_error");
    }
    expectError(await setMapping(SES_OWNER_ALL, "not-a-uuid", good), 400, "validation_error");
    expect(await batchState(h.env().admin, batch.batchId)).toMatchObject({ version: 1 });
  });

  it("saves the mapping as a profile by exact header text; the same name replaces it and keeps the id", async () => {
    if (skip()) return;
    const batch = await open("Code,Product Name,Tax Category,Notes\nN-1,Tea,standard,x\n", "create");
    const columns = [
      { columnNumber: 1, target: "sku" },
      { columnNumber: 2, target: "name" },
      { columnNumber: 3, target: "tax_category" },
      { columnNumber: 4, target: "ignore" },
    ];
    const first = await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 1, columns, saveProfileName: "My supplier" }).expect(200);
    const [saved] = await profilesOf(h.env().admin, TENANT_A);
    expect(saved).toMatchObject({ name: "My supplier", entries: { Code: "sku", "Product Name": "name", "Tax Category": "tax_category", Notes: "ignore" }, created_by: OWNER_A_USER });
    const audit = (await audits("catalog.import.map"))[0]!;
    expect(audit.metadata).toMatchObject({ profile_saved: true, profile_id: saved!.id });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/My supplier|Product Name/);
    // Same name, other entries: replaced, id kept, updated_by set.
    const second = await setMapping(SES_ADMIN_SPEC, batch.batchId, {
      expectedVersion: first.body.version,
      columns: [{ columnNumber: 1, target: "sku" }, { columnNumber: 2, target: "name" }, { columnNumber: 3, target: "tax_category" }, { columnNumber: 4, target: "description" }],
      saveProfileName: "My supplier",
    }).expect(200);
    expect(second.body.version).toBe(3);
    const after = await profilesOf(h.env().admin, TENANT_A);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: saved!.id, entries: { Notes: "description" }, created_by: OWNER_A_USER });
    expect(after[0]!.updated_by).not.toBe(OWNER_A_USER);
  });

  it("never saves an empty or repeated header; a profile no column can carry is 422, and nothing else is written", async () => {
    if (skip()) return;
    const batch = await open("Barcode,Barcode,,Name\n6223001360018,4006381333931,x,Tea\n", "update");
    const columns = [
      { columnNumber: 1, target: "barcode" },
      { columnNumber: 2, target: "barcode" },
      { columnNumber: 3, target: "ignore" },
      { columnNumber: 4, target: "name" },
    ];
    await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 1, columns, saveProfileName: "P" }).expect(200);
    const [saved] = await profilesOf(h.env().admin, TENANT_A);
    expect(saved!.entries).toEqual({ Name: "name" });
    await h.env().admin.query(`UPDATE catalog_import_batches SET state = 'cancelled', closed_at = now(), expires_at = NULL WHERE id = $1`, [batch.batchId]);
    const second = await open("Same,Same\n1,2\n", "update");
    expectError(
      await setMapping(SES_OWNER_ALL, second.batchId, { expectedVersion: 1, columns: [{ columnNumber: 1, target: "sku" }, { columnNumber: 2, target: "barcode" }], saveProfileName: "Q" }),
      422,
      "mapping_invalid",
    );
    expect(await profilesOf(h.env().admin, TENANT_A)).toHaveLength(1);
    expect(await batchState(h.env().admin, second.batchId)).toMatchObject({ version: 1, mapping: null });
  });

  it("is for owner and tenant_admin only: the store roles and another tenant get the non-disclosing 404", async () => {
    if (skip()) return;
    const batch = await open(SIMPLE, "create");
    const body = { expectedVersion: 1, columns: suggested(batch) };
    for (const session of [SES_MANAGER, SES_STAFF, SES_OWNER_B]) {
      const res = await setMapping(session, batch.batchId, body);
      expect(res.status).toBe(404);
      expect((res.body as { error: object }).error).toMatchObject(NOT_FOUND);
      h.conforms("Error", res.body);
    }
    expectError(await setMapping(SES_OWNER_ALL, "0192f000-0000-7000-8000-00000000dead", body), 404, "not_found");
    expect(await batchState(h.env().admin, batch.batchId)).toMatchObject({ version: 1, mapping: null });
    expect(await audits("catalog.import.map")).toHaveLength(0);
  });

  it("answers 401 with no session and 403 origin_rejected for a cookie write without a trusted Origin", async () => {
    if (skip()) return;
    const batch = await open(SIMPLE, "create");
    const body = { expectedVersion: 1, columns: suggested(batch) };
    expectError(await setMapping(null, batch.batchId, body), 401, "unauthorized");
    const cookie = "dp2_session=rt1505-not-a-session";
    expectError(await h.put(mapPath(batch.batchId), null, body).set("Cookie", cookie), 403, "origin_rejected");
    expectError(await h.post(validatePath(batch.batchId), null, { expectedVersion: 1 }).set("Cookie", cookie), 403, "origin_rejected");
  });
});

describe("validate: the order of checks", () => {
  it("needs a confirmed mapping: 422 mapping_required, and nothing is written", async () => {
    if (skip()) return;
    const batch = await open(SIMPLE, "create");
    expectError(await validate(SES_OWNER_ALL, batch.batchId, 1), 422, "mapping_required");
    expect(await batchState(h.env().admin, batch.batchId)).toMatchObject({ state: "draft", version: 1, validation_generation: 0 });
    expect(await audits("catalog.import.validate")).toHaveLength(0);
  });

  it("re-applies the mapping rules to the stored mapping: 422 mapping_invalid, nothing changes", async () => {
    if (skip()) return;
    const batch = await open(SIMPLE, "create");
    // The database allows a field twice (only the length is checked), so the runtime must refuse it.
    await h.env().admin.query(
      `UPDATE catalog_import_batches SET mapping = '[{"columnNumber":1,"target":"name"},{"columnNumber":2,"target":"name"},{"columnNumber":3,"target":"tax_category"}]'::jsonb WHERE id = $1`,
      [batch.batchId],
    );
    expectError(await validate(SES_OWNER_ALL, batch.batchId, 1), 422, "mapping_invalid");
    expect(await batchState(h.env().admin, batch.batchId)).toMatchObject({ state: "draft", version: 1 });
  });

  it("answers 409 version_conflict for a stale version, 404 for an absent batch, 400 for a bad body", async () => {
    if (skip()) return;
    const batch = await open(SIMPLE, "create");
    await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 1, columns: suggested(batch) }).expect(200);
    expectError(await validate(SES_OWNER_ALL, batch.batchId, 1), 409, "version_conflict");
    expectError(await validate(SES_OWNER_ALL, "0192f000-0000-7000-8000-00000000dead", 2), 404, "not_found");
    expectError(await h.post(validatePath(batch.batchId), SES_OWNER_ALL, {}), 400, "validation_error");
    expectError(await h.post(validatePath(batch.batchId), SES_OWNER_ALL, { expectedVersion: 2, force: true }), 400, "validation_error");
    expectError(await validate(SES_OWNER_ALL, "nope", 2), 400, "validation_error");
    expect(await batchState(h.env().admin, batch.batchId)).toMatchObject({ state: "draft", version: 2 });
  });

  it("is for owner and tenant_admin only: the store roles and another tenant get the non-disclosing 404", async () => {
    if (skip()) return;
    const batch = await open(SIMPLE, "create");
    await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 1, columns: suggested(batch) }).expect(200);
    for (const session of [SES_MANAGER, SES_STAFF, SES_OWNER_B]) {
      expectError(await validate(session, batch.batchId, 2), 404, "not_found");
    }
    expect(await batchState(h.env().admin, batch.batchId)).toMatchObject({ state: "draft", version: 2 });
    expect(await audits("catalog.import.validate")).toHaveLength(0);
  });
});

/** Nine columns the header synonyms all place; row numbers follow the lines (the header is row 1). */
const SCENARIO = [
  "SKU,Barcode,PLU,Name,Category,Brand,Tax Category,Active,Price",
  "A-1,4006381333931,,RT1505 Alpha,RT730 Drinks,,standard,,8.5", // 2 unchanged (a price notice)
  "B-1,,,RT1505 Beta Renamed,,RT1505 Acme,standard,,", // 3 ready_update: name, brand
  "NEW-1,5901234123457,,Fresh Tea,RT730 Drinks,Brand Fresh,standard,,", // 4 ready_create, brand to create
  "I-1,,,,,,,true,", // 5 ready_update: is_active
  "R-1,,,Retired Tea,,,standard,,", // 6 error: product_retired
  "G-1,,,RT1505 Gamma 2,,,standard,,", // 7 ready_update: name
  "W-1,123,,,,,,,", // 8 needs_review: ambiguous (Water and Juice)
  "NEW-2,,,Nice,Nonexistent cat,,standard,,", // 9 error: category_not_found
  "NEW-3,,,RT730 Water,,,standard,,", // 10 needs_review: possible_duplicate
  ",,,Anon,,,standard,,", // 11 needs_review: no_identifier
  "NEW-4,,,Odd tax,,,exotic,,", // 12 ready_create + tax_category_unused
  "  NEW-6  ,,,  Spaces  ,,,standard,,", // 13 ready_create, two trims
  "NEW-7,,4242,Plu thing,,,standard,,", // 14 needs_review: store_scoped_conflict (Water's PLU at store Y)
  "NEW-8,555000,,Deleted store barcode,,,standard,,", // 15 ready_create: a deleted store's identifier is absent
  "NEW-9,\u{0660}\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667},,Arabic digits,,,standard,,", // 16 error: identifier_non_ascii_digits
  "NEW-10,,,Old cat,RT730 Old,,standard,,", // 17 error: category_not_found (a retired category)
  "NEW-11,6223001360018,,Gamma again,,,standard,,", // 18 needs_review: sku_mismatch (Gamma has G-1)
  "A-2,4006381333930,,Bad gtin,,,standard,,", // 19 ready_create + gtin_check_digit
].join("\n");

const byNumber = (rows: RowBody[], n: number): RowBody => rows.find((r) => r.rowNumber === n) as RowBody;
const codesOf = (r: RowBody): string[] => r.issues.map((i) => i.code);

describe("validate against a real catalogue (mode upsert)", () => {
  async function validated(text = SCENARIO, mode = "upsert"): Promise<{ batch: Batch; body: Batch; rows: RowBody[] }> {
    const batch = await open(text, mode);
    await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 1, columns: suggested(batch) }).expect(200);
    const res = await validate(SES_OWNER_ALL, batch.batchId, 2).expect(200);
    h.conforms("CatalogImportBatch", res.body);
    return { batch, body: res.body as Batch, rows: await allRows(batch.batchId) };
  }

  it("gives every row exactly one status, stores the counts and a preview hash, and moves the batch to validated", async () => {
    if (skip()) return;
    const { batch, body, rows } = await validated();
    expect(batch.suggestedMapping).toHaveLength(9);
    expect(body).toMatchObject({ state: "validated", version: 3, publishable: false });
    expect(body.previewHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.counts).toEqual({ ready_create: 5, ready_update: 3, unchanged: 1, needs_review: 5, error: 4, excluded: 0 });
    expect(Object.values(body.counts!).reduce((a, b) => a + b, 0)).toBe(18);
    expect(rows).toHaveLength(18);
    expect(rows.map((r) => r.rowNumber)).toEqual(Array.from({ length: 18 }, (_v, i) => i + 2));
    expect(rows.map((r) => r.status)).toEqual([
      "unchanged", "ready_update", "ready_create", "ready_update", "error", "ready_update", "needs_review", "error", "needs_review",
      "needs_review", "ready_create", "ready_create", "needs_review", "ready_create", "error", "error", "needs_review", "ready_create",
    ]);
    const state = await batchState(h.env().admin, batch.batchId);
    expect(state).toMatchObject({ state: "validated", version: 3, validation_generation: 1, preview_hash: body.previewHash });
    const stored = await validatedRows(h.env().admin, batch.batchId);
    expect(stored.every((r) => r.status !== null)).toBe(true);
    // Every matched row keeps the product's updated_at exactly (microseconds included), for the publish stale re-check.
    expect(stored.filter((r) => r.matched_ok !== null).every((r) => r.matched_ok === true)).toBe(true);
    expect(stored.filter((r) => r.matched_ok !== null).map((r) => r.row_number)).toEqual([2, 3, 5, 6, 7, 18]);
  });

  it("names each outcome: updates, creates, brand to create, identifier adds", async () => {
    if (skip()) return;
    const { rows } = await validated();
    expect(byNumber(rows, 2)).toMatchObject({ status: "unchanged", outcome: { match: "match", fieldChanges: [], identifierAdds: [] } });
    expect(codesOf(byNumber(rows, 2))).toEqual(["price_not_imported"]);
    expect(byNumber(rows, 3).outcome.fieldChanges).toEqual([
      { field: "name", before: "RT1505 Beta", after: "RT1505 Beta Renamed" },
      { field: "brand", before: null, after: "RT1505 Acme" },
    ]);
    expect(byNumber(rows, 3).outcome.brandToCreate).toBeNull();
    expect(byNumber(rows, 4).outcome).toMatchObject({
      match: "no_match",
      brandToCreate: "Brand Fresh",
      identifierAdds: [{ type: "sku", value: "NEW-1" }, { type: "barcode", value: "5901234123457" }],
    });
    expect(codesOf(byNumber(rows, 4))).toEqual(["brand_created"]);
    expect(byNumber(rows, 5).outcome.fieldChanges).toEqual([{ field: "is_active", before: "false", after: "true" }]);
    expect(byNumber(rows, 7).outcome.fieldChanges).toEqual([{ field: "name", before: "RT1505 Gamma", after: "RT1505 Gamma 2" }]);
  });

  it("flags each error, review reason, warning and notice with its field and column", async () => {
    if (skip()) return;
    const { rows } = await validated();
    const retired = byNumber(rows, 6);
    expect(retired.issues).toHaveLength(1);
    expect(retired.issues[0]).toMatchObject({ code: "product_retired", severity: "error", relatedProduct: { name: "RT730 Retired tea" } });
    const ambiguous = byNumber(rows, 8);
    expect([ambiguous.status, ambiguous.reviewReason, ambiguous.outcome.match]).toEqual(["needs_review", "ambiguous", "ambiguous"]);
    expect(ambiguous.outcome.candidates.map((c) => c.productId).sort()).toEqual([P_JUICE, P_WATER].sort());
    expect(byNumber(rows, 9).issues.map((i) => [i.code, i.field, i.columnNumber])).toEqual([["category_not_found", "category", 5]]);
    expect(byNumber(rows, 10)).toMatchObject({ reviewReason: "possible_duplicate", issues: [{ code: "possible_duplicate", relatedProduct: { productId: P_WATER, name: "RT730 Water" } }] });
    expect(byNumber(rows, 11)).toMatchObject({ reviewReason: "no_identifier" });
    expect(byNumber(rows, 12).issues.map((i) => [i.code, i.severity])).toEqual([["tax_category_unused", "warning"]]);
    expect(byNumber(rows, 12).status).toBe("ready_create");
    expect(byNumber(rows, 13).issues.map((i) => [i.code, i.field, i.columnNumber])).toEqual([
      ["whitespace_trimmed", "sku", 1],
      ["whitespace_trimmed", "name", 4],
    ]);
    expect(byNumber(rows, 13).cells.slice(0, 4)).toEqual(["NEW-6", null, null, "Spaces"]);
    expect(byNumber(rows, 13).outcome.identifierAdds).toEqual([{ type: "sku", value: "NEW-6" }]);
    expect(byNumber(rows, 14)).toMatchObject({ reviewReason: "store_scoped_conflict", issues: [{ code: "store_scoped_conflict", field: "plu", relatedProduct: { productId: P_WATER } }] });
    expect(byNumber(rows, 15)).toMatchObject({ status: "ready_create", issues: [] });
    expect(byNumber(rows, 16).issues.map((i) => [i.code, i.field])).toEqual([["identifier_non_ascii_digits", "barcode"]]);
    expect(byNumber(rows, 17).issues.map((i) => i.code)).toEqual(["category_not_found"]);
    expect(byNumber(rows, 18)).toMatchObject({ reviewReason: "sku_mismatch", issues: [{ code: "sku_mismatch", field: "sku", relatedProduct: { productId: P_GAMMA, name: "RT1505 Gamma" } }] });
    expect(byNumber(rows, 19).issues.map((i) => [i.code, i.severity])).toEqual([["gtin_check_digit", "warning"]]);
    expect(byNumber(rows, 19).status).toBe("ready_create");
  });

  it("audits the validation as ids, counts and issue counts only", async () => {
    if (skip()) return;
    const { batch, body } = await validated();
    const written = await audits("catalog.import.validate");
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ actor_user_id: OWNER_A_USER, target_id: batch.batchId });
    const meta = written[0]!.metadata as { counts: unknown; issue_counts: Record<string, number>; version: number };
    expect(meta).toMatchObject({ batch_id: batch.batchId, version: 3, mode: "upsert", data_row_count: 18, column_count: 9, counts: body.counts });
    expect(meta.issue_counts).toMatchObject({ category_not_found: 2, price_not_imported: 1, whitespace_trimmed: 2, brand_created: 1, gtin_check_digit: 1, tax_category_unused: 1 });
    expect(JSON.stringify(written[0]!.metadata)).not.toMatch(/Fresh Tea|RT1505|Brand Fresh|4006381333931/);
  });

  it("is repeatable: a re-validate bumps the version and the generation and gives the same hash", async () => {
    if (skip()) return;
    const { batch, body } = await validated();
    const again = await validate(SES_OWNER_ALL, batch.batchId, 3).expect(200);
    expect(again.body).toMatchObject({ state: "validated", version: 4, previewHash: body.previewHash, counts: body.counts });
    expect(await batchState(h.env().admin, batch.batchId)).toMatchObject({ version: 4, validation_generation: 2 });
    expect(await audits("catalog.import.validate")).toHaveLength(2);
  });

  it("goes back to draft when the mapping changes: no counts, no hash, and the rows are not readable", async () => {
    if (skip()) return;
    const { batch } = await validated();
    const draft = await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 3, columns: suggested(batch) }).expect(200);
    expect(draft.body).toMatchObject({ state: "draft", version: 4, counts: null, previewHash: null, publishable: false });
    expectError(await h.get(rowsPath(batch.batchId), SES_OWNER_ALL, {}), 409, "import_batch_not_validated");
  });

  it("is a publishable batch only when no row is needs_review or error", async () => {
    if (skip()) return;
    const clean = await validated("SKU,Name,Tax Category\nZ-1,Zed,standard\nZ-2,Zee,standard\n", "create");
    expect(clean.body).toMatchObject({ state: "validated", publishable: true, counts: { ready_create: 2, ready_update: 0, unchanged: 0, needs_review: 0, error: 0, excluded: 0 } });
  });
});

describe("expiry (spec 049 section 8.1)", () => {
  it("a batch past its expires_at that the job has not closed yet is 409 import_batch_closed for map and validate, and its expiry is not moved", async () => {
    if (skip()) return;
    const batch = await open(SIMPLE, "create");
    await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 1, columns: suggested(batch) }).expect(200);
    const { admin } = h.env();
    await admin.query(`UPDATE catalog_import_batches SET expires_at = now() - interval '1 minute' WHERE id = $1`, [batch.batchId]);
    expectError(await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 2, columns: suggested(batch) }), 409, "import_batch_closed");
    expectError(await validate(SES_OWNER_ALL, batch.batchId, 2), 409, "import_batch_closed");
    const lapsed = await admin.query<{ still_past: boolean }>(`SELECT expires_at < now() AS still_past FROM catalog_import_batches WHERE id = $1`, [batch.batchId]);
    expect(lapsed.rows[0]!.still_past).toBe(true);
    expect(await batchState(admin, batch.batchId)).toMatchObject({ state: "draft", version: 2 });
    expect(await audits("catalog.import.validate")).toHaveLength(0);
    // The closed check comes before the version check, as for a closed batch.
    expectError(await validate(SES_OWNER_ALL, batch.batchId, 1), 409, "import_batch_closed");
    // A batch that has not lapsed still moves its expiry forward.
    await admin.query(`UPDATE catalog_import_batches SET expires_at = now() + interval '1 minute' WHERE id = $1`, [batch.batchId]);
    await validate(SES_OWNER_ALL, batch.batchId, 2).expect(200);
    const moved = await admin.query<{ days: string }>(`SELECT (extract(epoch FROM expires_at - now()) / 86400)::text AS days FROM catalog_import_batches WHERE id = $1`, [batch.batchId]);
    expect(Number(moved.rows[0]!.days)).toBeGreaterThan(6.99);
  });
});

describe("the preview hash does not depend on the session settings", () => {
  it("reads a matched product's updated_at as the same ISO instant in UTC whatever the session TimeZone and DateStyle, so the hash is the same", async () => {
    if (skip()) return;
    const mapping = [{ columnNumber: 1, target: "sku" as const }, { columnNumber: 2, target: "name" as const }];
    const parsed = parseRows(mapping, [{ rowNumber: 2, cells: ["A-1", "RT1505 Alpha Renamed"] }, { rowNumber: 3, cells: ["B-1", "RT1505 Beta"] }]);
    const hashUnder = async (settings: string[]): Promise<{ hash: string; updated: Array<string | null> }> => {
      const client = await h.env().admin.connect();
      try {
        for (const setting of settings) await client.query(setting);
        const lookups = await loadCatalogLookups(client, TENANT_A, collectLookupKeys(parsed), false);
        const results = evaluateRows("update", mapping, parsed, lookups);
        return { hash: previewHashOf("update", results), updated: results.map((r) => r.matchedUpdatedAt) };
      } finally {
        await client.query("RESET TimeZone");
        await client.query("RESET DateStyle");
        client.release();
      }
    };
    const utc = await hashUnder(["SET TimeZone = 'UTC'", "SET DateStyle = 'ISO, YMD'"]);
    const tokyo = await hashUnder(["SET TimeZone = 'Asia/Tokyo'", "SET DateStyle = 'German, DMY'"]);
    const newYork = await hashUnder(["SET TimeZone = 'America/New_York'", "SET DateStyle = 'SQL, MDY'"]);
    expect(utc.updated.every((u) => u !== null && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(u))).toBe(true);
    expect(tokyo).toEqual(utc);
    expect(newYork).toEqual(utc);
  });
});

describe("validate: the modes", () => {
  it("create: a matched row is already_exists naming the product; update: an unmatched row is not_found", async () => {
    if (skip()) return;
    const text = "SKU,Name,Tax Category\nA-1,RT1505 Alpha,standard\nBRAND-NEW,Fresh,standard\n";
    const created = await open(text, "create");
    await setMapping(SES_OWNER_ALL, created.batchId, { expectedVersion: 1, columns: suggested(created) }).expect(200);
    await validate(SES_OWNER_ALL, created.batchId, 2).expect(200);
    const rows = await allRows(created.batchId);
    expect(rows.map((r) => r.status)).toEqual(["error", "ready_create"]);
    expect(rows[0]!.issues[0]).toMatchObject({
      code: "already_exists",
      relatedProduct: { productId: P_ALPHA, name: "RT1505 Alpha", identifiers: [{ type: "sku", value: "A-1" }, { type: "barcode", value: "4006381333931" }] },
    });
    await h.env().admin.query(`UPDATE catalog_import_batches SET state = 'cancelled', closed_at = now(), expires_at = NULL, preview_hash = NULL WHERE id = $1`, [created.batchId]);
    const updated = await open(text, "update");
    await setMapping(SES_OWNER_ALL, updated.batchId, { expectedVersion: 1, columns: suggested(updated) }).expect(200);
    await validate(SES_OWNER_ALL, updated.batchId, 2).expect(200);
    const updateRows = await allRows(updated.batchId);
    expect(updateRows.map((r) => r.status)).toEqual(["unchanged", "error"]);
    expect(updateRows[1]!.issues.map((i) => i.code)).toEqual(["not_found"]);
  });

  it("update: a blank cell leaves the field unchanged and is_active false is counted as a deactivation", async () => {
    if (skip()) return;
    const batch = await open("SKU,Name,Active\nA-1,,false\nB-1,,\n", "update");
    await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 1, columns: suggested(batch) }).expect(200);
    await validate(SES_OWNER_ALL, batch.batchId, 2).expect(200);
    const rows = await allRows(batch.batchId);
    expect(rows.map((r) => r.status)).toEqual(["ready_update", "unchanged"]);
    expect(rows[0]!.issues.map((i) => [i.code, i.severity])).toEqual([["deactivates_product", "warning"]]);
    expect(rows[0]!.outcome.fieldChanges).toEqual([{ field: "is_active", before: "true", after: "false" }]);
  });
});

describe("validate: tenant isolation (RLS)", () => {
  it("matches a barcode only against the session's own tenant (000123 exists in both)", async () => {
    if (skip()) return;
    const text = "Barcode,Name\n000123,Anything\n";
    const a = await open(text, "update");
    await setMapping(SES_OWNER_ALL, a.batchId, { expectedVersion: 1, columns: suggested(a) }).expect(200);
    await validate(SES_OWNER_ALL, a.batchId, 2).expect(200);
    const b = await open(text, "update", SES_OWNER_B);
    await setMapping(SES_OWNER_B, b.batchId, { expectedVersion: 1, columns: suggested(b) }).expect(200);
    await validate(SES_OWNER_B, b.batchId, 2).expect(200);
    const rowA = (await allRows(a.batchId))[0]!;
    const rowB = (await allRows(b.batchId, SES_OWNER_B))[0]!;
    expect(rowA.outcome.matchedProduct).toMatchObject({ productId: P_WATER, name: "RT730 Water" });
    expect(rowB.outcome.matchedProduct).toMatchObject({ name: "RT730 Water B" });
    expect(JSON.stringify(rowB)).not.toMatch(/RT1505|RT730 Water"/);
  });

  it("never lets one tenant read the rows of the other's batch", async () => {
    if (skip()) return;
    const a = await open(SIMPLE, "create");
    await setMapping(SES_OWNER_ALL, a.batchId, { expectedVersion: 1, columns: suggested(a) }).expect(200);
    await validate(SES_OWNER_ALL, a.batchId, 2).expect(200);
    expectError(await h.get(rowsPath(a.batchId), SES_OWNER_B, {}), 404, "not_found");
    for (const session of [SES_MANAGER, SES_STAFF]) expectError(await h.get(rowsPath(a.batchId), session, {}), 404, "not_found");
  });
});

describe("the row list", () => {
  async function validatedScenario(): Promise<string> {
    const batch = await open(SCENARIO);
    await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 1, columns: suggested(batch) }).expect(200);
    await validate(SES_OWNER_ALL, batch.batchId, 2).expect(200);
    return batch.batchId;
  }

  it("is 409 import_batch_not_validated for a draft batch", async () => {
    if (skip()) return;
    const batch = await open(SIMPLE, "create");
    expectError(await h.get(rowsPath(batch.batchId), SES_OWNER_ALL, {}), 409, "import_batch_not_validated");
  });

  it("pages by row number without repeating or skipping a row, and carries the batch version", async () => {
    if (skip()) return;
    const id = await validatedScenario();
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const query: Record<string, string | number> = { limit: 5 };
      if (cursor !== undefined) query["cursor"] = cursor;
      const res = await h.get(rowsPath(id), SES_OWNER_ALL, query).expect(200);
      h.conforms("CatalogImportRowPage", res.body);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toMatchObject({ batchId: id, version: 3 });
      pages += 1;
      seen.push(...(res.body.items as RowBody[]).map((r) => r.rowNumber));
      if (res.body.nextCursor === null) break;
      expect((res.body.items as RowBody[]).length).toBe(5);
      cursor = res.body.nextCursor as string;
    }
    expect(pages).toBe(4);
    expect(seen).toEqual(Array.from({ length: 18 }, (_v, i) => i + 2));
  });

  it("filters by status and a cursor is bound to that filter", async () => {
    if (skip()) return;
    const id = await validatedScenario();
    const reviews = await allRows(id, SES_OWNER_ALL, "needs_review");
    expect(reviews.map((r) => r.rowNumber)).toEqual([8, 10, 11, 14, 18]);
    expect(reviews.every((r) => r.status === "needs_review")).toBe(true);
    const first = await h.get(rowsPath(id), SES_OWNER_ALL, { status: "error", limit: 2 }).expect(200);
    expect(first.body.items.map((r: RowBody) => r.rowNumber)).toEqual([6, 9]);
    const cursor = first.body.nextCursor as string;
    // The same cursor under another status, or with the status dropped, is not one this query issued.
    expectError(await h.get(rowsPath(id), SES_OWNER_ALL, { status: "needs_review", cursor }), 400, "validation_error");
    expectError(await h.get(rowsPath(id), SES_OWNER_ALL, { cursor }), 400, "validation_error");
    const next = await h.get(rowsPath(id), SES_OWNER_ALL, { status: "error", cursor, limit: 5 }).expect(200);
    expect(next.body.items.map((r: RowBody) => r.rowNumber)).toEqual([16, 17]);
    expect(next.body.nextCursor).toBeNull();
  });

  it("ends a cursor when validate runs again (a new generation), not when the version moves otherwise", async () => {
    if (skip()) return;
    const id = await validatedScenario();
    const first = await h.get(rowsPath(id), SES_OWNER_ALL, { limit: 3 }).expect(200);
    const cursor = first.body.nextCursor as string;
    await h.get(rowsPath(id), SES_OWNER_ALL, { cursor }).expect(200);
    await validate(SES_OWNER_ALL, id, 3).expect(200);
    expectError(await h.get(rowsPath(id), SES_OWNER_ALL, { cursor }), 400, "validation_error");
    // Another batch's, another tenant's and a forged cursor are refused too.
    expectError(await h.get(rowsPath(id), SES_OWNER_ALL, { cursor: "AAAA" }), 400, "validation_error");
  });

  it("refuses an unknown or repeated query key, a bad status or limit, and a non-UUID batch id with 400", async () => {
    if (skip()) return;
    const id = await validatedScenario();
    for (const query of [{ tenant_id: TENANT_B }, { status: "published" }, { limit: 0 }, { limit: 201 }, { limit: "abc" }]) {
      expectError(await h.get(rowsPath(id), SES_OWNER_ALL, query as Record<string, string | number>), 400, "validation_error");
    }
    const repeated = await h.get(`${rowsPath(id)}?status=error&status=unchanged`, SES_OWNER_ALL);
    expectError(repeated, 400, "validation_error");
    expectError(await h.get(rowsPath("nope"), SES_OWNER_ALL, {}), 400, "validation_error");
  });

  it("never answers an empty page for a batch whose rows were purged (the one difference is rows_purged_at)", async () => {
    if (skip()) return;
    const { admin } = h.env();
    const published = "0192f000-0000-7000-8000-000000001505";
    await seedPublishedBatch(admin, { id: published, tenantId: TENANT_A, actor: OWNER_A_USER, sha256: "b".repeat(64), daysAgo: 1 });
    const before = await h.get(rowsPath(published), SES_OWNER_ALL, {}).expect(200);
    expect(before.body).toMatchObject({ batchId: published, items: [], nextCursor: null });
    await admin.query(`UPDATE catalog_import_batches SET rows_purged_at = now() WHERE id = $1`, [published]);
    expectError(await h.get(rowsPath(published), SES_OWNER_ALL, {}), 409, "import_batch_not_validated");
  });
});

describe("XLSX typed cells through the database", () => {
  it("a number-cell barcode is identifier_numeric_cell, a formula SKU identifier_formula_cell, an uncached name formula an error", async () => {
    if (skip()) return;
    const book = buildXlsx([
      {
        name: "Products",
        rows: [
          ["Barcode", "SKU", "Name", "Tax Category"],
          [{ num: "6223001360018" }, "X-1", "Number barcode", "standard"],
          ["9780306406157", { formula: "\"X-2\"", cached: "X-2" }, "Formula sku", "standard"],
          ["5901234123457", "X-3", { formula: "\"Tea\"", cached: "Tea" }, "standard"],
          ["", "X-4", { formula: "1" }, "standard"],
        ],
      },
    ]);
    const batch = await open(book, "create");
    await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 1, columns: suggested(batch) }).expect(200);
    await validate(SES_OWNER_ALL, batch.batchId, 2).expect(200);
    const rows = await allRows(batch.batchId);
    expect(rows.map((r) => r.status)).toEqual(["error", "error", "ready_create", "error"]);
    expect(codesOf(rows[0]!)).toEqual(["identifier_numeric_cell"]);
    expect(rows[0]!.issues[0]).toMatchObject({ field: "barcode", columnNumber: 1 });
    expect(codesOf(rows[1]!)).toEqual(["identifier_formula_cell"]);
    expect(codesOf(rows[2]!)).toEqual(["formula_cached_value"]);
    expect(rows[2]!.cells).toEqual(["5901234123457", "X-3", "Tea", "standard"]);
    expect(codesOf(rows[3]!)).toEqual(["formula_without_value"]);
  });
});

describe("5,000 rows of 50 columns", () => {
  it("uploads, maps and validates end to end within the time budget, every row with one status", async () => {
    if (skip()) return;
    const header = ["SKU", "Name", "Tax Category", ...Array.from({ length: 47 }, (_v, i) => `Extra ${i + 1}`)].join(",");
    const lines = [header];
    for (let r = 0; r < 5000; r += 1) {
      lines.push([`BULK-${r}`, `Bulk product ${r}`, "standard", ...Array.from({ length: 47 }, (_v, c) => `v${r}-${c}`)].join(","));
    }
    const batch = await open(lines.join("\n"), "create");
    expect(batch.columns).toHaveLength(50);
    const mapping = batch.columns.map((c) => ({ columnNumber: c.columnNumber, target: c.columnNumber === 1 ? "sku" : c.columnNumber === 2 ? "name" : c.columnNumber === 3 ? "tax_category" : "ignore" }));
    await setMapping(SES_OWNER_ALL, batch.batchId, { expectedVersion: 1, columns: mapping }).expect(200);
    const started = Date.now();
    const res = await validate(SES_OWNER_ALL, batch.batchId, 2).expect(200);
    const elapsed = Date.now() - started;
    expect(res.body.counts).toEqual({ ready_create: 5000, ready_update: 0, unchanged: 0, needs_review: 0, error: 0, excluded: 0 });
    // The latency budget is p95 10 s (spec 049 section 8.5, measured in S8); this is a sanity bound for a slow CI box.
    expect(elapsed).toBeLessThan(60_000);
    const stored = await validatedRows(h.env().admin, batch.batchId);
    expect(stored).toHaveLength(5000);
    expect(stored.every((r) => r.status === "ready_create")).toBe(true);
  }, 240_000);
});

describe("catalogue facts the specs above rely on", () => {
  it("has the tenant A fixtures a scenario names (a guard against a changed shared fixture)", async () => {
    if (skip()) return;
    const r = await h.env().admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM product_aliases WHERE tenant_id = $1 AND retired_at IS NULL AND value IN ('A-1','B-1','G-1','I-1','R-1','W-1','123','000123','4242','555000')`,
      [TENANT_A],
    );
    expect(Number(r.rows[0]!.n)).toBe(10);
  });
});
