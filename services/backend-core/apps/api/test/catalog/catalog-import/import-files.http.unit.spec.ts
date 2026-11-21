/**
 * RT-1537 (spec 049 S5c): the three routes over real HTTP (supertest on a Nest app) with the services stubbed and the
 * session, tenant and role guards allowed: the routes and verbs, the headers, the raw bytes (the BOM), the raw-body
 * passthrough of the replace, the order of its intake checks and the status each refusal answers. No Docker; the
 * database behaviour is `catalog-import-files.http.integration.spec.ts`.
 */
import "reflect-metadata";

import { ArgumentsHost, Catch, type ExceptionFilter, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { ZodError } from "zod";

import { RolesGuard, SessionOnlyAdminGuard } from "../../../src/auth";
import { CatalogImportController } from "../../../src/catalog/catalog-import/catalog-import.controller";
import { CatalogImportFilesService } from "../../../src/catalog/catalog-import/catalog-import.files.service";
import { CatalogImportPublishService } from "../../../src/catalog/catalog-import/catalog-import.publish.service";
import { CatalogImportReviewService } from "../../../src/catalog/catalog-import/catalog-import.review.service";
import { CatalogImportService, ImportBatchNotFoundError } from "../../../src/catalog/catalog-import/catalog-import.service";
import { ImportBatchRefusedError } from "../../../src/catalog/catalog-import/import-batch-refusal";
import { ImportFileRejectedError } from "../../../src/catalog/catalog-import/import-file-rejected";
import { ImportReplaceIntakeGuard } from "../../../src/catalog/catalog-import/import-replace-intake.guard";
import { importUploadPassthrough, ImportUploadIntakeGuard } from "../../../src/catalog/catalog-import/import-upload-intake.guard";
import { IMPORT_UPLOAD_GATE, ImportUploadGate } from "../../../src/catalog/catalog-import/import-upload.gate";
import { buildTemplateCsv } from "../../../src/catalog/catalog-import/import-template";
import { TenantContextGuard } from "../../../src/context";

const BATCH = "0192f000-0000-7000-8000-000000000001";
const IMPORTS = "/api/v1/catalog/imports";

/** The global filter's mapping of a request-shape error, as the product's own filter answers it. */
@Catch(ZodError)
class ZodTo400 implements ExceptionFilter {
  catch(_error: ZodError, host: ArgumentsHost): void {
    host.switchToHttp().getResponse().status(400).json({ error: { code: "validation_error", message: "bad request" } });
  }
}

const allow = {
  canActivate: (ctx: { switchToHttp(): { getRequest(): { context?: unknown } } }): boolean => {
    ctx.switchToHttp().getRequest().context = { tenantId: "tenant-1", userId: "user-1" };
    return true;
  },
};

const files = { replaceFile: jest.fn(), errorReport: jest.fn() };
let gate: ImportUploadGate;
let app: INestApplication;

beforeEach(async () => {
  files.replaceFile.mockReset();
  files.errorReport.mockReset();
  gate = new ImportUploadGate(1);
  const moduleRef = await Test.createTestingModule({
    controllers: [CatalogImportController],
    providers: [
      { provide: CatalogImportService, useValue: {} },
      { provide: CatalogImportReviewService, useValue: {} },
      { provide: CatalogImportPublishService, useValue: {} },
      { provide: CatalogImportFilesService, useValue: files },
      { provide: IMPORT_UPLOAD_GATE, useValue: gate },
      ImportUploadIntakeGuard,
      ImportReplaceIntakeGuard,
    ],
  })
    .overrideGuard(SessionOnlyAdminGuard)
    .useValue(allow)
    .overrideGuard(TenantContextGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();
  app = moduleRef.createNestApplication();
  app.use(importUploadPassthrough);
  app.useGlobalFilters(new ZodTo400());
  await app.init();
});

afterEach(async () => {
  await app.close();
});

/** The raw response bytes (supertest would decode a CSV body and could drop the BOM). */
function raw(req: request.Test): request.Test {
  return req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => done(null, Buffer.concat(chunks)));
  });
}

const server = (): Parameters<typeof request>[0] => app.getHttpServer() as Parameters<typeof request>[0];

describe("GET /api/v1/catalog/import-template", () => {
  it("answers the Arabic template by default: UTF-8 CSV, a BOM as the first three bytes, an attachment", async () => {
    const res = await raw(request(server()).get("/api/v1/catalog/import-template")).expect(200);
    const bytes = res.body as Buffer;
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf8")).toBe(buildTemplateCsv("ar"));
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe(`attachment; filename="import-template-ar.csv"; filename*=UTF-8''import-template-ar.csv`);
  });

  it("answers the English template for headers=en", async () => {
    const res = await raw(request(server()).get("/api/v1/catalog/import-template?headers=en")).expect(200);
    expect((res.body as Buffer).toString("utf8")).toBe(buildTemplateCsv("en"));
    expect(res.headers["content-disposition"]).toContain("import-template-en.csv");
  });

  it.each(["headers=fr", "headers=ar&headers=en", "headers=ar&x=1"])("answers 400 for %s", async (query) => {
    const res = await request(server()).get(`/api/v1/catalog/import-template?${query}`).expect(400);
    // A refusal is JSON, never labelled as the CSV the route serves.
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body.error.code).toBe("validation_error");
  });
});

describe("GET /api/v1/catalog/imports/{batchId}/error-report", () => {
  it("serves the service's CSV bytes with the BOM, no-store and the disposition", async () => {
    const csv = "﻿row_number,status,issues\r\n2,error,x\r\n";
    files.errorReport.mockResolvedValue({ csv, disposition: `attachment; filename="import-errors-${BATCH}.csv"; filename*=UTF-8''import-errors-${BATCH}.csv` });
    const res = await raw(request(server()).get(`${IMPORTS}/${BATCH.toUpperCase()}/error-report`)).expect(200);
    expect([...(res.body as Buffer).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect((res.body as Buffer).toString("utf8")).toBe(csv);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-disposition"]).toContain(`import-errors-${BATCH}.csv`);
    // The session's tenant and the lower-cased id.
    expect(files.errorReport).toHaveBeenCalledWith("tenant-1", BATCH);
  });

  it("answers 400 for a malformed id before any read", async () => {
    await request(server()).get(`${IMPORTS}/not-a-uuid/error-report`).expect(400);
    expect(files.errorReport).not.toHaveBeenCalled();
  });

  it("answers the non-disclosing 404 and the not-validated 409", async () => {
    files.errorReport.mockRejectedValueOnce(new ImportBatchNotFoundError());
    const missing = await request(server()).get(`${IMPORTS}/${BATCH}/error-report`).expect(404);
    expect(missing.headers["content-type"]).toMatch(/^application\/json/);
    expect(missing.body).toMatchObject({ code: "not_found", message: "Not Found" });
    files.errorReport.mockRejectedValueOnce(new ImportBatchRefusedError("import_batch_not_validated"));
    const draft = await request(server()).get(`${IMPORTS}/${BATCH}/error-report`).expect(409);
    expect(draft.body.code).toBe("import_batch_not_validated");
  });
});

describe("PUT /api/v1/catalog/imports/{batchId}/file", () => {
  const put = (query: string, body: Buffer, contentType = "application/octet-stream"): request.Test =>
    request(server())
      .put(`${IMPORTS}/${BATCH}/file?${query}`)
      .set("Content-Type", contentType)
      .serialize((b: unknown) => b as string)
      .send(body);

  it("hands the raw bytes, their SHA-256 and the query to the service, whatever the Content-Type, and releases the slot", async () => {
    files.replaceFile.mockResolvedValue({ batchId: BATCH, version: 4 });
    // Bytes that are not JSON, declared as JSON: only the passthrough keeps the body parser off them.
    const bytes = Buffer.from("not json {{{ sku,name\n1,Tea\n", "utf8");
    const res = await put("expected_version=3&file_name=fixed.csv&delimiter=comma", bytes, "application/json").expect(200);
    expect(res.body).toEqual({ batchId: BATCH, version: 4 });
    expect(res.headers["cache-control"]).toBe("no-store");
    const [input, id, file] = files.replaceFile.mock.calls[0] as [{ tenantId: string }, string, { bytes: Buffer; sha256: string; query: unknown }];
    expect(input.tenantId).toBe("tenant-1");
    expect(id).toBe(BATCH);
    expect(file.bytes.equals(bytes)).toBe(true);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.query).toEqual({ expected_version: 3, file_name: "fixed.csv", delimiter: "comma" });
    expect(gate.active()).toBe(0);
  });

  it("has no Idempotency-Key requirement: it is idempotent by expected_version", async () => {
    files.replaceFile.mockResolvedValue({ batchId: BATCH });
    await put("expected_version=1", Buffer.from("a\n1\n")).expect(200);
    expect(files.replaceFile).toHaveBeenCalledTimes(1);
  });

  it("refuses a missing, malformed or extra query value with 400 before taking a slot or reading the body", async () => {
    for (const query of ["", "expected_version=0", "expected_version=abc", "expected_version=1&mode=create", "expected_version=1&expected_version=2"]) {
      const res = await put(query, Buffer.from("a\n1\n")).expect(400);
      expect(res.body.error.code).toBe("validation_error");
    }
    expect(files.replaceFile).not.toHaveBeenCalled();
    expect(gate.active()).toBe(0);
  });

  it("refuses a malformed batch id with 400", async () => {
    await request(server()).put(`${IMPORTS}/nope/file?expected_version=1`).set("Content-Type", "application/octet-stream").send(Buffer.from("a")).expect(400);
    expect(files.replaceFile).not.toHaveBeenCalled();
  });

  it("answers 429 with Retry-After while the upload slot of the tenant is held, without reading the body", async () => {
    const held = gate.tryAcquire("tenant-1");
    expect(held).not.toBeNull();
    const res = await put("expected_version=1", Buffer.from("a\n1\n")).expect(429);
    expect(res.body.code ?? res.body.error?.code).toBe("rate_limited");
    expect(res.headers["retry-after"]).toBe("5");
    expect(files.replaceFile).not.toHaveBeenCalled();
    held?.responseEnded();
    held?.end();
  });

  it("answers 400 for an empty body and frees the slot", async () => {
    await put("expected_version=1", Buffer.alloc(0)).expect(400);
    expect(files.replaceFile).not.toHaveBeenCalled();
    expect(gate.active()).toBe(0);
  });

  it("answers the contract's refusals: 409 version_conflict, 409 import_batch_closed, 404, 422 file refusal, 400 validation_error", async () => {
    const cases: Array<[Error, number, string]> = [
      [new ImportBatchRefusedError("version_conflict"), 409, "version_conflict"],
      [new ImportBatchRefusedError("import_batch_closed"), 409, "import_batch_closed"],
      [new ImportBatchNotFoundError(), 404, "not_found"],
      [new ImportFileRejectedError("file_unreadable"), 422, "file_unreadable"],
      [new ImportFileRejectedError("sheet_not_found"), 422, "sheet_not_found"],
      [new ImportFileRejectedError("validation_error"), 400, "validation_error"],
    ];
    for (const [error, status, code] of cases) {
      files.replaceFile.mockRejectedValueOnce(error);
      const res = await put("expected_version=1", Buffer.from("a\n1\n")).expect(status);
      expect(res.body.code ?? res.body.error?.code).toBe(code);
      expect(gate.active()).toBe(0);
    }
  });

  it("does not turn an unexpected failure into a contract refusal (it stays a 500) and still frees the slot", async () => {
    files.replaceFile.mockRejectedValueOnce(new Error("boom"));
    const res = await put("expected_version=1", Buffer.from("a\n1\n"));
    expect(res.status).toBe(500);
    expect(gate.active()).toBe(0);
  });
});
