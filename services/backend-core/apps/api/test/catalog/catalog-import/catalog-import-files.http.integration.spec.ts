/**
 * RT-1537 (spec 049 slice S5c) — the file replace, the error report and the template over HTTP against real Postgres
 * (Testcontainers, every migration including 0124, the NOBYPASSRLS `app_test` pool holding only the production grants of
 * `catalog-import.grants.ts`) and the real module graph (the session, tenant and role guards, the raw-body intake, the
 * off-thread parse). Only cookie authentication is faked: a header names the session.
 *
 * What this proves:
 *   - replace: a `draft` or a `validated` batch goes back to `draft` at the next version with the new file's facts, rows
 *     and columns, `mapping` null, no counts or preview hash, the mode kept, the unchanged-header entries of the previous
 *     mapping carried to the new column numbers and taking priority over a synonym, review state gone, one
 *     `catalog.import.upload` audit row, and a body that conforms to the contract;
 *   - the order of checks and what a refusal leaves behind: 404 (absent, another tenant, a store role), 409 closed or
 *     lapsed, 409 `version_conflict` (also a retry after success: the idempotence), 422 / 400 / 413 file refusals that
 *     leave the batch, its rows and its audit trail untouched;
 *   - the previous-publish warning is computed for the new file; two concurrent replaces: one wins;
 *   - the error report: only `error` and `needs_review` rows, the BOM, formula-injection safety of every cell, 409 before
 *     validation and for a cancelled batch, 404 across tenants;
 *   - the template: both languages, the BOM, owner / tenant admin only.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { createHash } from "node:crypto";
import type request from "supertest";

import { CatalogImportModule } from "../../../src/catalog/catalog-import/catalog-import.module";
import { importUploadPassthrough } from "../../../src/catalog/catalog-import/import-upload-intake.guard";
import { buildTemplateCsv } from "../../../src/catalog/catalog-import/import-template";
import { scopedHttpHarness } from "../../_helpers/scoped-http-harness";
import { SES_MANAGER, SES_STAFF } from "../../console-sales/__support__/console-sales-fixture";
import { TENANT_A } from "../__support__/isolation-harness";
import { SES_ADMIN_SPEC, SES_OWNER_ALL } from "../erpnext-reconciliation/__support__/read-store-scope";
import { countRows, rowsOf, seedPublishedBatch, SES_OWNER_B, uploadAudits } from "./__support__/catalog-import-fixture";
import { idempotencyProviders } from "./__support__/idempotency-fakes";
import { batchState, seedMapValidateFixture } from "./__support__/map-validate-fixture";

const IMPORTS = "/api/v1/catalog/imports";
const ORIGIN = "http://127.0.0.1";
const MIB = 1024 * 1024;
const OWNER_A_USER = "0a000000-0000-7000-8000-0000019202a3";

const h = scopedHttpHarness({
  label: "RT-1537 catalog-import files",
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
  return `rt1537-key-${String(seq).padStart(8, "0")}-${Date.now()}`;
};

interface Batch {
  batchId: string;
  state: string;
  version: number;
  mode: string;
  file: { name: string | null; sizeBytes: number; sha256: string; kind: string; dataRowCount: number; columnCount: number };
  columns: Array<{ columnNumber: number; header: string; samples: string[] }>;
  mapping: Array<{ columnNumber: number; target: string }> | null;
  suggestedMapping: Array<{ columnNumber: number; target: string }>;
  counts: Record<string, number> | null;
  previewHash: string | null;
  warnings: Array<{ code: string; publishedBatchId: string }>;
}

const csv = (text: string): Buffer => Buffer.from(text, "utf8");

function uploadBytes(session: string | null, bytes: Buffer, mode = "create"): request.Test {
  return h
    .post(`${IMPORTS}?mode=${mode}`, session, bytes)
    .set("Content-Type", "application/octet-stream")
    .serialize((body: unknown) => body as string)
    .set("Origin", ORIGIN)
    .set("Idempotency-Key", key());
}

async function open(text: string | Buffer, mode = "create", session = SES_OWNER_ALL): Promise<Batch> {
  return (await uploadBytes(session, typeof text === "string" ? csv(text) : text, mode).expect(201)).body as Batch;
}

/** The raw bytes as the body of the replace, under any content type. */
function replace(session: string | null, id: string, bytes: Buffer, query: string = "expected_version=1"): request.Test {
  return h
    .put(`${IMPORTS}/${id}/file?${query}`, session, bytes)
    .set("Content-Type", "application/octet-stream")
    .serialize((body: unknown) => body as string)
    .set("Origin", ORIGIN);
}

function setMapping(id: string, expectedVersion: number, columns: Array<{ columnNumber: number; target: string }>): request.Test {
  return h.put(`${IMPORTS}/${id}/mapping`, SES_OWNER_ALL, { expectedVersion, columns }).set("Origin", ORIGIN);
}

function validate(id: string, expectedVersion: number): request.Test {
  return h.post(`${IMPORTS}/${id}/validate`, SES_OWNER_ALL, { expectedVersion }).set("Origin", ORIGIN);
}

function expectError(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  h.conforms("Error", res.body);
}

/** The raw bytes of a GET (supertest decodes text and can drop a BOM). */
function rawGet(path: string, session: string | null, query: Record<string, string | number> = {}): request.Test {
  return h.get(path, session, query).buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => done(null, Buffer.concat(chunks)));
  });
}

let since = new Date(0);
const audits = (): ReturnType<typeof uploadAudits> => uploadAudits(h.env().admin, TENANT_A, since);

/** Every test starts with no batch of either tenant: the open-batch rule would otherwise couple them. */
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

const V1 = "SKU,Name,Tax Category\nN-1,Tea,standard\nN-2,Coffee,standard\n";
const V2 = "SKU,Name,Tax Category,Brand\nN-1,Tea,standard,Acme\nN-2,Coffee,standard,Acme\nN-3,Milk,standard,Acme\n";

describe("replace: a draft batch", () => {
  it("takes the new file at the next version: facts, columns and rows replaced, the mapping cleared, the mode kept, one audit row", async () => {
    if (skip()) return;
    const first = await open(V1, "update");
    const res = await replace(SES_OWNER_ALL, first.batchId, csv(V2), "expected_version=1&file_name=fixed.csv").expect(200);
    h.conforms("CatalogImportBatch", res.body);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.body as Batch;
    expect(body).toMatchObject({ batchId: first.batchId, state: "draft", version: 2, mode: "update", mapping: null, counts: null, previewHash: null });
    expect(body.file).toMatchObject({ name: "fixed.csv", kind: "csv", dataRowCount: 3, columnCount: 4 });
    expect(body.file.sha256).toBe(createHash("sha256").update(csv(V2)).digest("hex"));
    expect(body.columns.map((c) => c.header)).toEqual(["SKU", "Name", "Tax Category", "Brand"]);
    // Nothing was mapped yet, so nothing is carried: the upload's own suggestion for the new file.
    expect(body.suggestedMapping).toEqual([
      { columnNumber: 1, target: "sku" },
      { columnNumber: 2, target: "name" },
      { columnNumber: 3, target: "tax_category" },
      { columnNumber: 4, target: "brand" },
    ]);
    const rows = await rowsOf(h.env().admin, TENANT_A, first.batchId);
    expect(rows.map((r) => r.row_number)).toEqual([2, 3, 4]);
    expect(rows.every((r) => r.status === null)).toBe(true);
    const log = await audits();
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ actor_user_id: OWNER_A_USER, target_id: first.batchId, target_type: "catalog_import_batch" });
    expect(log[1]!.metadata).toMatchObject({ replaced_file: true, version: 2, file_kind: "csv", data_row_count: 3 });
    expect(JSON.stringify(log[1]!.metadata)).not.toContain("Acme");
  });

  it("answers the new file name as null when none is given (only the mode is kept)", async () => {
    if (skip()) return;
    const first = await h.post(`${IMPORTS}?mode=create&file_name=old.csv`, SES_OWNER_ALL, csv(V1)).set("Content-Type", "application/octet-stream").serialize((b: unknown) => b as string).set("Origin", ORIGIN).set("Idempotency-Key", key()).expect(201);
    expect(first.body.file.name).toBe("old.csv");
    const res = await replace(SES_OWNER_ALL, first.body.batchId, csv(V2)).expect(200);
    expect(res.body.file.name).toBeNull();
  });

  it("is a retry-safe call: the same request again is 409 version_conflict and changes nothing", async () => {
    if (skip()) return;
    const first = await open(V1);
    await replace(SES_OWNER_ALL, first.batchId, csv(V2)).expect(200);
    const before = await batchState(h.env().admin, first.batchId);
    expectError(await replace(SES_OWNER_ALL, first.batchId, csv(V2)), 409, "version_conflict");
    expect(await batchState(h.env().admin, first.batchId)).toEqual(before);
    expect(await audits()).toHaveLength(2);
  });

  it("reads the replaced batch back as the replace answered it", async () => {
    if (skip()) return;
    const first = await open(V1);
    const res = await replace(SES_OWNER_ALL, first.batchId, csv(V2)).expect(200);
    const read = await h.get(`${IMPORTS}/${first.batchId}`, SES_OWNER_ALL).expect(200);
    expect(read.body).toEqual(res.body);
  });
});

describe("replace: the previous mapping is carried", () => {
  it("places an unchanged header at its NEW column number and lets it take priority over a synonym", async () => {
    if (skip()) return;
    const first = await open("Zeta,Name,Tax Category\nA,Tea,standard\n");
    // `Zeta` is no synonym: the merchant mapped it to sku by hand.
    const mapped = await setMapping(first.batchId, 1, [
      { columnNumber: 1, target: "sku" },
      { columnNumber: 2, target: "name" },
      { columnNumber: 3, target: "tax_category" },
    ]).expect(200);
    expect(mapped.body.version).toBe(2);
    // The fixed file reorders the columns and adds `Code`, which is a sku synonym but sku is already held.
    const res = await replace(SES_OWNER_ALL, first.batchId, csv("Name,Code,Zeta,Tax Category,Extra\nTea,C1,A,standard,x\n"), "expected_version=2").expect(200);
    expect(res.body.mapping).toBeNull();
    expect(res.body.suggestedMapping).toEqual([
      { columnNumber: 1, target: "name" },
      { columnNumber: 3, target: "sku" },
      { columnNumber: 4, target: "tax_category" },
    ]);
  });

  it("does not carry a changed or repeated header, and the other columns get the synonym suggestion", async () => {
    if (skip()) return;
    const first = await open("Zeta,Name,Tax Category\nA,Tea,standard\n");
    await setMapping(first.batchId, 1, [
      { columnNumber: 1, target: "sku" },
      { columnNumber: 2, target: "name" },
      { columnNumber: 3, target: "tax_category" },
    ]).expect(200);
    // `Zeta` is renamed (not carried, no synonym); `Name` appears twice (never carried); `Tax Category` is carried.
    const res = await replace(SES_OWNER_ALL, first.batchId, csv("Zeta2,Name,Name,Tax Category,Barcode\nA,Tea,Tea,standard,6223001360018\n"), "expected_version=2").expect(200);
    expect(res.body.suggestedMapping).toEqual([
      { columnNumber: 4, target: "tax_category" },
      { columnNumber: 5, target: "barcode" },
    ]);
  });

  it("returns a validated batch to draft: counts, preview hash and every row outcome are gone, the generation is kept", async () => {
    if (skip()) return;
    const first = await open(V1);
    await setMapping(first.batchId, 1, first.suggestedMapping).expect(200);
    const validated = await validate(first.batchId, 2).expect(200);
    expect(validated.body).toMatchObject({ state: "validated", version: 3 });
    expect(validated.body.previewHash).not.toBeNull();
    const generation = (await batchState(h.env().admin, first.batchId)).validation_generation;
    const res = await replace(SES_OWNER_ALL, first.batchId, csv(V2), "expected_version=3").expect(200);
    expect(res.body).toMatchObject({ state: "draft", version: 4, counts: null, previewHash: null, mapping: null, publishable: false });
    expect(res.body.suggestedMapping).toEqual([
      { columnNumber: 1, target: "sku" },
      { columnNumber: 2, target: "name" },
      { columnNumber: 3, target: "tax_category" },
      { columnNumber: 4, target: "brand" },
    ]);
    const state = await batchState(h.env().admin, first.batchId);
    expect(state.validation_generation).toBe(generation);
    expect(state.mapping).toBeNull();
    const rows = await rowsOf(h.env().admin, TENANT_A, first.batchId);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === null)).toBe(true);
    // Validate needs the mapping confirmed again.
    expectError(await validate(first.batchId, 4), 422, "mapping_required");
  });
});

describe("replace: the file warning", () => {
  it("is computed for the new file: it appears for a file published before and goes away for another", async () => {
    if (skip()) return;
    const published = csv(V2);
    await seedPublishedBatch(h.env().admin, {
      id: "0a000000-0000-7000-8000-000000153701",
      tenantId: TENANT_A,
      actor: OWNER_A_USER,
      sha256: createHash("sha256").update(published).digest("hex"),
      daysAgo: 1,
    });
    const first = await open(published);
    expect(first.warnings.map((w) => w.code)).toEqual(["file_previously_published"]);
    const other = await replace(SES_OWNER_ALL, first.batchId, csv(V1)).expect(200);
    expect(other.body.warnings).toEqual([]);
    const again = await replace(SES_OWNER_ALL, first.batchId, published, "expected_version=2").expect(200);
    expect(again.body.warnings).toMatchObject([{ code: "file_previously_published", publishedBatchId: "0a000000-0000-7000-8000-000000153701" }]);
  });
});

describe("replace: the order of checks", () => {
  it("is 404 for an absent batch, another tenant's batch and a store role (the same non-disclosing answer)", async () => {
    if (skip()) return;
    const first = await open(V1);
    const absent = await replace(SES_OWNER_ALL, "0a000000-0000-7000-8000-000000153799", csv(V2)).expect(404);
    expect(absent.body).toMatchObject({ error: { code: "not_found", message: "Not Found" } });
    expect((await replace(SES_OWNER_B, first.batchId, csv(V2)).expect(404)).body).toEqual(absent.body);
    for (const session of [SES_MANAGER, SES_STAFF]) expect((await replace(session, first.batchId, csv(V2)).expect(404)).body).toEqual(absent.body);
    expect((await batchState(h.env().admin, first.batchId)).version).toBe(1);
  });

  it("lets a tenant admin replace, and refuses a write with no trusted Origin", async () => {
    if (skip()) return;
    const first = await open(V1);
    await replace(SES_ADMIN_SPEC, first.batchId, csv(V2)).expect(200);
    const noOrigin = await h.put(`${IMPORTS}/${first.batchId}/file?expected_version=2`, SES_OWNER_ALL, csv(V1)).set("Content-Type", "application/octet-stream").serialize((b: unknown) => b as string);
    expectError(noOrigin, 403, "origin_rejected");
  });

  it("is 409 import_batch_closed for a cancelled batch and for one past its expiry, 409 version_conflict for a stale version", async () => {
    if (skip()) return;
    const first = await open(V1);
    expectError(await replace(SES_OWNER_ALL, first.batchId, csv(V2), "expected_version=7"), 409, "version_conflict");
    await h.env().admin.query(`UPDATE catalog_import_batches SET expires_at = now() - interval '1 minute' WHERE id = $1`, [first.batchId]);
    expectError(await replace(SES_OWNER_ALL, first.batchId, csv(V2)), 409, "import_batch_closed");
    await h.env().admin.query(`UPDATE catalog_import_batches SET state = 'cancelled', closed_at = now(), expires_at = NULL WHERE id = $1`, [first.batchId]);
    expectError(await replace(SES_OWNER_ALL, first.batchId, csv(V2)), 409, "import_batch_closed");
  });

  it("checks the batch before parsing: a bad file for a closed batch is the 409, not the 422", async () => {
    if (skip()) return;
    const first = await open(V1);
    await h.env().admin.query(`UPDATE catalog_import_batches SET state = 'cancelled', closed_at = now(), expires_at = NULL WHERE id = $1`, [first.batchId]);
    expectError(await replace(SES_OWNER_ALL, first.batchId, Buffer.from([0xc3, 0x28])), 409, "import_batch_closed");
  });

  it.each(["", "expected_version=0", "expected_version=abc", "expected_version=1&mode=create", "expected_version=1&delimiter=pipe"])("is 400 validation_error for the query %j, before the body is read", async (query) => {
    if (skip()) return;
    const first = await open(V1);
    expectError(await replace(SES_OWNER_ALL, first.batchId, csv(V2), query), 400, "validation_error");
    expect((await batchState(h.env().admin, first.batchId)).version).toBe(1);
  });

  it("is 400 validation_error for a malformed batch id", async () => {
    if (skip()) return;
    expectError(await replace(SES_OWNER_ALL, "not-a-uuid", csv(V2)), 400, "validation_error");
  });

  it("is 401 without a session", async () => {
    if (skip()) return;
    const first = await open(V1);
    expectError(await replace(null, first.batchId, csv(V2)), 401, "unauthorized");
  });
});

describe("replace: a refused file leaves the batch as it was", () => {
  const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);

  it.each<[string, () => Buffer, string, number, string]>([
    ["an .xls file", () => OLE2, "expected_version=1", 422, "file_type_unsupported"],
    ["a CSV that is not UTF-8", () => Buffer.from([0x61, 0x2c, 0xff, 0xfe, 0x0a, 0x31]), "expected_version=1", 422, "encoding_not_utf8"],
    ["a CSV with no data row", () => csv("sku,name\n"), "expected_version=1", 422, "no_data_rows"],
    ["a sheet name for a CSV", () => csv(V1), "expected_version=1&sheet=Products", 400, "validation_error"],
  ])("%s: nothing is written", async (_label, bytes, query, status, code) => {
    if (skip()) return;
    const first = await open(V1);
    const before = await batchState(h.env().admin, first.batchId);
    const rowsBefore = await rowsOf(h.env().admin, TENANT_A, first.batchId);
    expectError(await replace(SES_OWNER_ALL, first.batchId, bytes(), query), status, code);
    expect(await batchState(h.env().admin, first.batchId)).toEqual(before);
    expect(await rowsOf(h.env().admin, TENANT_A, first.batchId)).toEqual(rowsBefore);
    expect(await audits()).toHaveLength(1);
    // The slot is free again and the batch can still be replaced.
    await replace(SES_OWNER_ALL, first.batchId, csv(V2)).expect(200);
  });

  it("is 413 past 5 MiB and leaves the batch as it was", async () => {
    if (skip()) return;
    const first = await open(V1);
    expectError(await replace(SES_OWNER_ALL, first.batchId, Buffer.alloc(5 * MIB + 1, 0x61)), 413, "file_too_large");
    expect((await batchState(h.env().admin, first.batchId)).version).toBe(1);
    expect(await countRows(h.env().admin, TENANT_A)).toBe(2);
  });

  it("is 400 for an empty body", async () => {
    if (skip()) return;
    const first = await open(V1);
    expectError(await replace(SES_OWNER_ALL, first.batchId, Buffer.alloc(0)), 400, "validation_error");
  });
});

describe("replace: two at once", () => {
  it("lets exactly one win; the other is turned away (429 per-tenant slot, or 409 once the first is stored)", async () => {
    if (skip()) return;
    const first = await open(V1);
    const [x, y] = await Promise.all([replace(SES_OWNER_ALL, first.batchId, csv(V2)), replace(SES_OWNER_ALL, first.batchId, csv("SKU,Name,Tax Category\nZ-1,Zinc,standard\n"))]);
    const winner = x.status === 200 ? x : y;
    const loser = x.status === 200 ? y : x;
    expect(winner.status).toBe(200);
    expect([409, 429]).toContain(loser.status);
    if (loser.status === 409) expectError(loser, 409, "version_conflict");
    expect((await batchState(h.env().admin, first.batchId)).version).toBe(2);
    expect(await audits()).toHaveLength(2);
  });
});

/** A batch whose rows have outcomes: one ready row, one `error` row (an existing SKU) and one `needs_review` row (no identifier). */
async function validatedWithProblems(): Promise<Batch> {
  const text = [
    "SKU,Name,Tax Category,-Notes",
    "N-1,Tea,standard,ok",
    'A-1,"=HYPERLINK(""http://x"")",standard,@x',
    ",Plain,standard,hello",
    "",
  ].join("\n");
  const batch = await open(text, "create");
  await setMapping(batch.batchId, 1, [
    { columnNumber: 1, target: "sku" },
    { columnNumber: 2, target: "name" },
    { columnNumber: 3, target: "tax_category" },
    { columnNumber: 4, target: "ignore" },
  ]).expect(200);
  const validated = await validate(batch.batchId, 2).expect(200);
  expect(validated.body.counts).toMatchObject({ ready_create: 1, error: 1, needs_review: 1 });
  return validated.body as Batch;
}

describe("error report", () => {
  it("lists only the error and needs_review rows in row order, as a UTF-8 CSV with a BOM, safe against formula injection", async () => {
    if (skip()) return;
    const batch = await validatedWithProblems();
    const res = await rawGet(`${IMPORTS}/${batch.batchId}/error-report`, SES_OWNER_ALL).expect(200);
    const bytes = res.body as Buffer;
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="import-errors-${batch.batchId}.csv"; filename*=UTF-8''import-errors-${batch.batchId}.csv`);
    const lines = bytes.toString("utf8").slice(1).split("\r\n");
    // The header line: the fixed columns, then the file's own headers (a leading minus is guarded).
    expect(lines[0]).toBe("row_number,status,issues,SKU,Name,Tax Category,'-Notes");
    const dataLines = lines.slice(1).filter((l) => l !== "");
    expect(dataLines).toHaveLength(2);
    expect(dataLines[0]!.startsWith("3,error,")).toBe(true);
    expect(dataLines[0]).toContain("already_exists");
    // The `=` cell and the `@` cell are written with a leading quote, the formula text kept.
    expect(dataLines[0]).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(dataLines[0]!.endsWith(",'@x")).toBe(true);
    expect(dataLines[1]!.startsWith("4,needs_review,")).toBe(true);
    expect(dataLines[1]).toContain("no_identifier");
    expect(dataLines[1]!.endsWith(",Plain,standard,hello")).toBe(true);
    // The ready row is not in the report.
    expect(bytes.toString("utf8")).not.toContain("N-1");
    // Read-only: the batch is untouched.
    expect((await h.get(`${IMPORTS}/${batch.batchId}`, SES_OWNER_ALL).expect(200)).body.version).toBe(batch.version);
  });

  it("is the header line alone when no row is left to report", async () => {
    if (skip()) return;
    const batch = await open(V1);
    await setMapping(batch.batchId, 1, batch.suggestedMapping).expect(200);
    await validate(batch.batchId, 2).expect(200);
    const res = await rawGet(`${IMPORTS}/${batch.batchId}/error-report`, SES_OWNER_ALL).expect(200);
    expect((res.body as Buffer).toString("utf8")).toBe("\uFEFFrow_number,status,issues,SKU,Name,Tax Category\r\n");
  });

  it("is 409 import_batch_not_validated for a draft and for a cancelled batch, 404 for an absent or another tenant's batch and a store role", async () => {
    if (skip()) return;
    const draft = await open(V1);
    expectError(await h.get(`${IMPORTS}/${draft.batchId}/error-report`, SES_OWNER_ALL), 409, "import_batch_not_validated");
    await h.env().admin.query(`UPDATE catalog_import_batches SET state = 'cancelled', closed_at = now(), expires_at = NULL WHERE id = $1`, [draft.batchId]);
    expectError(await h.get(`${IMPORTS}/${draft.batchId}/error-report`, SES_OWNER_ALL), 409, "import_batch_not_validated");
    const absent = await h.get(`${IMPORTS}/0a000000-0000-7000-8000-000000153799/error-report`, SES_OWNER_ALL).expect(404);
    expect((await h.get(`${IMPORTS}/${draft.batchId}/error-report`, SES_OWNER_B).expect(404)).body).toEqual(absent.body);
    expect((await h.get(`${IMPORTS}/${draft.batchId}/error-report`, SES_MANAGER).expect(404)).body).toEqual(absent.body);
    expectError(await h.get(`${IMPORTS}/not-a-uuid/error-report`, SES_OWNER_ALL), 400, "validation_error");
    expectError(await h.get(`${IMPORTS}/${draft.batchId}/error-report`, null), 401, "unauthorized");
  });

  it("an error body is JSON, never labelled as the CSV the route serves", async () => {
    if (skip()) return;
    const draft = await open(V1);
    const res = await h.get(`${IMPORTS}/${draft.batchId}/error-report`, SES_OWNER_ALL).expect(409);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
  });
});

describe("template", () => {
  it("serves the Arabic template by default and the English one for headers=en, each a BOM and one header line", async () => {
    if (skip()) return;
    const ar = await rawGet("/api/v1/catalog/import-template", SES_OWNER_ALL).expect(200);
    expect([...(ar.body as Buffer).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect((ar.body as Buffer).toString("utf8")).toBe(buildTemplateCsv("ar"));
    expect(ar.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(ar.headers["content-disposition"]).toContain('filename="import-template-ar.csv"');
    const en = await rawGet("/api/v1/catalog/import-template", SES_ADMIN_SPEC, { headers: "en" }).expect(200);
    expect((en.body as Buffer).toString("utf8")).toBe(buildTemplateCsv("en"));
    expect(en.headers["content-disposition"]).toContain('filename="import-template-en.csv"');
  });

  it("is the same for every tenant, and its headers are what an upload maps by itself", async () => {
    if (skip()) return;
    const a = await rawGet("/api/v1/catalog/import-template", SES_OWNER_ALL, { headers: "en" }).expect(200);
    const b = await rawGet("/api/v1/catalog/import-template", SES_OWNER_B, { headers: "en" }).expect(200);
    expect((a.body as Buffer).equals(b.body as Buffer)).toBe(true);
    // Upload the template with one data row appended: every column is placed by the suggestion.
    const text = `${(a.body as Buffer).toString("utf8").slice(1)}N-1,6223001360018,,Tea,,,,standard,true,,\r\n`;
    const batch = await open(text);
    expect(batch.suggestedMapping).toHaveLength(11);
    expect(new Set(batch.suggestedMapping.map((m) => m.target)).size).toBe(11);
  });

  it("refuses a bad `headers` value with 400, a store role with the non-disclosing 404, and no session with 401", async () => {
    if (skip()) return;
    expectError(await h.get("/api/v1/catalog/import-template", SES_OWNER_ALL, { headers: "fr" }), 400, "validation_error");
    await h.get("/api/v1/catalog/import-template", SES_MANAGER).expect(404);
    expectError(await h.get("/api/v1/catalog/import-template", null), 401, "unauthorized");
  });
});
