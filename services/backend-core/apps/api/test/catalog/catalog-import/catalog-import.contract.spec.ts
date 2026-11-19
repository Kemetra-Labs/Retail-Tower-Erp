/**
 * apps/api/test/catalog/catalog-import/catalog-import.contract.spec.ts
 *
 * RT-1502 (spec 049 slice S1): the Console product import contract,
 * `catalog/catalog-import.yaml` 1.0.1-draft. `[GATED]` contract-first; every
 * operation is `x-runtime-status: contract-only` until RT-1505 (S4) and the
 * S5 slice. Owner decisions OD-1..OD-17 accepted (RT-1489 comment 17790).
 *
 * Structural / load-only plus AJV fixtures; no app boot and no HTTP. Pins:
 *   1. The twelve operations at their paths and methods, contract-only with a
 *      note, and no operationId collision with any other contract.
 *   2. Auth: human `cookieAuth` only; owner / tenant_admin; non-disclosing 404;
 *      every write audited as `catalog.import.*` and guarded by `Origin`.
 *   3. Upload: raw body, `Idempotency-Key` + file SHA-256, open-batch 409,
 *      413 / 422 file refusals and the spec 049 §8.5 limits (OD-7 A).
 *   4. Interim batch on spec 042 names (OD-14 A): states, `expectedVersion` /
 *      `version_conflict`, `previewHash`, `stale_validation`.
 *   5. Row statuses, issue codes and the no-price rule (OD-2 A).
 *   6. AJV fixtures for the batch, rows, decisions, preview and publish.
 */
import "reflect-metadata";

import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  allContracts,
  contractDocument,
  contractReader,
  operationIdsExcept,
  type ApiPath,
  type ContractReader,
  type OpenApiDocument,
  type OperationObject,
  type ParameterObject,
} from "../../_helpers/openapi-contract";

const CONTRACT_ID = "catalog-import";

const BASE = "/api/v1/catalog/imports";
const BATCH: ApiPath = `${BASE}/{batchId}`;

type Method = "get" | "post" | "put";

const OPERATIONS: ReadonlyArray<{ id: string; method: Method; path: ApiPath; runtime: RegExp }> = [
  { id: "consoleUploadCatalogImport", method: "post", path: BASE, runtime: /RT-1505/ },
  { id: "consoleGetCatalogImport", method: "get", path: BATCH, runtime: /RT-1505/ },
  { id: "consoleReplaceCatalogImportFile", method: "put", path: `${BATCH}/file`, runtime: /RT-1505/ },
  { id: "consoleSetCatalogImportMapping", method: "put", path: `${BATCH}/mapping`, runtime: /RT-1505/ },
  { id: "consoleValidateCatalogImport", method: "post", path: `${BATCH}/validate`, runtime: /RT-1505/ },
  { id: "consoleListCatalogImportRows", method: "get", path: `${BATCH}/rows`, runtime: /RT-1505/ },
  {
    id: "consoleResolveCatalogImportRow",
    method: "put",
    path: `${BATCH}/rows/{rowNumber}/resolution`,
    runtime: /S5/,
  },
  { id: "consoleGetCatalogImportPreview", method: "get", path: `${BATCH}/preview`, runtime: /S5/ },
  { id: "consolePublishCatalogImport", method: "post", path: `${BATCH}/publish`, runtime: /S5/ },
  { id: "consoleCancelCatalogImport", method: "post", path: `${BATCH}/cancel`, runtime: /RT-1505/ },
  { id: "consoleGetCatalogImportErrorReport", method: "get", path: `${BATCH}/error-report`, runtime: /RT-1505/ },
  { id: "consoleGetCatalogImportTemplate", method: "get", path: "/api/v1/catalog/import-template", runtime: /RT-1505/ },
];

const WRITES = OPERATIONS.filter((o) => o.method !== "get");
const READS = OPERATIONS.filter((o) => o.method === "get");

const BATCH_ID = "0192f000-0000-7000-8000-000000000001";
const PRODUCT = "0192f000-0000-7000-8000-000000000002";
const PRODUCT_2 = "0192f000-0000-7000-8000-000000000003";
const OTHER_BATCH = "0192f000-0000-7000-8000-000000000004";
const HASH = `sha256:${"a".repeat(64)}`;

let doc: OpenApiDocument;
let api: ContractReader;
let otherOperationIds: Set<string>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  doc = contractDocument(contracts, CONTRACT_ID);
  api = contractReader(doc);
  otherOperationIds = operationIdsExcept(contracts, CONTRACT_ID);
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function op(method: Method, path: ApiPath): OperationObject {
  const found = doc.paths?.[path]?.[method];
  if (!found) throw new Error(`${method.toUpperCase()} ${path} not declared`);
  return found;
}

function paramsOf(method: Method, path: ApiPath): ParameterObject[] {
  const own = (op(method, path).parameters ?? []) as ParameterObject[];
  const shared = ((doc.paths?.[path] as Record<string, unknown> | undefined)?.["parameters"] ?? []) as ParameterObject[];
  return [...shared, ...own].map((p) =>
    p.$ref ? doc.components!.parameters![p.$ref.replace("#/components/parameters/", "")]! : p,
  );
}

function responseDescription(method: Method, path: ApiPath, status: string): string {
  const response = op(method, path).responses?.[status];
  if (!response) throw new Error(`${status} not declared on ${method.toUpperCase()} ${path}`);
  return response.$ref ? api.responseDescription(response.$ref.replace("#/components/responses/", "")) : String(response.description);
}

function validator(name: string): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

function info(): string {
  return String(doc.info?.description ?? "");
}

const counts = { ready_create: 3, ready_update: 1, unchanged: 0, needs_review: 1, error: 0, excluded: 0 };

function batchFixture() {
  return {
    batchId: BATCH_ID,
    state: "validated",
    version: 3,
    mode: "upsert",
    file: {
      name: "products.xlsx",
      sizeBytes: 20480,
      sha256: "b".repeat(64),
      kind: "xlsx",
      sheetName: "Sheet1",
      csvDelimiter: null,
      dataRowCount: 5,
      columnCount: 3,
      parserVersion: "1",
    },
    columns: [
      { columnNumber: 1, header: "الباركود", samples: ["6221234567890"] },
      { columnNumber: 2, header: "الاسم", samples: ["شاي"] },
      { columnNumber: 3, header: "السعر", samples: ["12.50"] },
    ],
    mapping: [
      { columnNumber: 1, target: "barcode" },
      { columnNumber: 2, target: "name" },
      { columnNumber: 3, target: "price" },
    ],
    suggestedMapping: [{ columnNumber: 1, target: "barcode" }],
    mappingProfileId: null,
    counts,
    previewHash: HASH,
    publishable: false,
    warnings: [],
    createdAt: "2026-11-19T10:00:00Z",
    updatedAt: "2026-11-19T10:05:00Z",
    expiresAt: "2026-11-26T10:05:00Z",
    publishedAt: null,
  };
}

const productRef = { productId: PRODUCT, name: "شاي", identifiers: [{ type: "barcode", value: "6221234567890" }] };

function rowFixture() {
  return {
    rowNumber: 2,
    status: "needs_review",
    cells: ["6221234567890", "شاي", "12.50"],
    outcome: {
      match: "ambiguous",
      matchedProduct: null,
      candidates: [productRef, { ...productRef, productId: PRODUCT_2 }],
      fieldChanges: [],
      identifierAdds: [],
      identifiersNotAdded: [],
      brandToCreate: null,
    },
    issues: [
      { code: "ambiguous", severity: "review", field: null, columnNumber: null, message: "Two products match." },
      { code: "price_not_imported", severity: "notice", field: "price", columnNumber: 3, message: "Not imported yet." },
    ],
    reviewReason: "ambiguous",
    resolution: null,
    productId: null,
  };
}

describe("catalog-import contract — operations (RT-1502, spec 049 S1)", () => {
  it("declares OpenAPI 3.1 at version 1.0.1-draft", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.0.1-draft");
  });

  it("declares exactly the twelve operations", () => {
    const declared = Object.values(doc.paths ?? {})
      .flatMap((item) => Object.values(item))
      .map((o) => o?.operationId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    expect(declared).toEqual(OPERATIONS.map((o) => o.id).sort());
  });

  it.each(OPERATIONS)("$id is $method at its path, contract-only with a note, unique", ({ id, method, path, runtime }) => {
    const operation = op(method, path);
    expect(operation.operationId).toBe(id);
    expect(operation["x-runtime-status"]).toBe("contract-only");
    expect(String(operation["x-runtime-note"] ?? "")).toMatch(runtime);
    expect(otherOperationIds.has(id)).toBe(false);
  });

  it.each(OPERATIONS)("$id is the human cookieAuth session only", ({ method, path }) => {
    expect(op(method, path).security).toEqual([{ cookieAuth: [] }]);
  });

  it.each(OPERATIONS)("$id never takes tenant or store scope from the request", ({ method, path }) => {
    const names = paramsOf(method, path).map((p) => p.name);
    expect(names).not.toContain("tenant_id");
    expect(names).not.toContain("store_id");
  });

  it.each(OPERATIONS)("$id documents 401, 404, 429 and 500", ({ method, path }) => {
    expect(Object.keys(op(method, path).responses ?? {})).toEqual(expect.arrayContaining(["401", "404", "429", "500"]));
  });

  it.each(WRITES)("$id is an audited catalog.import.* write guarded by Origin", ({ method, path }) => {
    const operation = op(method, path);
    expect(operation["x-audit-action"]).toMatch(/^catalog\.import\.(upload|map|validate|review|publish|cancel)$/);
    expect(responseDescription(method, path, "403")).toMatch(/origin_rejected/);
  });

  it.each(READS)("$id is not audited and answers no 403", ({ method, path }) => {
    expect(op(method, path)["x-audit-action"]).toBeUndefined();
    expect(op(method, path).responses?.["403"]).toBeUndefined();
  });

  it("roles are owner / tenant_admin with a non-disclosing 404", () => {
    expect(info()).toMatch(/`owner` and\s+`tenant_admin`/);
    expect(api.responseDescription("NotFound")).toMatch(/non-disclosing/);
    expect(String(doc.components?.securitySchemes?.["cookieAuth"]?.["description"])).toMatch(
      /@Roles\("owner", "tenant_admin"\)/,
    );
  });
});

describe("catalog-import contract — upload (spec 049 §8.4, §8.5)", () => {
  it("takes the raw file bytes under any content type, with no schema", () => {
    const body = doc.components as unknown as { requestBodies: Record<string, { content: Record<string, unknown> }> };
    expect(body.requestBodies["ImportFile"]!.content).toEqual({ "*/*": {} });
    expect(op("post", BASE).requestBody).toEqual({ $ref: "#/components/requestBodies/ImportFile" });
    expect(op("put", `${BATCH}/file`).requestBody).toEqual({ $ref: "#/components/requestBodies/ImportFile" });
  });

  it("requires Idempotency-Key on the upload and the publish only", () => {
    for (const o of OPERATIONS) {
      const keyed = paramsOf(o.method, o.path).some((p) => p.name === "Idempotency-Key");
      expect([o.id, keyed]).toEqual([
        o.id,
        o.id === "consoleUploadCatalogImport" || o.id === "consolePublishCatalogImport",
      ]);
    }
  });

  it("upload idempotency is the key, the file SHA-256 and the canonical query; any difference is 409 idempotency_key_conflict", () => {
    const key = String(doc.components!.parameters!["IdempotencyKey"]!.description);
    expect(key).toMatch(/key plus the file's SHA-256 plus the canonical query\s+\(`mode`, `sheet`, `delimiter`, `file_name`/);
    expect(info()).toMatch(/SHA-256 of the file bytes plus the canonical query\*\* \(`mode`, `sheet`,\s+`delimiter`, `file_name`/);
    expect(info()).toMatch(/same key with other bytes, or with\s+any query value different, is `409 idempotency_key_conflict`/);
    const conflict = responseDescription("post", BASE, "409");
    expect(conflict).toMatch(/idempotency_key_conflict/);
    expect(conflict).toMatch(/other file bytes, or with any of `mode`,\s+`sheet`, `delimiter` or `file_name` different/);
    expect(String(op("post", BASE).description)).toMatch(/canonical `mode`, `sheet`, `delimiter` and `file_name`/);
    // The four fingerprinted query values are exactly the upload's query parameters.
    const query = paramsOf("post", BASE)
      .filter((p) => p.in === "query")
      .map((p) => p.name)
      .sort();
    expect(query).toEqual(["delimiter", "file_name", "mode", "sheet"]);
  });

  it("the upload takes the mode, and refuses a second open batch naming the open one", () => {
    expect(paramsOf("post", BASE).find((p) => p.name === "mode")?.required).toBe(true);
    expect(responseDescription("post", BASE, "409")).toMatch(/import_batch_open/);
    // Validate against the documented 409 response schema itself, not only the named component (review on #717:
    // a `oneOf` of overlapping envelopes rejected the very body it described).
    const v = ajv.getSchema(`${CONTRACT_ID}#/components/responses/UploadConflict/content/application~1json/schema`);
    if (!v) throw new Error("ajv cannot resolve the UploadConflict response schema");
    expect(v({ error: { code: "import_batch_open", message: "x", request_id: BATCH_ID, openBatchId: OTHER_BATCH } })).toBe(true);
    expect(v({ error: { code: "idempotency_key_conflict", message: "x", request_id: BATCH_ID } })).toBe(true);
    expect(v({ error: { code: "import_batch_open", message: "x" } })).toBe(false);
    expect(v({ error: { code: "idempotency_key_conflict", message: "x", openBatchId: OTHER_BATCH } })).toBe(false);
    expect(v({ error: { code: "version_conflict", message: "x" } })).toBe(false);
  });

  it("states the OD-7 A limits and refuses an oversize body with 413 file_too_large", () => {
    expect(info()).toMatch(/File 5 MiB; 5,000 data rows; 50 columns/);
    expect(info()).toMatch(/at most 200 ZIP entries and 50 MiB uncompressed/);
    expect(api.responseDescription("FileTooLarge")).toMatch(/file_too_large/);
    expect(api.schema("ImportFileFacts")["properties"]!["sizeBytes"]!["maximum"]).toBe(5 * 1024 * 1024);
  });

  it.each([
    "file_type_unsupported",
    "encoding_not_utf8",
    "file_unreadable",
    "xlsx_limits_exceeded",
    "sheet_not_found",
    "header_missing",
    "no_data_rows",
    "too_many_rows",
    "too_many_columns",
    "cell_too_long",
  ])("a file refusal is 422 %s", (code) => {
    expect(api.responseDescription("FileRejected")).toContain(`\`${code}\``);
  });

  it("decides the file type from content only (no 415)", () => {
    for (const o of OPERATIONS) expect(op(o.method, o.path).responses?.["415"]).toBeUndefined();
    expect(info()).toMatch(/never from `Content-Type` or the file name/);
  });
});

describe("catalog-import contract — interim batch on spec 042 names (OD-14 A)", () => {
  it("has the spec 042 state names, expired, and the reserved approval states", () => {
    expect(api.schema("BatchState")["enum"]).toEqual([
      "draft",
      "validated",
      "pending_approval",
      "approved",
      "published",
      "cancelled",
      "expired",
    ]);
    expect(String(api.schema("BatchState").description)).toMatch(/reserved for the OD-12 approval hook/);
  });

  it("every batch change carries expectedVersion; a mismatch is 409 version_conflict", () => {
    for (const name of ["ExpectedVersionRequest", "SetCatalogImportMappingRequest", "ResolveCatalogImportRowRequest", "PublishCatalogImportRequest"]) {
      expect(api.schema(name).required).toContain("expectedVersion");
    }
    expect(paramsOf("put", `${BATCH}/file`).find((p) => p.name === "expected_version")?.required).toBe(true);
    expect(api.responseDescription("BatchConflict")).toMatch(/version_conflict/);
    expect(api.responseDescription("PublishConflict")).toMatch(/version_conflict/);
  });

  it("publish presents the previewHash and answers the stale and preview conflicts", () => {
    expect(api.schema("PublishCatalogImportRequest").required).toEqual(["expectedVersion", "previewHash"]);
    const conflict = api.responseDescription("PublishConflict");
    for (const code of ["stale_validation", "preview_changed", "import_not_publishable", "import_batch_closed", "idempotency_key_conflict"]) {
      expect(conflict).toContain(`\`${code}\``);
    }
    expect(api.schema("PreviewHash")["pattern"]).toBe("^sha256:[0-9a-f]{64}$");
  });

  it("names the absence of the shared change_sets primitive and the one-transaction publish", () => {
    expect(info()).toMatch(/is not on\s+`main`/);
    expect(info()).toMatch(/nothing is half-published/);
  });
});

describe("catalog-import contract — rows, codes and prices (spec 049 §5–§7)", () => {
  it("has the six row statuses and the five review reasons", () => {
    expect(api.schema("RowStatus")["enum"]).toEqual([
      "ready_create",
      "ready_update",
      "unchanged",
      "needs_review",
      "error",
      "excluded",
    ]);
    expect(api.schema("ReviewReason")["enum"]).toEqual([
      "ambiguous",
      "no_identifier",
      "sku_mismatch",
      "store_scoped_conflict",
      "possible_duplicate",
    ]);
  });

  it("the row issue codes include every code the spec and RT-1502 name", () => {
    const codes = api.schema("RowIssueCode")["enum"] as string[];
    expect(codes).toEqual(
      expect.arrayContaining([
        "price_not_imported",
        "category_not_found",
        "identifier_non_ascii_digits",
        "identifier_numeric_cell",
        "identifier_invisible_char",
        "duplicate_in_file",
        "already_exists",
        "not_found",
        "product_retired",
        "gtin_check_digit",
        "whitespace_trimmed",
        "deactivates_product",
        "ambiguous",
        "no_identifier",
        "sku_mismatch",
        "store_scoped_conflict",
        "possible_duplicate",
      ]),
    );
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("recognises price and currency but never writes them (OD-2 A)", () => {
    expect(api.schema("CanonicalField")["enum"]).toEqual(expect.arrayContaining(["price", "currency"]));
    const changeable = api.schema("FieldChange")["properties"]!["field"]!["enum"] as string[];
    expect(changeable).not.toContain("price");
    expect(changeable).not.toContain("currency");
    expect(info()).toMatch(/No price is ever written/);
  });

  it("never calls ERPNext and never creates a category (OD-3 A)", () => {
    expect(info()).toMatch(/No operation calls ERPNext, Frappe or the connector/);
    expect(info()).toMatch(/Categories are never created/);
  });
});

describe("catalog-import contract — review follow-up to #717 (1.0.1-draft)", () => {
  it("states the 1.0.1-draft corrections in the contract's own version note", () => {
    expect(info()).toMatch(/\*\*1\.0\.1-draft \(RT-1502 review follow-up to PR #717\)\.\*\*/);
  });

  it("a re-upload clears the mapping and carries the kept columns only as a suggestion (decision 419)", () => {
    const replace = String(op("put", `${BATCH}/file`).description);
    expect(replace).toMatch(/`mapping` becomes `null`/);
    expect(replace).toMatch(/header text is unchanged/);
    expect(replace).toMatch(/placed in `suggestedMapping`/);
    expect(replace).toMatch(/validate requires a\s+non-null mapping \(`422 mapping_required`\)/);
    expect(replace).toMatch(/never the error report/);
    expect(responseDescription("put", `${BATCH}/file`, "200")).toMatch(/`mapping`\s+`null`/);
    const batch = api.schema("CatalogImportBatch")["properties"]!;
    expect(String(batch["mapping"]!["description"])).toMatch(/`null` again after a re-upload/);
    expect(String(batch["suggestedMapping"]!["description"])).toMatch(/after a re-upload, the previous\s+mapping's entries/);
    expect(info()).toMatch(/A re-upload sets `mapping` to `null`/);
  });

  it("a draft batch right after a re-upload is valid with a null mapping and the kept suggestion", () => {
    const v = validator("CatalogImportBatch");
    expect(
      v({
        ...batchFixture(),
        state: "draft",
        version: 4,
        mapping: null,
        suggestedMapping: [
          { columnNumber: 1, target: "barcode" },
          { columnNumber: 2, target: "name" },
        ],
        counts: null,
        previewHash: null,
        publishable: false,
      }),
    ).toBe(true);
  });

  it("validate requires a non-null mapping and re-applies the completeness rules (422 mapping_required / mapping_invalid)", () => {
    const validate = String(op("post", `${BATCH}/validate`).description);
    expect(validate).toMatch(/whose `mapping`\s+is not `null`/);
    expect(validate).toMatch(/defence in depth/);
    expect(validate).toMatch(/`422\s+mapping_invalid`/);
    const rejected = responseDescription("post", `${BATCH}/validate`, "422");
    expect(rejected).toContain("`mapping_required`");
    expect(rejected).toContain("`mapping_invalid`");
    expect(op("post", `${BATCH}/validate`).responses?.["422"]).toEqual({
      $ref: "#/components/responses/ValidateMappingRejected",
    });
  });

  it("the error report is read-only, never re-uploaded, and names the formula-guard prefix", () => {
    const report = String(op("get", `${BATCH}/error-report`).description);
    expect(report).toMatch(/read-only and is never re-uploaded/);
    expect(report).toMatch(/fixes the \*\*source file\*\*/);
    expect(report).toMatch(/formula-guard `'`/);
    expect(report).toMatch(/does not match \(identifiers are byte-exact\)/);
  });

  it("binds the row-list cursor to the validation generation, not to the batch version", () => {
    const cursor = String(doc.components!.parameters!["Cursor"]!.description);
    expect(cursor).toMatch(/its validation generation and\s+`status`/);
    expect(cursor).toMatch(/changes only when validate runs/);
    expect(cursor).toMatch(/older\s+validation generation, is 400 `validation_error`/);
    expect(cursor).not.toMatch(/its `version`/);
    expect(String(op("get", `${BATCH}/rows`).description)).toMatch(/bound to the\s+validation generation/);
    expect(String(op("put", `${BATCH}/rows/{rowNumber}/resolution`).description)).toMatch(
      /validation generation is unchanged/,
    );
  });

  it("states the review decision → row status table with the contract's own names", () => {
    const actions = api.schema("ResolveCatalogImportRowRequest")["properties"]!["action"]!["enum"] as string[];
    const statuses = api.schema("RowStatus")["enum"] as string[];
    const table: ReadonlyArray<[string, string]> = [
      ["create_new", "ready_create"],
      ["update_product", "ready_update"],
      ["exclude", "excluded"],
    ];
    const resolve = String(op("put", `${BATCH}/rows/{rowNumber}/resolution`).description);
    const rowStatus = String(api.schema("RowStatus").description);
    for (const [action, status] of table) {
      expect(actions).toContain(action);
      expect(statuses).toContain(status);
      expect(resolve).toMatch(new RegExp(`\`${action}\` → \`${status}\``));
      expect(rowStatus).toMatch(new RegExp(`\`${action}\` → \`${status}\``));
    }
    expect(actions).toContain("clear");
    expect(resolve).toMatch(/`clear` →\s+the status validate gave it \(`needs_review` or `error`\)/);
    expect(rowStatus).toMatch(/`clear` → back to the status\s+validate gave it/);
  });

  it("a resolved row carries its new status, the decision and the kept review reason", () => {
    const v = validator("CatalogImportRow");
    expect(
      v({
        ...rowFixture(),
        status: "ready_update",
        resolution: { action: "update_product", productId: PRODUCT, decidedAt: "2026-11-19T10:06:00Z" },
      }),
    ).toBe(true);
    expect(
      v({
        ...rowFixture(),
        status: "ready_create",
        resolution: { action: "create_new", productId: null, decidedAt: "2026-11-19T10:06:00Z" },
      }),
    ).toBe(true);
    // `clear` is a request action, never a recorded resolution.
    expect(
      v({ ...rowFixture(), resolution: { action: "clear", productId: null, decidedAt: "2026-11-19T10:06:00Z" } }),
    ).toBe(false);
  });
});

describe("catalog-import contract — AJV fixtures", () => {
  it("CatalogImportBatch accepts a validated batch and a fresh draft", () => {
    const v = validator("CatalogImportBatch");
    expect(v(batchFixture())).toBe(true);
    expect(
      v({ ...batchFixture(), state: "draft", version: 1, mapping: null, counts: null, previewHash: null, warnings: [] }),
    ).toBe(true);
    expect(
      v({
        ...batchFixture(),
        warnings: [{ code: "file_previously_published", publishedBatchId: OTHER_BATCH, publishedAt: "2026-11-01T00:00:00Z" }],
      }),
    ).toBe(true);
  });

  it("CatalogImportBatch rejects unknown states, a tenant id, a bad hash and an oversize file", () => {
    const v = validator("CatalogImportBatch");
    expect(v({ ...batchFixture(), state: "approved_by_erp" })).toBe(false);
    expect(v({ ...batchFixture(), tenantId: PRODUCT })).toBe(false);
    expect(v({ ...batchFixture(), previewHash: "a".repeat(64) })).toBe(false);
    expect(v({ ...batchFixture(), file: { ...batchFixture().file, sizeBytes: 5 * 1024 * 1024 + 1 } })).toBe(false);
    expect(v({ ...batchFixture(), mapping: [{ columnNumber: 1, target: "cost_price" }] })).toBe(false);
  });

  it("CatalogImportRow carries cells, outcome, issues and decision", () => {
    const v = validator("CatalogImportRow");
    expect(v(rowFixture())).toBe(true);
    expect(
      v({
        ...rowFixture(),
        status: "excluded",
        resolution: { action: "exclude", productId: null, decidedAt: "2026-11-19T10:06:00Z" },
      }),
    ).toBe(true);
    expect(v({ ...rowFixture(), rowNumber: 1 })).toBe(false);
    expect(v({ ...rowFixture(), status: "skipped" })).toBe(false);
    expect(v({ ...rowFixture(), resolution: { action: "exclude", productId: null, decidedAt: "2026-11-19T10:06:00Z", decidedBy: "u" } })).toBe(false);
  });

  it("a review decision names a product for, and only for, update_product", () => {
    const v = validator("ResolveCatalogImportRowRequest");
    expect(v({ expectedVersion: 3, action: "update_product", productId: PRODUCT })).toBe(true);
    expect(v({ expectedVersion: 3, action: "exclude" })).toBe(true);
    expect(v({ expectedVersion: 3, action: "clear" })).toBe(true);
    expect(v({ expectedVersion: 3, action: "update_product" })).toBe(false);
    expect(v({ expectedVersion: 3, action: "create_new", productId: PRODUCT })).toBe(false);
    expect(v({ action: "exclude" })).toBe(false);
  });

  it("the mapping lists columns to a field or ignore", () => {
    const v = validator("SetCatalogImportMappingRequest");
    expect(
      v({ expectedVersion: 1, columns: [{ columnNumber: 1, target: "sku" }, { columnNumber: 2, target: "ignore" }], saveProfileName: "مورد أ" }),
    ).toBe(true);
    expect(v({ expectedVersion: 1, columns: [] })).toBe(false);
    expect(v({ expectedVersion: 1, columns: [{ columnNumber: 51, target: "sku" }] })).toBe(false);
  });

  it("the preview and publish result carry the impact and the summary", () => {
    const preview = {
      batchId: BATCH_ID,
      version: 4,
      previewHash: HASH,
      mode: "upsert",
      publishable: true,
      counts: { ...counts, needs_review: 0, excluded: 1 },
      brandsToCreate: ["العروسة"],
      productsToCreate: 3,
      productsToUpdate: 1,
      identifiersToAdd: 4,
      deactivations: [{ rowNumber: 4, product: productRef }],
      newProductsWithoutPrice: 3,
      rowsWithPriceNotImported: 5,
    };
    expect(validator("CatalogImportPreview")(preview)).toBe(true);
    expect(validator("CatalogImportPreview")({ ...preview, priceChanges: [] })).toBe(false);
    const result = {
      batch: { ...batchFixture(), state: "published", expiresAt: null, publishedAt: "2026-11-19T10:10:00Z", publishable: false },
      summary: {
        brandsCreated: 1,
        productsCreated: 3,
        productsUpdated: 1,
        identifiersAdded: 4,
        productsDeactivated: 1,
        rowsUnchanged: 0,
        rowsExcluded: 1,
      },
    };
    expect(validator("CatalogImportPublishResult")(result)).toBe(true);
  });
});
