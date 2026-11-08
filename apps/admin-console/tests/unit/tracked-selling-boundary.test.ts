import { describe, expect, test } from "vitest";
import { readSource, sourcesUnder } from "./source-scan";

/**
 * RT-455 part 1 boundary. The tracked-selling switch goes through
 * `tracked-selling-queries.ts` only: the GET and the PUT of
 * `/api/inventory/v1/settings/tracked-selling`, nothing else. The PUT wrapper
 * is called only from the switch hook. No ERPNext call, no hand-rolled fetch,
 * and nothing in the Console evaluates a precondition. Static scan.
 */
const wrapperSrc = readSource("src/lib/tracked-selling-queries.ts");
const feature = sourcesUnder("src/tracked-selling");
const all = [wrapperSrc, ...feature.map((f) => f.src)];

describe("tracked-selling boundary (RT-455 part 1)", () => {
  test("the wrappers GET and PUT the one setting path", () => {
    const paths = [...wrapperSrc.matchAll(/apiClient\.(\w+)\("([^"]+)"/g)].map(
      ([, method, path]) => `${method} ${path}`,
    );
    expect(paths.sort()).toEqual([
      "GET /api/inventory/v1/settings/tracked-selling",
      "PUT /api/inventory/v1/settings/tracked-selling",
    ]);
  });

  test("only the switch hook calls the PUT wrapper", () => {
    for (const { file, src } of feature) {
      if (file.endsWith("/useTrackedSelling.ts")) continue;
      expect(src, file).not.toMatch(/\bsetTrackedSellingSetting\(/);
    }
  });

  test("no ERPNext call and no hand-rolled fetch", () => {
    for (const src of all) {
      expect(src).not.toMatch(/\bfetch\(/);
      expect(src).not.toMatch(/frappe|\/api\/resource\//i);
    }
  });
});
