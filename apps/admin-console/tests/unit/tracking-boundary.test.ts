import { describe, expect, test } from "vitest";
import { readSource, sourcesUnder } from "./source-scan";

/**
 * RT-455 boundary. The tracking screens read through `tracking-queries.ts`
 * only: GETs of the RT-449 / RT-1081 reads. The RT-451 Step 0 operations are
 * contract-only (no route), so nothing names their paths or ids: their tabs
 * are «قريبًا» frames. No ERPNext call, no hand-rolled fetch. Static scan.
 */
const wrapperSrc = readSource("src/lib/tracking-queries.ts");
const feature = sourcesUnder("src/tracking");
const all = [wrapperSrc, ...feature.map((f) => f.src)];

describe("tracking boundary (RT-455)", () => {
  test("the wrappers GET exactly the tracking reads", () => {
    const paths = [...wrapperSrc.matchAll(/apiClient\.(\w+)\("([^"]+)"/g)].map(
      ([, method, path]) => `${method} ${path}`,
    );
    expect(paths.sort()).toEqual([
      "GET /api/inventory/v1/recalls",
      "GET /api/inventory/v1/recalls/{recallId}",
      "GET /api/inventory/v1/safety/findings",
      "GET /api/inventory/v1/tracking-holds",
      "GET /api/inventory/v1/tracking-holds/{holdId}",
      "GET /api/inventory/v1/tracking-identities/{identityId}",
      "GET /api/inventory/v1/tracking-identities/{identityId}/expiry-corrections",
      "GET /api/inventory/v1/tracking-identities/{identityId}/positions",
      "GET /api/v1/catalog/tracking-summary",
    ]);
  });

  test("the contract-only RT-451 reads and the bind command are never called", () => {
    for (const src of all) {
      expect(src).not.toMatch(/tracking-resolution|sale-line-findings/);
      expect(src).not.toMatch(
        /listTrackingResolutionQueue|bindTrackingResolution|listSaleLineFindings/,
      );
    }
  });

  test("no ERPNext call and no hand-rolled fetch", () => {
    for (const src of all) {
      expect(src).not.toMatch(/\bfetch\(/);
      expect(src).not.toMatch(/frappe|\/api\/resource\//i);
    }
  });
});
