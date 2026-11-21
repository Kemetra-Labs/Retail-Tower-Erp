/**
 * RT-1509: a small stateful fake of Backend-Core's product import API (spec 049, contract
 * `catalog/catalog-import.yaml`) for the import workspace's Playwright flows (C-5: no live
 * Backend-Core). It answers what the contract says, keeps one batch, and records every request
 * (method, path, query, headers, body) so a spec can assert on what the Console sent: the same
 * `Idempotency-Key` and body on a resend, `expectedVersion` on a decision, the raw file body.
 *
 * Scripted answers (`publish`, `upload`) are consumed in order; `"abort"` drops the connection (no
 * answer at all), which is how an unclear outcome is produced.
 */
import type { Page, Route } from "@playwright/test";

export const BATCH_ID = "3b1f6c42-8d0a-4f7e-9a21-5c8e7d114a09";
const P_MILK = "0190f000-0000-7000-8000-000000000a01";
const P_MILK_OLD = "0190f000-0000-7000-8000-000000000a02";

type Scripted = "abort" | { status: number; body?: unknown; headers?: Record<string, string> };

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string | null;
  bytes: number;
}

type Json = Record<string, unknown>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store", ...headers },
    body: JSON.stringify(body),
  };
}

export function err(status: number, code: string, extra: Json = {}) {
  return { status, body: { error: { code, message: code, request_id: "req_3f9c1a", ...extra } } };
}

export const COLUMNS = [
  { columnNumber: 1, header: "رمز الصنف", samples: ["SKU-1001", "SKU-1002"] },
  { columnNumber: 2, header: "باركود", samples: ["6221033004581"] },
  { columnNumber: 3, header: "اسم الصنف", samples: ["عصير برتقال 1 لتر", "حليب كامل الدسم"] },
  { columnNumber: 4, header: "فئة الضريبة", samples: ["standard", "exempt"] },
  { columnNumber: 5, header: "سعر البيع", samples: ["25.50", "18.00"] },
  { columnNumber: 6, header: "ملاحظات", samples: ["مورد جديد"] },
  { columnNumber: 7, header: "المورد", samples: ["شركة النيل"] },
];

const SUGGESTED = [
  { columnNumber: 1, target: "sku" },
  { columnNumber: 2, target: "barcode" },
  { columnNumber: 3, target: "name" },
  { columnNumber: 4, target: "tax_category" },
  { columnNumber: 5, target: "price" },
];

export const COUNTS = {
  ready_create: 812,
  ready_update: 301,
  unchanged: 96,
  needs_review: 18,
  error: 9,
  excluded: 4,
};

export function batchBody(over: Json = {}): Json {
  return {
    batchId: BATCH_ID,
    state: "draft",
    version: 1,
    mode: "upsert",
    file: {
      name: "products-nov.xlsx",
      sizeBytes: 1863680,
      sha256: "a".repeat(64),
      kind: "xlsx",
      sheetName: "Sheet1",
      csvDelimiter: null,
      dataRowCount: 1240,
      columnCount: 7,
      parserVersion: "1",
    },
    columns: COLUMNS,
    mapping: null,
    suggestedMapping: SUGGESTED,
    mappingProfileId: null,
    counts: null,
    previewHash: null,
    publishable: false,
    warnings: [],
    createdAt: "2026-11-19T09:00:00Z",
    updatedAt: "2026-11-19T09:00:00Z",
    expiresAt: "2026-11-26T09:00:00Z",
    publishedAt: null,
    ...over,
  };
}

export function validatedBatch(over: Json = {}): Json {
  return batchBody({
    state: "validated",
    version: 3,
    mapping: SUGGESTED.concat([
      { columnNumber: 6, target: "ignore" },
      { columnNumber: 7, target: "ignore" },
    ]),
    counts: COUNTS,
    previewHash: "sha256:aaaa",
    publishable: false,
    ...over,
  });
}

const EMPTY_OUTCOME = {
  match: "no_match",
  matchedProduct: null,
  candidates: [],
  fieldChanges: [],
  identifierAdds: [],
  identifiersNotAdded: [],
  brandToCreate: null,
};

export function row(rowNumber: number, status: string, over: Json = {}): Json {
  return {
    rowNumber,
    status,
    cells: [
      `SKU-${rowNumber}`,
      `62210330${rowNumber}`,
      `صنف ${rowNumber}`,
      "standard",
      "10.00",
      "",
      "",
    ],
    outcome: EMPTY_OUTCOME,
    issues: [],
    reviewReason: null,
    resolution: null,
    productId: null,
    ...over,
  };
}

export const ERROR_ROW = row(14, "error", {
  cells: ["SKU-1001", "6.22103E+12", "عصير برتقال 1 لتر", "standard", "25.50", "", ""],
  issues: [
    {
      code: "identifier_numeric_cell",
      severity: "error",
      field: "barcode",
      columnNumber: 2,
      message: "wire english text that must never be shown",
    },
  ],
});

export const AMBIGUOUS_ROW = row(31, "needs_review", {
  cells: ["SKU-1050", "6221033001234", "حليب كامل الدسم 1 لتر", "standard", "9.00", "", ""],
  reviewReason: "ambiguous",
  outcome: {
    ...EMPTY_OUTCOME,
    match: "ambiguous",
    candidates: [
      {
        productId: P_MILK,
        name: "حليب كامل الدسم 1 لتر",
        identifiers: [
          { type: "sku", value: "SKU-1050" },
          { type: "barcode", value: "6221033001111" },
        ],
      },
      {
        productId: P_MILK_OLD,
        name: "حليب كامل الدسم 1 لتر (عبوة قديمة)",
        identifiers: [{ type: "barcode", value: "6221033001234" }],
      },
    ],
  },
  issues: [
    { code: "ambiguous", severity: "review", field: null, columnNumber: null, message: "x" },
  ],
});

export const NO_ID_ROW = row(92, "needs_review", {
  reviewReason: "no_identifier",
  issues: [
    { code: "no_identifier", severity: "review", field: null, columnNumber: null, message: "x" },
  ],
});

export function previewBody(over: Json = {}): Json {
  return {
    batchId: BATCH_ID,
    version: 4,
    previewHash: "sha256:bbbb",
    mode: "upsert",
    publishable: true,
    counts: { ...COUNTS, needs_review: 0, error: 0, excluded: 4 },
    brandsToCreate: ["نايل فودز", "الواحة", "ريف"],
    productsToCreate: 812,
    productsToUpdate: 301,
    identifiersToAdd: 1410,
    deactivations: [
      {
        rowNumber: 103,
        product: {
          productId: P_MILK,
          name: "زيت ذرة 1.5 لتر",
          identifiers: [{ type: "sku", value: "SKU-3312" }],
        },
      },
    ],
    newProductsWithoutPrice: 812,
    rowsWithPriceNotImported: 790,
    ...over,
  };
}

export const SUMMARY = {
  brandsCreated: 3,
  productsCreated: 812,
  productsUpdated: 301,
  identifiersAdded: 1410,
  productsDeactivated: 2,
  rowsUnchanged: 96,
  rowsExcluded: 4,
};

function ctx(role: string) {
  return {
    user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_store: null,
    active_role_code: role,
    memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: role }],
  };
}

export interface FakeImport {
  /** Every import request in order. */
  requests: Recorded[];
  /** The batch the fake serves; a spec replaces fields to put the batch in a state. */
  batch: Json;
  /** Rows by status filter (`"all"` when none), served as keyset pages of `pageSize`. */
  rows: Record<string, Json[]>;
  pageSize: number;
  /** Row-list requests that fail once with a 500 (a failed continuation). */
  failRowPages: number;
  preview: Json;
  publish: Scripted[];
  upload: Scripted[];
  validateAnswer: () => Json;
  mappingAnswer: Scripted | null;
  /** The requests to one path, in order. */
  to: (method: string, pathPart: string) => Recorded[];
}

async function record(route: Route): Promise<Recorded> {
  const req = route.request();
  const url = new URL(req.url());
  const buf = req.postDataBuffer();
  return {
    method: req.method(),
    path: url.pathname,
    query: url.searchParams,
    headers: req.headers(),
    body: buf ? buf.toString("utf8") : null,
    bytes: buf ? buf.length : 0,
  };
}

function answer(route: Route, s: Scripted) {
  if (s === "abort") return route.abort("connectionreset");
  return route.fulfill(json(s.body ?? {}, s.status, s.headers));
}

function rowsPage(fake: FakeImport, query: URLSearchParams) {
  const all = fake.rows[query.get("status") ?? "all"] ?? [];
  const start = Number(query.get("cursor") ?? 0);
  const items = all.slice(start, start + fake.pageSize);
  const next = start + fake.pageSize;
  return {
    batchId: BATCH_ID,
    version: Number(fake.batch.version),
    items,
    nextCursor: next < all.length ? String(next) : null,
  };
}

interface Handler {
  method: string;
  match: (tail: string) => boolean;
  run: (fake: FakeImport, r: Route, rec: Recorded) => Promise<void> | void;
}

const endsWith = (suffix: string) => (tail: string) => tail.endsWith(suffix);

function published(): Json {
  return batchBody({
    state: "published",
    version: 5,
    publishedAt: "2026-11-21T19:47:00Z",
    counts: COUNTS,
  });
}

const HANDLERS: Handler[] = [
  {
    method: "POST",
    match: (tail) => tail === "",
    run: (fake, r) => {
      const next = fake.upload.shift();
      if (next) return answer(r, next);
      fake.batch = batchBody();
      return r.fulfill(json(fake.batch, 201));
    },
  },
  {
    method: "PUT",
    match: endsWith("/mapping"),
    run: (fake, r, rec) => {
      if (fake.mappingAnswer) return answer(r, fake.mappingAnswer);
      const body = JSON.parse(rec.body ?? "{}") as { columns: unknown[] };
      fake.batch = batchBody({ version: Number(fake.batch.version) + 1, mapping: body.columns });
      return r.fulfill(json(fake.batch));
    },
  },
  {
    method: "POST",
    match: endsWith("/validate"),
    run: (fake, r) => {
      fake.batch = fake.validateAnswer();
      return r.fulfill(json(fake.batch));
    },
  },
  {
    method: "PUT",
    match: endsWith("/file"),
    run: (fake, r) => {
      fake.batch = batchBody({ version: Number(fake.batch.version) + 1 });
      return r.fulfill(json(fake.batch));
    },
  },
  {
    method: "GET",
    match: endsWith("/rows"),
    run: (fake, r, rec) => {
      if (fake.failRowPages > 0 && rec.query.get("cursor")) {
        fake.failRowPages -= 1;
        return r.fulfill(json({ error: { code: "system_failure", request_id: "r" } }, 500));
      }
      return r.fulfill(json(rowsPage(fake, rec.query)));
    },
  },
  {
    method: "PUT",
    match: (tail) => tail.includes("/rows/") && tail.endsWith("/resolution"),
    run: (fake, r, rec) => resolveRow(fake, r, rec),
  },
  { method: "GET", match: endsWith("/preview"), run: (fake, r) => r.fulfill(json(fake.preview)) },
  {
    method: "POST",
    match: endsWith("/publish"),
    run: (fake, r) => {
      const next = fake.publish.shift();
      if (next) return answer(r, next);
      fake.batch = published();
      return r.fulfill(json({ batch: fake.batch, summary: SUMMARY }));
    },
  },
  {
    method: "POST",
    match: endsWith("/cancel"),
    run: (fake, r) => {
      fake.batch = batchBody({ state: "cancelled", version: Number(fake.batch.version) + 1 });
      return r.fulfill(json(fake.batch));
    },
  },
  {
    method: "GET",
    match: endsWith("/error-report"),
    run: (_fake, r) =>
      r.fulfill({
        status: 200,
        contentType: "text/csv",
        headers: { "content-disposition": 'attachment; filename="errors.csv"' },
        body: "row_number,status",
      }),
  },
];

/** Installs the context, the catalog list stubs and the import API for `role`. */
export async function mockImportApi(page: Page, role = "owner"): Promise<FakeImport> {
  const fake: FakeImport = {
    requests: [],
    batch: batchBody(),
    rows: { all: [] },
    pageSize: 50,
    failRowPages: 0,
    preview: previewBody(),
    publish: [],
    upload: [],
    validateAnswer: () => validatedBatch({ version: Number(fake.batch.version) + 1 }),
    mappingAnswer: null,
    to: (method, part) => fake.requests.filter((r) => r.method === method && r.path.includes(part)),
  };

  await page.route("**/api/v1/**", (r) => r.fulfill(json({})));
  await page.route("**/api/v1/context/me", (r) => r.fulfill(json(ctx(role))));
  await page.route("**/api/v1/catalog/products?**", (r) =>
    r.fulfill(json({ items: [], nextCursor: null })),
  );
  await page.route("**/api/v1/catalog/categories", (r) => r.fulfill(json({ items: [] })));
  await page.route("**/api/v1/catalog/brands**", (r) =>
    r.fulfill(json({ items: [], nextCursor: null })),
  );

  await page.route("**/api/v1/catalog/import-template**", async (r) => {
    fake.requests.push(await record(r));
    const lang = new URL(r.request().url()).searchParams.get("headers") ?? "ar";
    return r.fulfill({
      status: 200,
      contentType: "text/csv",
      headers: { "content-disposition": `attachment; filename="template-${lang}.csv"` },
      body: "sku,name",
    });
  });

  await page.route("**/api/v1/catalog/imports**", async (r) => {
    const rec = await record(r);
    fake.requests.push(rec);
    const tail = rec.path.replace(/^.*\/catalog\/imports\/?/, "");
    const handler = HANDLERS.find((h) => h.method === rec.method && h.match(tail));
    return handler
      ? handler.run(fake, r, rec)
      : r.fulfill(json(rec.method === "GET" ? fake.batch : {}));
  });
  return fake;
}

function resolveRow(fake: FakeImport, r: Route, rec: Recorded) {
  const rowNumber = Number(rec.path.split("/rows/")[1]?.split("/")[0]);
  const body = JSON.parse(rec.body ?? "{}") as { action: string; productId?: string };
  const source =
    Object.values(fake.rows)
      .flat()
      .find((x) => x.rowNumber === rowNumber) ?? row(rowNumber, "needs_review");
  const status =
    body.action === "create_new"
      ? "ready_create"
      : body.action === "update_product"
        ? "ready_update"
        : body.action === "exclude"
          ? "excluded"
          : "needs_review";
  const decided: Json = {
    ...source,
    status,
    resolution:
      body.action === "clear"
        ? null
        : {
            action: body.action,
            productId: body.productId ?? null,
            decidedAt: "2026-11-21T19:30:00Z",
          },
  };
  const version = Number(fake.batch.version) + 1;
  const previous = fake.batch.counts as Record<string, number>;
  const counts: Record<string, number> = {
    ...previous,
    needs_review: (previous.needs_review ?? 0) - (body.action === "clear" ? -1 : 1),
  };
  fake.batch = { ...fake.batch, version, counts };
  return r.fulfill(
    json({
      row: decided,
      version,
      previewHash: `sha256:v${version}`,
      counts,
      publishable: (counts.needs_review ?? 0) + (counts.error ?? 0) === 0,
    }),
  );
}
