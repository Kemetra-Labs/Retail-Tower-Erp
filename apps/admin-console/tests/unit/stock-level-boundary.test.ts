import * as queries from "@/lib/stock-level-queries";
import { describe, expect, test } from "vitest";
import { readSource, sourcesUnder } from "./source-scan";

/**
 * RT-1074 boundary: the stock-level editor calls exactly the five operations of
 * `catalog/stock-levels.yaml` through the generated client in
 * `src/lib/stock-level-queries.ts`. Nothing reaches ERPNext, the Connector or
 * POS (TH-1), hand-rolls a fetch, sets an Authorization header, or turns a
 * level into a number (TH-2). Static source scan, comments stripped.
 */
const wrapperSrc = readSource("src/lib/stock-level-queries.ts");
const feature = sourcesUnder("src/stock-levels");
const surface = [{ file: "src/lib/stock-level-queries.ts", src: wrapperSrc }, ...feature];

const FORBIDDEN: readonly [name: string, pattern: RegExp][] = [
  ["a DELETE through the generated client", /apiClient\.DELETE/],
  ["a POS route", /\/api\/pos\//],
  ["an ERPNext / Frappe call", /frappe|\/api\/resource|\/api\/method|erpnext/i],
  ["a Connector call", /ERPNext-Connector|connector-admin/i],
  ["a hand-rolled fetch", /\bfetch\s*\(/],
  ["an Authorization or Bearer header", /[Aa]uthorization\s*:|[Bb]earer\s+/],
  ["a level parsed to a number", /parseFloat|Number\(|toFixed|Math\.round|\+\s*values\./],
];

describe("stock-level boundary (RT-1074)", () => {
  test("exactly the five stock-levels operations are exported, on their paths", () => {
    const exported = Object.entries(queries)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(exported).toEqual([
      "consoleGetProductStockLevels",
      "consoleRetireStoreStockLevel",
      "consoleRetireTenantStockLevel",
      "consoleSetStoreStockLevel",
      "consoleSetTenantStockLevel",
    ]);
    expect(wrapperSrc).toMatch(
      /apiClient\.GET\(\s*"\/api\/v1\/catalog\/products\/\{productId\}\/stock-levels"/,
    );
    expect(wrapperSrc).toMatch(
      /apiClient\.PUT\(\s*"\/api\/v1\/catalog\/products\/\{productId\}\/stock-levels"/,
    );
    expect(wrapperSrc).toMatch(
      /apiClient\.POST\(\s*"\/api\/v1\/catalog\/products\/\{productId\}\/stock-levels\/retire"/,
    );
    expect(wrapperSrc).toMatch(
      /apiClient\.PUT\(\s*"\/api\/v1\/catalog\/products\/\{productId\}\/stock-levels\/stores\/\{storeId\}"/,
    );
    expect(wrapperSrc).toMatch(
      /apiClient\.POST\(\s*"\/api\/v1\/catalog\/products\/\{productId\}\/stock-levels\/stores\/\{storeId\}\/retire"/,
    );
  });

  test("both sets send the Idempotency-Key header; the retires do not", () => {
    expect(wrapperSrc.match(/"Idempotency-Key"/g)).toHaveLength(2);
  });

  test("the feature reaches the API only through the wrappers", () => {
    const direct = feature.filter(({ src }) => src.includes("@/generated/client"));
    expect(direct.map((f) => f.file)).toEqual([]);
  });

  test.each(FORBIDDEN)("the stock-level surface contains no %s", (_name, pattern) => {
    const offenders = surface.filter(({ src }) => pattern.test(src));
    expect(offenders.map((f) => f.file)).toEqual([]);
  });
});
