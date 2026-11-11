/**
 * apps/api/test/catalog/console-catalog/console-catalog.contract.spec.ts
 *
 * RT-729 (CAT-R1 of the RT-281 decomposition, comment 12887 §1): the console
 * catalog read contract that Admin-Console RF-3 and the RT-724 link product
 * picker consume. `[GATED]` contract, owner-approved 2026-10-19. The runtime
 * and its HTTP read-scope suite are RT-730 (CAT-R2,
 * `console-catalog.http.integration.spec.ts`).
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. What this pins:
 *
 *   1. Three GET operations at their paths, served (RT-730), with
 *      no audit action (decision O-6) and no operationId collision.
 *   2. Read scope: `cookieAuth` only; 404 (never 403) is the role / scope
 *      refusal; no tenant id from the request.
 *   3. The list filters, the cursor binding and the page bounds.
 *   4. Projections are strict, carry no user id or ERP mapping, and use
 *      exact-decimal string money.
 *   5. AJV fixtures: valid payloads pass, each invalid one fails.
 *
 * RT-1334 (1.2.0-draft, additive): the brand list read, the product's
 * `brandId` / `brandName` and the `brand_id` filter. The brand writes are
 * pinned in console-catalog-writes.contract.spec.ts.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  allContracts,
  contractDocument,
  contractReader,
  operationIdsExcept,
  type ApiPath,
  type ContractReader,
  type OpenApiDocument,
} from "../../_helpers/openapi-contract";

const CONTRACT_ID = "console-catalog";

const LIST_PATH = "/api/v1/catalog/products";
const DETAIL_PATH = "/api/v1/catalog/products/{productId}";
const CATEGORIES_PATH = "/api/v1/catalog/categories";
const BRANDS_PATH = "/api/v1/catalog/brands";

const OPERATIONS: ReadonlyArray<{ id: string; path: ApiPath }> = [
  { id: "consoleListCatalogProducts", path: LIST_PATH },
  { id: "consoleGetCatalogProduct", path: DETAIL_PATH },
  { id: "consoleListCatalogCategories", path: CATEGORIES_PATH },
  { id: "consoleListCatalogBrands", path: BRANDS_PATH },
];

type SchemaName =
  | "ConsoleCatalogProductPage"
  | "ConsoleCatalogProductSummary"
  | "ConsoleCatalogProductDetail"
  | "ConsoleCatalogCategoryList"
  | "ConsoleCatalogBrandList";

let doc: OpenApiDocument;
let api: ContractReader;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  doc = contractDocument(contracts, CONTRACT_ID);
  api = contractReader(doc);
  otherOperationIds = operationIdsExcept(contracts, CONTRACT_ID);
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function validator(name: SchemaName): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

const PRODUCT_ID = "0190f5a2-3b4c-7d8e-9f01-23456789abcd";
const STORE_ID = "0190f5a2-3b4c-7d8e-9f01-000000000002";
const CATEGORY_ID = "0190f5a2-3b4c-7d8e-9f01-000000000003";
const BRAND_ID = "0190f5a2-3b4c-7d8e-9f01-000000000004";

const SUMMARY = {
  productId: PRODUCT_ID,
  name: "Water 1.5L",
  status: "active",
  categoryId: CATEGORY_ID,
  categoryName: "Drinks",
  brandId: BRAND_ID,
  brandName: "Nile",
  primarySku: "SKU-1",
  primaryBarcode: "000123456789",
  defaultPrice: { amount: "8.50", currencyCode: "EGP" },
  taxCategory: "standard",
  trackingMode: "none",
  updatedAt: "2026-10-19T09:00:00.000Z",
} as const;

const STORE_VIEW = {
  storeId: STORE_ID,
  effectivePrice: { amount: "9.00", currencyCode: "EGP" },
  effectiveActive: true,
  effectiveTaxCategory: "standard",
  hasOverride: true,
} as const;

const DETAIL = {
  summary: SUMMARY,
  description: null,
  expiryRequired: false,
  sourceGlobalProductId: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  identifiers: [
    { identifierType: "barcode", value: "000123456789", storeId: null, sourceSystem: null, createdAt: "2026-10-01T09:00:00.000Z" },
    { identifierType: "plu", value: "42", storeId: STORE_ID, sourceSystem: null, createdAt: "2026-10-02T09:00:00.000Z" },
  ],
  storeOverrides: [
    {
      storeId: STORE_ID,
      price: { amount: "9.00", currencyCode: "EGP" },
      isActive: null,
      taxCategory: null,
      updatedAt: "2026-10-03T09:00:00.000Z",
    },
  ],
} as const;

// ===========================================================================
// 1. Document + operations
// ===========================================================================
describe("console-catalog — document and operations", () => {
  it("is an OpenAPI 3.1 document at version 1.2.0-draft (RT-1334 brands, additive)", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.2.0-draft");
  });

  it("declares the four reads as the only GET operations (the writes are pinned in console-catalog-writes.contract.spec.ts)", () => {
    const gets = Object.entries(doc.paths ?? {}).filter(([, item]) => "get" in item).map(([path]) => path);
    expect(gets.sort()).toEqual([LIST_PATH, DETAIL_PATH, CATEGORIES_PATH, BRANDS_PATH].sort());
    for (const { id, path } of OPERATIONS) {
      expect(api.get(path).operationId).toBe(id);
      expect(api.get(path).requestBody).toBeUndefined();
    }
  });

  it("serves every operation: none is marked contract-only (RT-730)", () => {
    for (const { path } of OPERATIONS) {
      expect(api.get(path)["x-runtime-status"]).toBeUndefined();
      expect(api.get(path)["x-runtime-note"]).toBeUndefined();
    }
  });

  it("names no audit action: catalog reads are not audited per request (decision O-6)", () => {
    for (const { path } of OPERATIONS) expect(api.get(path)["x-audit-action"]).toBeUndefined();
    expect(doc.info?.description).toMatch(/NOT audited per request/);
  });

  it("collides with no operationId in any other contract", () => {
    expect(OPERATIONS.map((o) => o.id).filter((id) => otherOperationIds.has(id))).toEqual([]);
  });
});

// ===========================================================================
// 2. Read scope
// ===========================================================================
describe("console-catalog — auth and read scope", () => {
  it("accepts only the human cookieAuth session", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
    for (const { path } of OPERATIONS) expect(api.get(path).security).toBeUndefined();
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["cookieAuth"]);
    expect(doc.components!.securitySchemes!["cookieAuth"]).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "dp2_session",
    });
  });

  it("answers 200 / 400 / 401 / 404 / 429 / 500 only: the role or scope refusal is 404, never 403", () => {
    for (const { path } of OPERATIONS) {
      expect(Object.keys(api.get(path).responses ?? {}).sort()).toEqual(["200", "400", "401", "404", "429", "500"]);
      expect(api.get(path).responses!["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
      expect(api.get(path).responses!["200"]!.headers!["Cache-Control"]).toEqual({
        $ref: "#/components/headers/CacheControlNoStore",
      });
    }
    expect(api.responseDescription("NotFound")).toMatch(/store_id.*outside/s);
  });

  it("takes no tenant id and no header from the request", () => {
    for (const { path } of OPERATIONS) {
      expect(api.params(path).filter((p) => /tenant/i.test(p.name ?? ""))).toEqual([]);
      expect(api.params(path).filter((p) => p.in === "header")).toEqual([]);
    }
  });

  it("names the three allowed roles and the store-scoped store data (decision O-7)", () => {
    const description = String(doc.info?.description);
    expect(description).toMatch(/`owner`,\s+`tenant_admin`, `store_manager`/);
    expect(description).toMatch(/decision O-7/);
    expect(description).toMatch(/explicit store\s+predicate/);
  });
});

// ===========================================================================
// 3. List filters, cursor and page bounds
// ===========================================================================
describe("console-catalog — list parameters", () => {
  it("declares exactly q, status, category_id, brand_id, store_id, cursor and limit, all optional", () => {
    const params = api.params(LIST_PATH);
    expect(params.map((p) => p.name).sort()).toEqual(["brand_id", "category_id", "cursor", "limit", "q", "status", "store_id"]);
    for (const p of params) {
      expect(p.in).toBe("query");
      expect(p.required).toBe(false);
    }
  });

  it("bounds q to 1..100 and documents the exact-identifier OR name match", () => {
    expect(api.param(LIST_PATH, "q").schema).toEqual({ type: "string", minLength: 1, maxLength: 100 });
    expect(doc.info?.description).toMatch(/leading zeros are significant/);
    expect(doc.info?.description).toMatch(/A retired identifier never matches/);
  });

  it("filters status active|inactive|retired|any, default active", () => {
    expect(api.schema("ProductStatusFilter")).toMatchObject({
      enum: ["active", "inactive", "retired", "any"],
      default: "active",
    });
  });

  it("bounds limit to 1..100, default 50, and pages to 100 items", () => {
    expect(api.param(LIST_PATH, "limit").schema).toEqual({ type: "integer", minimum: 1, maximum: 100, default: 50 });
    expect(api.schema("ConsoleCatalogProductPage").properties!["items"]).toMatchObject({ maxItems: 100 });
  });

  it("binds the opaque cursor to every filter", () => {
    expect(api.param(LIST_PATH, "cursor").description).toMatch(/`q`, `status`,\s+`category_id`, `brand_id`, `store_id`/);
  });

  it("filters by brand (RT-1334): a uuid, and a brand the tenant does not have matches nothing", () => {
    expect(api.param(LIST_PATH, "brand_id").schema).toEqual({ type: "string", format: "uuid" });
    expect(api.param(LIST_PATH, "brand_id").description).toMatch(/matches nothing \(an empty 200\)/);
  });

  it("takes only the product id on the detail and nothing on the categories list", () => {
    expect(api.params(DETAIL_PATH).map((p) => [p.name, p.in])).toEqual([["productId", "path"]]);
    expect(api.param(DETAIL_PATH, "productId").schema).toEqual({ type: "string", format: "uuid" });
    expect(api.params(CATEGORIES_PATH)).toEqual([]);
    expect(api.params(BRANDS_PATH)).toEqual([]);
  });
});

// ===========================================================================
// 4 + 5. Projections and AJV fixtures
// ===========================================================================
describe("console-catalog — projections", () => {
  it("keeps every projection strict", () => {
    for (const name of [
      "ConsoleCatalogProductPage",
      "ConsoleCatalogProductSummary",
      "ConsoleCatalogProductDetail",
      "StoreView",
      "ProductIdentifier",
      "StoreOverride",
      "Money",
      "ConsoleCatalogCategory",
      "ConsoleCatalogCategoryList",
      "ConsoleCatalogBrand",
      "ConsoleCatalogBrandList",
    ]) {
      expect(api.schema(name).additionalProperties).toBe(false);
    }
  });

  it("exposes no user id and no ERP mapping", () => {
    const text = JSON.stringify(doc.components?.schemas);
    expect(text).not.toMatch(/createdBy|updatedBy|userId|erpnext|itemCode/i);
  });

  it("accepts a list page with and without storeView", () => {
    const page = validator("ConsoleCatalogProductPage");
    expect(page({ items: [SUMMARY], nextCursor: null })).toBe(true);
    expect(page({ items: [{ ...SUMMARY, storeView: STORE_VIEW }], nextCursor: "bmV4dA" })).toBe(true);
    expect(page({ items: [], nextCursor: null })).toBe(true);
  });

  it("accepts a product with no category, brand, price or identifiers", () => {
    const summary = validator("ConsoleCatalogProductSummary");
    expect(
      summary({
        ...SUMMARY,
        categoryId: null,
        categoryName: null,
        brandId: null,
        brandName: null,
        primarySku: null,
        primaryBarcode: null,
        defaultPrice: null,
      }),
    ).toBe(true);
  });

  it("requires brandId and brandName on every summary (RT-1334), null without a brand", () => {
    const summary = validator("ConsoleCatalogProductSummary");
    const { brandId: _id, ...noBrandId } = SUMMARY;
    const { brandName: _name, ...noBrandName } = SUMMARY;
    expect(summary(noBrandId)).toBe(false);
    expect(summary(noBrandName)).toBe(false);
    expect(summary({ ...SUMMARY, brandId: "not-a-uuid" })).toBe(false);
  });

  it("rejects float money, a negative amount, an unknown status and an extra field", () => {
    const summary = validator("ConsoleCatalogProductSummary");
    expect(summary({ ...SUMMARY, defaultPrice: { amount: 8.5, currencyCode: "EGP" } })).toBe(false);
    expect(summary({ ...SUMMARY, defaultPrice: { amount: "-1.00", currencyCode: "EGP" } })).toBe(false);
    expect(summary({ ...SUMMARY, status: "deleted" })).toBe(false);
    expect(summary({ ...SUMMARY, name: "x".repeat(501) })).toBe(false);
    expect(summary({ ...SUMMARY, createdBy: PRODUCT_ID })).toBe(false);
    expect(summary({ ...SUMMARY, storeView: { ...STORE_VIEW, sellable: true } })).toBe(false);
  });

  it("accepts the detail and rejects one missing a required field", () => {
    const detail = validator("ConsoleCatalogProductDetail");
    expect(detail(DETAIL)).toBe(true);
    const { identifiers: _omitted, ...missing } = DETAIL;
    expect(detail(missing)).toBe(false);
    // The detail takes no store_id, so its summary never carries a storeView.
    expect(detail({ ...DETAIL, summary: { ...SUMMARY, storeView: STORE_VIEW } })).toBe(false);
    expect(
      detail({ ...DETAIL, identifiers: [{ ...DETAIL.identifiers[0], identifierType: "ean" }] }),
    ).toBe(false);
  });

  it("accepts the flat category list", () => {
    const list = validator("ConsoleCatalogCategoryList");
    expect(
      list({ items: [{ categoryId: CATEGORY_ID, name: "Drinks", description: null, updatedAt: "2026-10-01T09:00:00.000Z" }] }),
    ).toBe(true);
    expect(list({ items: [{ categoryId: CATEGORY_ID, name: "Drinks", description: null, updatedAt: "x", parentId: null }] })).toBe(
      false,
    );
  });

  it("accepts the flat brand list (RT-1334): no parent, no description", () => {
    const list = validator("ConsoleCatalogBrandList");
    const brand = { brandId: BRAND_ID, name: "Nile", updatedAt: "2026-10-01T09:00:00.000Z" };
    expect(list({ items: [brand] })).toBe(true);
    expect(list({ items: [] })).toBe(true);
    expect(list({ items: [{ ...brand, parentId: null }] })).toBe(false);
    expect(list({ items: [{ ...brand, description: null }] })).toBe(false);
    expect(list({ items: [{ ...brand, name: "" }] })).toBe(false);
  });
});
