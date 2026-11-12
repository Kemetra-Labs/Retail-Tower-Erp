import { describe, expect, test } from "vitest";
import { readSource, sourcesUnder } from "./source-scan";

/**
 * RT-455 boundary. The tracking screens go through `tracking-queries.ts`
 * only: GETs of the RT-449 / RT-1081 reads, the RT-451 queue, sale-line findings
 * and tracking profile reads, and the commands the owner put in scope (comment
 * 15245 and 16678): place hold, release, recall, expiry correction and the
 * Tracking Resolution bind. The command wrappers are called only from
 * `useTrackingWrites.ts`. No ERPNext call, no hand-rolled fetch. Static scan.
 */
const wrapperSrc = readSource("src/lib/tracking-queries.ts");
const feature = sourcesUnder("src/tracking");
const all = [wrapperSrc, ...feature.map((f) => f.src)];

describe("tracking boundary (RT-455)", () => {
  test("the wrappers GET the tracking reads and POST only the approved commands", () => {
    const paths = [...wrapperSrc.matchAll(/apiClient\.(\w+)\("([^"]+)"/g)].map(
      ([, method, path]) => `${method} ${path}`,
    );
    expect(paths.sort()).toEqual([
      "GET /api/inventory/v1/recalls",
      "GET /api/inventory/v1/recalls/{recallId}",
      "GET /api/inventory/v1/safety/findings",
      "GET /api/inventory/v1/safety/sale-line-findings",
      "GET /api/inventory/v1/tracking-holds",
      "GET /api/inventory/v1/tracking-holds/{holdId}",
      "GET /api/inventory/v1/tracking-identities/{identityId}",
      "GET /api/inventory/v1/tracking-identities/{identityId}/expiry-corrections",
      "GET /api/inventory/v1/tracking-identities/{identityId}/positions",
      "GET /api/inventory/v1/tracking-resolutions",
      "GET /api/v1/catalog/products/{productId}/tracking-profile",
      "GET /api/v1/catalog/tracking-summary",
      "POST /api/inventory/v1/recalls",
      "POST /api/inventory/v1/tracking-holds",
      "POST /api/inventory/v1/tracking-holds/{holdId}/release",
      "POST /api/inventory/v1/tracking-identities/{identityId}/expiry-corrections",
      "POST /api/inventory/v1/tracking-resolutions/{saleId}/bind",
    ]);
  });

  test("only the write hook calls a command wrapper", () => {
    const commands =
      /\b(placeQualityHold|releaseTrackingHold|createInventoryRecall|correctTrackingIdentityExpiry|bindTrackingResolution)\(/;
    for (const { file, src } of feature) {
      if (file.endsWith("/useTrackingWrites.ts")) continue;
      expect(src, file).not.toMatch(commands);
    }
  });

  test("the bind command is called only from the write hook, and only the resolution panel reads the queue", () => {
    for (const { file, src } of feature) {
      if (!file.endsWith("/useTrackingWrites.ts"))
        expect(src, file).not.toMatch(/bindTrackingResolution\(/);
      if (!file.endsWith("/useTracking.ts")) {
        expect(src, file).not.toMatch(/listTrackingResolutionQueue\(|listSaleLineFindings\(/);
      }
    }
  });

  test("no ERPNext call and no hand-rolled fetch", () => {
    for (const src of all) {
      expect(src).not.toMatch(/\bfetch\(/);
      expect(src).not.toMatch(/frappe|\/api\/resource\//i);
    }
  });
});
