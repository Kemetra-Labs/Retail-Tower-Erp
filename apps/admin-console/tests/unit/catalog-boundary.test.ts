import * as queries from "@/lib/catalog-queries";
import { describe, expect, test } from "vitest";
import { readSource, sourcesUnder } from "./source-scan";

/**
 * RT-765 / RT-766 / RT-768 / RT-769 boundary (RT-752 AC 5, CAT-C1a / C1b / C2a /
 * C2b). The catalog reads the three read operations of `console-catalog.yaml`
 * and writes exactly four of its RT-738 operations: edit a product, retire a
 * product (RT-768), add an identifier, retire an identifier (RT-769), all
 * through the generated client in `src/lib/catalog-queries.ts`.
 *
 * Product CREATE is held by owner decision D9 (RT-768 comment 13487) until
 * pricing lands (RT-484 / RT-485): no create wrapper, no create call, no `/new`
 * route. The store-override writes belong to RT-770.
 * Nothing here reaches POS, ERPNext or the Connector, hand-rolls a fetch, or
 * sets an Authorization header (cookie transport). Static source scan, comments
 * stripped.
 */
const wrapperSrc = readSource("src/lib/catalog-queries.ts");
const feature = sourcesUnder("src/catalog");
const surface = [{ file: "src/lib/catalog-queries.ts", src: wrapperSrc }, ...feature];

/** What no file of the catalog surface (the wrapper included) may contain. */
const FORBIDDEN: readonly [name: string, pattern: RegExp][] = [
  ["a PUT or DELETE through the generated client", /apiClient\.(PUT|DELETE)/],
  [
    "product create (held by D9)",
    /consoleCreateCatalogProduct|CreateCatalogProductRequest|"\/api\/v1\/catalog\/products"\s*,\s*\{[^}]*body/,
  ],
  [
    "a store-override write (RT-770)",
    /consoleUpsertStoreOverride|consoleRetireStoreOverride|store-overrides/,
  ],
  ["a POS route", /\/api\/pos\//],
  ["a POS credential", /X-Cashier-Admission|operatorAuthorization/i],
  ["an ERPNext / Frappe call", /frappe|\/api\/resource|\/api\/method/i],
  ["a Connector call", /ERPNext-Connector|connector-admin|listConnector/i],
  ["a hand-rolled fetch", /\bfetch\s*\(/],
  ["an Authorization or Bearer header", /[Aa]uthorization\s*:|[Bb]earer\s+/],
];

describe("console catalog boundary (RT-765, RT-766, RT-768, RT-769)", () => {
  test("exactly the three reads and the four writes are exported, on their paths", () => {
    const exported = Object.entries(queries)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual([
      "consoleAddProductIdentifier",
      "consoleGetCatalogProduct",
      "consoleListCatalogCategories",
      "consoleListCatalogProducts",
      "consoleRetireCatalogProduct",
      "consoleRetireProductIdentifier",
      "consoleUpdateCatalogProduct",
    ]);
    expect(wrapperSrc).toContain('"/api/v1/catalog/products"');
    expect(wrapperSrc).toContain('"/api/v1/catalog/products/{productId}"');
    expect(wrapperSrc).toContain('"/api/v1/catalog/categories"');
    expect(wrapperSrc).toContain('"/api/v1/catalog/products/{productId}/retire"');
    expect(wrapperSrc).toContain('"/api/v1/catalog/products/{productId}/identifiers"');
    expect(wrapperSrc).toContain('"/api/v1/catalog/products/{productId}/identifiers/retire"');
  });

  test("the writes are one PATCH on the product and three POSTs (retire, identifier add / retire)", () => {
    expect(wrapperSrc.match(/apiClient\.PATCH\(/g)).toHaveLength(1);
    expect(wrapperSrc.match(/apiClient\.POST\(/g)).toHaveLength(3);
    expect(wrapperSrc).toMatch(
      /apiClient\.PATCH\(\s*"\/api\/v1\/catalog\/products\/\{productId\}"/,
    );
    expect(wrapperSrc).toMatch(
      /apiClient\.POST\(\s*"\/api\/v1\/catalog\/products\/\{productId\}\/retire"/,
    );
    expect(wrapperSrc).toMatch(
      /apiClient\.POST\(\s*"\/api\/v1\/catalog\/products\/\{productId\}\/identifiers"/,
    );
    expect(wrapperSrc).toMatch(
      /apiClient\.POST\(\s*"\/api\/v1\/catalog\/products\/\{productId\}\/identifiers\/retire"/,
    );
  });

  test("product create is not shipped: no create wrapper, no /new route, no create UI", () => {
    expect(Object.keys(queries)).not.toContain("consoleCreateCatalogProduct");
    const routes = readSource("src/shell/catalogRoutes.tsx");
    expect(routes).not.toMatch(/path="catalog\/products\/new"/);
    expect(routes).not.toContain("CatalogProductCreate");
    const ui = feature.filter(({ src }) =>
      /products\/new|Idempotency-Key|newIdempotencyKey/.test(src),
    );
    expect(ui.map((f) => f.file)).toEqual([]);
  });

  test("the writes are reached only through the wrappers, never the client directly", () => {
    const direct = feature.filter(({ src }) => /apiClient\.(POST|PATCH)/.test(src));
    expect(direct.map((f) => f.file)).toEqual([]);
  });

  test("the feature reads through the wrappers, never the client directly", () => {
    const direct = feature.filter(({ src }) => src.includes("@/generated/client"));
    expect(direct.map((f) => f.file)).toEqual([]);
  });

  test.each(FORBIDDEN)("the catalog surface contains no %s", (_name, pattern) => {
    const offenders = surface.filter(({ src }) => pattern.test(src));
    expect(offenders.map((f) => f.file)).toEqual([]);
  });
});
