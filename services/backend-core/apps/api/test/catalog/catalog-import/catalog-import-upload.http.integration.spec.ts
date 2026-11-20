/**
 * RT-1505 (spec 049 slice S4, part A) — the product import upload and the batch
 * read over HTTP against real Postgres (Testcontainers, every migration
 * including 0124, the NOBYPASSRLS `app_test` pool holding only the production
 * grants of `catalog-import.grants.ts`) and the real module graph
 * (`SessionOnlyAdminGuard`, `TenantContextGuard`, `RolesGuard`, the raw-body
 * intake and the shared `IdempotencyInterceptor` over a fake Redis). Only
 * cookie authentication is faked: a header names the session.
 *
 * What this proves:
 *   - the upload of a CSV and an XLSX creates a `draft` batch at version 1, its
 *     staged rows and one `catalog.import.upload` audit row, in one transaction,
 *     and every body conforms to `catalog-import.yaml`;
 *   - roles: owner / tenant_admin; store_manager and store_staff get the
 *     non-disclosing 404 (upload and read); a bearer is 401; a cookie write
 *     without a trusted Origin is 403 `origin_rejected`;
 *   - the order of checks: the key format and the query are refused before the
 *     body is read; 413 past 5 MiB; the idempotent replay or conflict, then the
 *     one open batch (409 naming it), then the 422 parse;
 *   - idempotency by key + file SHA-256 + canonical query: a replay returns the
 *     stored 201 (`Idempotent-Replayed`) with no second batch or audit row, and
 *     other bytes or any other query value are 409 `idempotency_key_conflict`;
 *   - a refused file writes nothing (no batch, no row, no audit row);
 *   - one open batch per tenant, also under a race; the previous-publish
 *     warning; RLS isolation between two tenants.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import type request from "supertest";

import { CatalogImportModule } from "../../../src/catalog/catalog-import/catalog-import.module";
import { importUploadPassthrough } from "../../../src/catalog/catalog-import/import-upload-intake.guard";
import { CatalogImportService, ImportBatchOpenError, type ImportUpload } from "../../../src/catalog/catalog-import/catalog-import.service";
import { scopedHttpHarness } from "../../_helpers/scoped-http-harness";
import { DASHBOARD_TOKEN, SES_MANAGER, SES_STAFF } from "../../console-sales/__support__/console-sales-fixture";
import { TENANT_A, TENANT_B } from "../__support__/isolation-harness";
import { SES_ADMIN_SPEC, SES_OWNER_ALL } from "../erpnext-reconciliation/__support__/read-store-scope";
import {
  batchesOf,
  closeOpenBatches,
  countRows,
  rowsOf,
  seedImportFixture,
  seedPublishedBatch,
  SES_OWNER_B,
  uploadAudits,
} from "./__support__/catalog-import-fixture";
import { idempotencyProviders } from "./__support__/idempotency-fakes";
import { buildXlsx, buildZip, sheetXml, xlsxEntries, type XlsxCell } from "./__support__/zip-fixtures";

const IMPORTS = "/api/v1/catalog/imports";
const ORIGIN = "http://127.0.0.1";
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const MIB = 1024 * 1024;
const OWNER_A_USER = "0a000000-0000-7000-8000-0000019202a3";

const h = scopedHttpHarness({
  label: "RT-1505 catalog-import upload",
  contractId: "catalog-import",
  module: CatalogImportModule,
  seed: seedImportFixture,
  providers: idempotencyProviders(),
  beforeInit: (app) => app.use(importUploadPassthrough),
});
const skip = (): boolean => h.skipped();

let seq = 0;
const key = (): string => {
  seq += 1;
  return `rt1505-key-${String(seq).padStart(8, "0")}-${Date.now()}`;
};

const csv = (text: string): Buffer => Buffer.from(text, "utf8");
const CSV_A = csv("sku,name,tax_category\nA1,Tea,standard\nA2,Coffee,standard\n");

interface Query {
  mode?: string;
  file_name?: string;
  sheet?: string;
  delimiter?: string;
}

function qs(query: Query | string): string {
  if (typeof query === "string") return query;
  return new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined)).toString();
}

interface UploadOptions {
  readonly key?: string | null;
  readonly origin?: string | null;
  readonly contentType?: string;
  readonly bearer?: string;
  /** A raw session cookie the REAL guard judges (the test session header is not sent), as the RT-1334 Origin test does. */
  readonly cookie?: string;
}

/** The raw bytes as the body, under `contentType` (superagent would JSON- or form-encode a Buffer for those types). */
function upload(session: string | null, bytes: Buffer, query: Query | string = { mode: "create" }, options: UploadOptions = {}): request.Test {
  let req = h.post(`${IMPORTS}?${qs(query)}`, session, bytes);
  req = req.set("Content-Type", options.contentType ?? "application/octet-stream").serialize((body: unknown) => body as string);
  if (options.origin !== null) req = req.set("Origin", options.origin ?? ORIGIN);
  if (options.key !== null) req = req.set("Idempotency-Key", options.key ?? key());
  if (options.bearer !== undefined) req = req.set("Authorization", `Bearer ${options.bearer}`);
  if (options.cookie !== undefined) req = req.set("Cookie", options.cookie);
  return req;
}

function expectError(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  h.conforms("Error", res.body);
}

async function batches(tenant = TENANT_A): ReturnType<typeof batchesOf> {
  return batchesOf(h.env().admin, tenant);
}

let since = new Date(0);
const audits = (tenant = TENANT_A): ReturnType<typeof uploadAudits> => uploadAudits(h.env().admin, tenant, since);

async function expectNothingWritten(tenant = TENANT_A): Promise<void> {
  expect(await batches(tenant)).toHaveLength(0);
  expect(await countRows(h.env().admin, tenant)).toBe(0);
  expect(await audits(tenant)).toHaveLength(0);
}

/** Every test starts with no batch of either tenant: the open-batch rule would otherwise couple them. */
beforeEach(async () => {
  if (h.skipped()) return;
  const { admin } = h.env();
  await admin.query(`UPDATE catalog_import_batches SET state = 'cancelled', closed_at = now(), expires_at = NULL, preview_hash = NULL WHERE state IN ('draft', 'validated')`);
  await admin.query(`DELETE FROM catalog_import_rows`);
  await admin.query(`ALTER TABLE catalog_import_batches DISABLE TRIGGER catalog_import_batches_no_delete_row`);
  await admin.query(`DELETE FROM catalog_import_batches`);
  await admin.query(`ALTER TABLE catalog_import_batches ENABLE TRIGGER catalog_import_batches_no_delete_row`);
  // `audit_events` is append-only: each test reads the rows written since it began.
  since = (await admin.query<{ t: Date }>(`SELECT clock_timestamp() AS t`)).rows[0]!.t;
});

describe("upload: a CSV", () => {
  it("creates the draft batch, its rows and one audit row, and conforms to the contract", async () => {
    if (skip()) return;
    const res = await upload(SES_OWNER_ALL, CSV_A, { mode: "upsert", file_name: "products.csv" }).expect(201);
    h.conforms("CatalogImportBatch", res.body);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
    expect(res.body).toMatchObject({
      state: "draft",
      version: 1,
      mode: "upsert",
      mapping: null,
      // Part B: the header synonyms place sku, name and tax_category (no profile exists).
      suggestedMapping: [
        { columnNumber: 1, target: "sku" },
        { columnNumber: 2, target: "name" },
        { columnNumber: 3, target: "tax_category" },
      ],
      mappingProfileId: null,
      counts: null,
      previewHash: null,
      publishable: false,
      warnings: [],
      publishedAt: null,
      file: { name: "products.csv", kind: "csv", sheetName: null, csvDelimiter: "comma", dataRowCount: 2, columnCount: 3 },
    });
    expect((res.body as { file: { sizeBytes: number } }).file.sizeBytes).toBe(CSV_A.length);
    expect(res.body.columns).toEqual([
      { columnNumber: 1, header: "sku", samples: ["A1", "A2"] },
      { columnNumber: 2, header: "name", samples: ["Tea", "Coffee"] },
      { columnNumber: 3, header: "tax_category", samples: ["standard", "standard"] },
    ]);
    const [batch] = await batches();
    expect(batch).toMatchObject({ id: res.body.batchId, state: "draft", version: 1, created_by: OWNER_A_USER, parser_version: "csv-parse@7.0.3" });
    expect(batch!.expires_in_days).toBeGreaterThan(6.99);
    expect(batch!.expires_in_days).toBeLessThanOrEqual(7);
    expect(await rowsOf(h.env().admin, TENANT_A, res.body.batchId)).toEqual([
      { row_number: 2, cells: ["A1", "Tea", "standard"], status: null },
      { row_number: 3, cells: ["A2", "Coffee", "standard"], status: null },
    ]);
    const written = await audits();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ actor_user_id: OWNER_A_USER, target_id: res.body.batchId, target_type: "catalog_import_batch", store_id: null });
    expect(written[0]!.metadata).toEqual({
      batch_id: res.body.batchId,
      version: 1,
      mode: "upsert",
      file_kind: "csv",
      file_sha256: batch!.file_sha256,
      data_row_count: 2,
      column_count: 3,
      counts: null,
    });
    // §XIV: the audit row names no cell, header or file name.
    expect(JSON.stringify(written[0]!.metadata)).not.toMatch(/Tea|products\.csv|sku/);
  });

  it("is a draft the GET returns unchanged", async () => {
    if (skip()) return;
    const created = await upload(SES_OWNER_ALL, CSV_A).expect(201);
    const read = await h.get(`${IMPORTS}/${created.body.batchId}`, SES_OWNER_ALL).expect(200);
    h.conforms("CatalogImportBatch", read.body);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(read.body).toEqual(created.body);
  });

  it("reads Arabic text, leading-zero identifiers and a chosen delimiter, whatever the Content-Type", async () => {
    if (skip()) return;
    const arabic = csv("\u{627}\u{644}\u{628}\u{627}\u{631}\u{643}\u{648}\u{62F};\u{627}\u{644}\u{627}\u{633}\u{645}\n0012345678905;\u{634}\u{627}\u{64A}\n");
    const res = await upload(SES_OWNER_ALL, arabic, { mode: "create", delimiter: "semicolon" }, { contentType: "application/json" }).expect(201);
    expect(res.body.file).toMatchObject({ csvDelimiter: "semicolon", columnCount: 2 });
    const [row] = await rowsOf(h.env().admin, TENANT_A, res.body.batchId);
    expect(row!.cells).toEqual(["0012345678905", "\u{634}\u{627}\u{64A}"]);
  });

  it("accepts the tenant_admin role too", async () => {
    if (skip()) return;
    await upload(SES_ADMIN_SPEC, CSV_A).expect(201);
  });
});

function rows(...rowsIn: XlsxCell[][]): { name: string; rows: XlsxCell[][] } {
  return { name: "Products", rows: rowsIn };
}

describe("upload: an XLSX", () => {
  it("stages typed cells: text kept byte for byte, a number cell tagged, a formula tagged with its cached value", async () => {
    if (skip()) return;
    const book = buildXlsx([
      rows(["barcode", "name", "tax_category"], ["0012345678905", { formula: "UPPER(\"tea\")", cached: "TEA" }, "standard"], [{ num: "6220000000001" }, "Coffee", { formula: "1" }]),
    ]);
    const res = await upload(SES_OWNER_ALL, book, { mode: "create", file_name: "book.xlsx" }).expect(201);
    h.conforms("CatalogImportBatch", res.body);
    expect(res.body.file).toMatchObject({ kind: "xlsx", sheetName: "Products", csvDelimiter: null, dataRowCount: 2, columnCount: 3, name: "book.xlsx" });
    expect((res.body.file as { parserVersion: string }).parserVersion).toBe("read-excel-file@9.3.17+zip-guard@1");
    expect(await rowsOf(h.env().admin, TENANT_A, res.body.batchId)).toEqual([
      { row_number: 2, cells: ["0012345678905", { t: "f", v: "TEA" }, "standard"], status: null },
      { row_number: 3, cells: [{ t: "n", v: "6220000000001" }, "Coffee", { t: "f", v: null }], status: null },
    ]);
  });

  it("reads the sheet named, and refuses `delimiter` with an XLSX (400) and an unknown sheet (422)", async () => {
    if (skip()) return;
    const book = buildXlsx([rows(["a"], ["first"]), { name: "Second", rows: [["a"], ["second"]] }]);
    const res = await upload(SES_OWNER_ALL, book, { mode: "create", sheet: "Second" }).expect(201);
    expect(res.body.file.sheetName).toBe("Second");
    await closeOpenBatches(h.env().admin, TENANT_A);
    expectError(await upload(SES_OWNER_ALL, book, { mode: "create", delimiter: "comma" }), 400, "validation_error");
    expectError(await upload(SES_OWNER_ALL, book, { mode: "create", sheet: "Nope" }), 422, "sheet_not_found");
  });
});

describe("upload: roles, session and Origin", () => {
  it.each([
    ["store_manager", SES_MANAGER],
    ["store_staff", SES_STAFF],
  ])("%s gets the non-disclosing 404 on the upload and the read, and nothing is written", async (_role, session) => {
    if (skip()) return;
    const denied = await upload(session, CSV_A);
    expect(denied.status).toBe(404);
    expect((denied.body as { error: { code: string; message: string } }).error).toMatchObject(NOT_FOUND);
    h.conforms("Error", denied.body);
    const owned = await upload(SES_OWNER_ALL, CSV_A).expect(201);
    const read = await h.get(`${IMPORTS}/${owned.body.batchId}`, session);
    expect(read.status).toBe(404);
    expect((read.body as { error: { code: string } }).error.code).toBe("not_found");
    expect(await batches()).toHaveLength(1);
  });

  it("answers 401 with no session and with a bearer only", async () => {
    if (skip()) return;
    expectError(await upload(null, CSV_A), 401, "unauthorized");
    expectError(await upload(null, CSV_A, { mode: "create" }, { bearer: DASHBOARD_TOKEN }), 401, "unauthorized");
    await expectNothingWritten();
  });

  it("refuses a cookie write without a trusted Origin with 403 origin_rejected", async () => {
    if (skip()) return;
    const cookie = "dp2_session=rt1505-not-a-session";
    expectError(await upload(null, CSV_A, { mode: "create" }, { origin: null, cookie }), 403, "origin_rejected");
    expectError(await upload(null, CSV_A, { mode: "create" }, { origin: "http://evil.example", cookie }), 403, "origin_rejected");
    await expectNothingWritten();
  });
});

describe("upload: the order of checks", () => {
  it("refuses a missing or malformed Idempotency-Key with 400 before anything else", async () => {
    if (skip()) return;
    expectError(await upload(SES_OWNER_ALL, CSV_A, { mode: "create" }, { key: null }), 400, "idempotency_key_required");
    expectError(await upload(SES_OWNER_ALL, CSV_A, { mode: "create" }, { key: "too-short" }), 400, "idempotency_key_malformed");
    await expectNothingWritten();
  });

  it.each([
    ["no mode", {}],
    ["an unknown mode", { mode: "merge" }],
    ["an unknown query key", "mode=create&tenant_id=x"],
    ["a repeated mode", "mode=create&mode=update"],
    ["an empty sheet", "mode=create&sheet="],
    ["a sheet over 31 characters", `mode=create&sheet=${"x".repeat(32)}`],
    ["an unknown delimiter", "mode=create&delimiter=pipe"],
    ["a file name with a slash", "mode=create&file_name=a%2Fb.csv"],
    ["a file name with a control character", "mode=create&file_name=a%0Ab.csv"],
    ["a file name over 255 characters", `mode=create&file_name=${"x".repeat(256)}`],
  ])("refuses %s with 400 validation_error, before the body is read", async (_label, query) => {
    if (skip()) return;
    expectError(await upload(SES_OWNER_ALL, CSV_A, query as Query | string), 400, "validation_error");
    await expectNothingWritten();
  });

  it("refuses an empty body with 400 validation_error", async () => {
    if (skip()) return;
    expectError(await upload(SES_OWNER_ALL, Buffer.alloc(0)), 400, "validation_error");
  });

  it("refuses a body over 5 MiB with 413 file_too_large, and writes nothing", async () => {
    if (skip()) return;
    expectError(await upload(SES_OWNER_ALL, Buffer.alloc(5 * MIB + 1, 0x61)), 413, "file_too_large");
    await expectNothingWritten();
  });

  it("lets exactly 5 MiB through the size gate (it is then the parser's to refuse)", async () => {
    if (skip()) return;
    expectError(await upload(SES_OWNER_ALL, Buffer.alloc(5 * MIB, 0x61)), 422, "cell_too_long");
    await expectNothingWritten();
  });

  it("checks the replay and the one-open-batch rule before the parse: a bad file under a new key is 409, not 422", async () => {
    if (skip()) return;
    const first = await upload(SES_OWNER_ALL, CSV_A).expect(201);
    const bad = await upload(SES_OWNER_ALL, Buffer.from([0xff, 0xfe, 0x00]));
    expect(bad.status).toBe(409);
    expect(bad.body.error).toMatchObject({ code: "import_batch_open", openBatchId: first.body.batchId });
  });

  it("answers `sheet` with a CSV as 400 validation_error (the type decides)", async () => {
    if (skip()) return;
    expectError(await upload(SES_OWNER_ALL, CSV_A, { mode: "create", sheet: "Products" }), 400, "validation_error");
    await expectNothingWritten();
  });
});

describe("upload: idempotency by key + file SHA-256 + canonical query", () => {
  it("replays the stored 201 for the same key, bytes and query: no second batch, row set or audit row", async () => {
    if (skip()) return;
    const k = key();
    const first = await upload(SES_OWNER_ALL, CSV_A, { mode: "create", file_name: "a.csv" }, { key: k }).expect(201);
    const replay = await upload(SES_OWNER_ALL, CSV_A, { mode: "create", file_name: "a.csv" }, { key: k }).expect(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.headers["cache-control"]).toBe("no-store");
    expect(replay.body).toEqual(first.body);
    h.conforms("CatalogImportBatch", replay.body);
    expect(await batches()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
    expect(await countRows(h.env().admin, TENANT_A)).toBe(2);
  });

  it("is 409 idempotency_key_conflict for the same key with other bytes, though the body is not parsed", async () => {
    if (skip()) return;
    const k = key();
    await upload(SES_OWNER_ALL, CSV_A, { mode: "create" }, { key: k }).expect(201);
    const other = await upload(SES_OWNER_ALL, csv("sku,name,tax_category\nB1,Milk,standard\n"), { mode: "create" }, { key: k });
    expectError(other, 409, "idempotency_key_conflict");
    h.conforms("UploadConflictError", other.body);
    expect(other.body.error.openBatchId).toBeUndefined();
    expect(await batches()).toHaveLength(1);
  });

  it.each([
    ["another mode", { mode: "update" }],
    ["another file_name", { mode: "create", file_name: "b.csv" }],
    ["an absent file_name against a given one", { mode: "create" }],
    ["an explicit delimiter equal to the detected one (an absent one is distinct)", { mode: "create", file_name: "a.csv", delimiter: "comma" }],
  ])("is 409 idempotency_key_conflict for the same key and bytes with %s", async (_label, query) => {
    if (skip()) return;
    const k = key();
    await upload(SES_OWNER_ALL, CSV_A, { mode: "create", file_name: "a.csv" }, { key: k }).expect(201);
    expectError(await upload(SES_OWNER_ALL, CSV_A, query, { key: k }), 409, "idempotency_key_conflict");
  });

  it("compares file names byte for byte: NFC and NFD of the same Arabic-Latin name are different values", async () => {
    if (skip()) return;
    const k = key();
    const nfc = "caf\u{e9}.csv";
    const nfd = "cafe\u{301}.csv";
    await upload(SES_OWNER_ALL, CSV_A, { mode: "create", file_name: nfc }, { key: k }).expect(201);
    expectError(await upload(SES_OWNER_ALL, CSV_A, { mode: "create", file_name: nfd }, { key: k }), 409, "idempotency_key_conflict");
    await upload(SES_OWNER_ALL, CSV_A, { mode: "create", file_name: nfc }, { key: k }).expect(201);
  });

  it("does not replay a refused upload: the same key can be sent again with a fixed file", async () => {
    if (skip()) return;
    const k = key();
    expectError(await upload(SES_OWNER_ALL, Buffer.from([0xc3, 0x28]), { mode: "create" }, { key: k }), 422, "encoding_not_utf8");
    // The refusal released the claim; the fixed file under the same key is a new fingerprint but no stored one.
    await upload(SES_OWNER_ALL, CSV_A, { mode: "create" }, { key: k }).expect(201);
  });
});

describe("upload: one open batch per tenant", () => {
  it("is 409 import_batch_open naming the open batch, then allowed again once it is closed", async () => {
    if (skip()) return;
    const first = await upload(SES_OWNER_ALL, CSV_A).expect(201);
    const second = await upload(SES_OWNER_ALL, CSV_A);
    expectError(second, 409, "import_batch_open");
    h.conforms("UploadConflictError", second.body);
    expect(second.body.error.openBatchId).toBe(first.body.batchId);
    expect(await batches()).toHaveLength(1);
    await closeOpenBatches(h.env().admin, TENANT_A);
    await upload(SES_OWNER_ALL, CSV_A).expect(201);
    expect(await batches()).toHaveLength(2);
  });

  it("lets exactly one of two concurrent uploads of a tenant win: the other is turned away (429 per-tenant slot, or 409 once the first is stored)", async () => {
    if (skip()) return;
    const [x, y] = await Promise.all([
      upload(SES_OWNER_ALL, csv("sku,name,tax_category\nX1,One,standard\n")),
      upload(SES_OWNER_ALL, csv("sku,name,tax_category\nY1,Two,standard\n")),
    ]);
    const winner = x.status === 201 ? x : y;
    const loser = x.status === 201 ? y : x;
    expect(winner.status).toBe(201);
    expect([409, 429]).toContain(loser.status);
    if (loser.status === 409) expect(loser.body.error).toMatchObject({ code: "import_batch_open", openBatchId: winner.body.batchId });
    else expectError(loser, 429, "rate_limited");
    expect(await batches()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it("holds the one-open-batch rule in the database too: two concurrent service uploads of a tenant, one wins on the unique index", async () => {
    if (skip()) return;
    // Below the HTTP slot, so the unique index (not the per-tenant slot) is what decides.
    const service = new CatalogImportService(h.env().app);
    const file = (text: string): ImportUpload => {
      const bytes = csv(text);
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), query: { mode: "create" } };
    };
    const input = { tenantId: TENANT_A, actorUserId: OWNER_A_USER, requestId: null };
    const results = await Promise.allSettled([
      service.upload(input, file("sku,name,tax_category\nX1,One,standard\n")),
      service.upload(input, file("sku,name,tax_category\nY1,Two,standard\n")),
    ]);
    const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<CatalogImportService["upload"]>>> => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(ImportBatchOpenError);
    expect((lost[0]!.reason as ImportBatchOpenError).openBatchId).toBe(won[0]!.value.batchId);
    expect(await batches()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it("does not let tenant A's open batch block tenant B", async () => {
    if (skip()) return;
    await upload(SES_OWNER_ALL, CSV_A).expect(201);
    await upload(SES_OWNER_B, CSV_A).expect(201);
    expect(await batches(TENANT_A)).toHaveLength(1);
    expect(await batches(TENANT_B)).toHaveLength(1);
  });
});

describe("upload: a refused file writes nothing", () => {
  const MAIN = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
  const tooMany = `sku\n${Array.from({ length: 5001 }, (_v, i) => `S${i}`).join("\n")}\n`;
  const wide = `${Array.from({ length: 51 }, (_v, i) => `h${i}`).join(",")}\n${Array.from({ length: 51 }, () => "1").join(",")}\n`;
  const bomb = buildZip(xlsxEntries([["a"], ["1"]]).map((e) => (e.name === "xl/worksheets/sheet1.xml" ? { ...e, data: Buffer.alloc(120 * MIB, 0x20) } : e)));
  const lying = buildZip(
    xlsxEntries([["a"], ["1"]]).map((e) => {
      if (e.name !== "xl/worksheets/sheet1.xml") return e;
      const comp = deflateRawSync(Buffer.alloc(30 * MIB, 0x20));
      return { ...e, data: Buffer.alloc(40), rawCompressed: comp, central: { uncompressedSize: 40, compressedSize: comp.length }, local: { uncompressedSize: 40, compressedSize: comp.length } };
    }),
  );
  const macro = buildXlsx([rows(["a"], ["1"])], { workbookType: "application/vnd.ms-excel.sheet.macroEnabled.main+xml" });
  const vba = buildXlsx([rows(["a"], ["1"])], { extraEntries: [{ name: "xl/vbaProject.bin", data: "x" }] });
  const ole2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
  const entries201 = [...xlsxEntries([["a"], ["1"]]), ...Array.from({ length: 201 - xlsxEntries([["a"], ["1"]]).length }, (_v, i) => ({ name: `docProps/p${i}.bin`, data: "x" }))];
  const sparse = buildXlsx([rows(["a"])], { sheetXmlOverride: sheetXml([["a"], ["1"]]).replace("</sheetData>", '<row r="600000"><c r="AD600000"><v>1</v></c></row></sheetData>') });

  it.each([
    ["an .xlsm workbook type", macro, 422, "file_type_unsupported"],
    ["a vbaProject.bin entry", vba, 422, "file_type_unsupported"],
    ["an OLE2 (.xls) file", ole2, 422, "file_type_unsupported"],
    ["a non-XLSX zip", buildZip([{ name: "readme.txt", data: "hi" }]), 422, "file_type_unsupported"],
    ["a zip bomb", bomb, 422, "xlsx_limits_exceeded"],
    ["201 zip entries", buildZip(entries201), 422, "xlsx_limits_exceeded"],
    ["a sparse sheet past the memory bound", sparse, 422, "xlsx_limits_exceeded"],
    ["a zip with lying headers", lying, 422, "file_unreadable"],
    ["a CSV that is not UTF-8", Buffer.from([0x61, 0x0a, 0xe9, 0x0a]), 422, "encoding_not_utf8"],
    ["a CSV with a NUL byte", Buffer.from("a,b\n1,\u{0}2\n"), 422, "encoding_not_utf8"],
    ["a CSV quoting error", csv('a,b\n"x,1\n'), 422, "file_unreadable"],
    ["a file with more than 5,000 data rows", csv(tooMany), 422, "too_many_rows"],
    ["a file with more than 50 columns", csv(wide), 422, "too_many_columns"],
    ["a cell over 2,000 characters", csv(`a\n${"x".repeat(2001)}\n`), 422, "cell_too_long"],
    ["a file with no header row", csv("\n\nx\n"), 422, "header_missing"],
    ["a file with no data rows", csv("a,b\n"), 422, "no_data_rows"],
    ["a source file with more than 1,048,576 physical rows", csv(`a\n${"\n".repeat(1_048_576)}`), 422, "file_too_many_rows"],
  ])("refuses %s with %i %s", async (_label, bytes, status, code) => {
    if (skip()) return;
    expect(MAIN).toContain("main+xml");
    expectError(await upload(SES_OWNER_ALL, bytes), status, code);
    await expectNothingWritten();
  });

  it("accepts 5,000 data rows and 50 columns (the limits themselves)", async () => {
    if (skip()) return;
    const exactly = `sku\n${Array.from({ length: 5000 }, (_v, i) => `S${i}`).join("\n")}\n`;
    const res = await upload(SES_OWNER_ALL, csv(exactly)).expect(201);
    expect(res.body.file.dataRowCount).toBe(5000);
    expect(await countRows(h.env().admin, TENANT_A)).toBe(5000);
    await closeOpenBatches(h.env().admin, TENANT_A);
    const fifty = `${Array.from({ length: 50 }, (_v, i) => `h${i}`).join(",")}\n${Array.from({ length: 50 }, () => "1").join(",")}\n`;
    const wideRes = await upload(SES_OWNER_ALL, csv(fifty)).expect(201);
    expect(wideRes.body.file.columnCount).toBe(50);
  });

  it("skips a blank row, keeps its gap in the source row numbers, and keeps every row that has a value", async () => {
    if (skip()) return;
    const res = await upload(SES_OWNER_ALL, csv("sku\nA\n\n  \nB\n")).expect(201);
    expect(res.body.file.dataRowCount).toBe(2);
    expect((await rowsOf(h.env().admin, TENANT_A, res.body.batchId)).map((r) => r.row_number)).toEqual([2, 5]);
  });
});

describe("upload: the previous-publish warning (spec 049 §8.4)", () => {
  const PUBLISHED_RECENT = "0a000000-0000-7000-8000-000015050001";
  const PUBLISHED_OLD = "0a000000-0000-7000-8000-000015050002";
  const PUBLISHED_B = "0b000000-0000-7000-8000-000015050003";

  async function sha(bytes: Buffer): Promise<string> {
    return (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  }

  it("names a batch of this tenant published in the last 30 days with the same file hash, and accepts the file", async () => {
    if (skip()) return;
    const digest = await sha(CSV_A);
    await seedPublishedBatch(h.env().admin, { id: PUBLISHED_RECENT, tenantId: TENANT_A, actor: OWNER_A_USER, sha256: digest, daysAgo: 29 });
    const res = await upload(SES_OWNER_ALL, CSV_A).expect(201);
    h.conforms("CatalogImportBatch", res.body);
    expect(res.body.warnings).toEqual([{ code: "file_previously_published", publishedBatchId: PUBLISHED_RECENT, publishedAt: expect.any(String) }]);
    await h.env().admin.query(`DELETE FROM catalog_import_rows WHERE batch_id = $1`, [res.body.batchId]);
  });

  it("ignores a batch published 31 days ago and a batch of another tenant", async () => {
    if (skip()) return;
    const digest = await sha(CSV_A);
    await seedPublishedBatch(h.env().admin, { id: PUBLISHED_OLD, tenantId: TENANT_A, actor: OWNER_A_USER, sha256: digest, daysAgo: 31 });
    await seedPublishedBatch(h.env().admin, { id: PUBLISHED_B, tenantId: TENANT_B, actor: "0b000000-0000-7000-8000-00001505" + "02b1", sha256: digest, daysAgo: 1 });
    const res = await upload(SES_OWNER_ALL, CSV_A).expect(201);
    expect(res.body.warnings).toEqual([]);
  });
});

describe("batch read: isolation and validation", () => {
  it("is 404 for a batch of another tenant and for an absent one, the same body", async () => {
    if (skip()) return;
    const mine = await upload(SES_OWNER_ALL, CSV_A).expect(201);
    const theirs = await upload(SES_OWNER_B, CSV_A).expect(201);
    expect((await h.get(`${IMPORTS}/${mine.body.batchId}`, SES_OWNER_B)).body).toMatchObject({ error: NOT_FOUND });
    expect((await h.get(`${IMPORTS}/${theirs.body.batchId}`, SES_OWNER_ALL)).body).toMatchObject({ error: NOT_FOUND });
    const absent = await h.get(`${IMPORTS}/0a000000-0000-7000-8000-0000150500ff`, SES_OWNER_ALL);
    expectError(absent, 404, "not_found");
    expect(absent.body.error).toMatchObject(NOT_FOUND);
    await h.get(`${IMPORTS}/${mine.body.batchId}`, SES_OWNER_ALL).expect(200);
    await h.get(`${IMPORTS}/${mine.body.batchId.toUpperCase()}`, SES_OWNER_ALL).expect(200);
  });

  it("stages each tenant's rows under its own tenant id (RLS): the app pool of tenant A sees none of tenant B", async () => {
    if (skip()) return;
    await upload(SES_OWNER_ALL, CSV_A).expect(201);
    await upload(SES_OWNER_B, csv("sku,name,tax_category\nB1,Milk,standard\nB2,Sugar,standard\nB3,Salt,standard\n")).expect(201);
    expect(await countRows(h.env().admin, TENANT_A)).toBe(2);
    expect(await countRows(h.env().admin, TENANT_B)).toBe(3);
    const asA = await h.env().app.connect();
    try {
      await asA.query("BEGIN");
      await asA.query("SELECT set_config('app.current_tenant', $1, true)", [TENANT_A]);
      const seen = await asA.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM catalog_import_rows`);
      expect(seen.rows.map((r) => r.tenant_id)).toEqual([TENANT_A]);
      const batchesSeen = await asA.query<{ tenant_id: string }>(`SELECT DISTINCT tenant_id FROM catalog_import_batches`);
      expect(batchesSeen.rows.map((r) => r.tenant_id)).toEqual([TENANT_A]);
      await asA.query("ROLLBACK");
    } finally {
      asA.release();
    }
  });

  it("refuses a malformed batch id with 400 validation_error", async () => {
    if (skip()) return;
    expectError(await h.get(`${IMPORTS}/not-a-uuid`, SES_OWNER_ALL), 400, "validation_error");
  });

  it("answers 401 with no session", async () => {
    if (skip()) return;
    expectError(await h.get(`${IMPORTS}/0a000000-0000-7000-8000-0000150500ff`, null), 401, "unauthorized");
  });
});
