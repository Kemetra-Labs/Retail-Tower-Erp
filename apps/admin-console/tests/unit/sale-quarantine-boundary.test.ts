import * as queries from "@/lib/sale-quarantine-queries";
import { describe, expect, test } from "vitest";
import { readSource, sourcesUnder } from "./source-scan";

/**
 * RT-1312 boundary (Phase 3(b) slices B and C). The sale quarantine surfaces use only the four
 * operations of the generated client that slices B and C implement, through their wrappers. The
 * write-off and the repair are the two writes: one POST per confirmation each, never retried by
 * the client, and no bulk close or repair. No POS route, no ERPNext call, no
 * hand-rolled fetch, no Authorization header. Static scan, comments stripped.
 */
const wrapperSrc = readSource("src/lib/sale-quarantine-queries.ts");
const feature = sourcesUnder("src/sale-quarantine");
const all = [wrapperSrc, ...feature.map((f) => f.src)];

describe("sale quarantine boundary (RT-1312)", () => {
  test("exactly the four slice B and C wrappers are exported", () => {
    const functions = Object.entries(queries)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual([
      "consoleGetQuarantinedSale",
      "consoleListQuarantinedSales",
      "consoleRepairQuarantinedSale",
      "consoleWriteOffQuarantinedSale",
    ]);
  });

  test("the wrappers call only the quarantine paths; the two POSTs are the write-off and the repair", () => {
    const paths = [...wrapperSrc.matchAll(/apiClient\s*\.(\w+)\(\s*"([^"]+)"/g)].map(
      ([, method, path]) => `${method} ${path}`,
    );
    expect(paths.sort()).toEqual([
      "GET /api/v1/catalog/sale-sync-ops/quarantined-sales",
      "GET /api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}",
      "POST /api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}/repair",
      "POST /api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}/write-off",
    ]);
  });

  test("the feature reads through the wrappers, never the client directly", () => {
    for (const { file, src } of feature) expect(src, file).not.toContain("@/generated/client");
  });

  test.each(["consoleWriteOffQuarantinedSale", "consoleRepairQuarantinedSale"])(
    "%s is called from one place and never retried by the client",
    (name) => {
      const callers = feature.filter(({ src }) => src.includes(`${name}(`));
      expect(callers.map(({ file }) => file.split("/").pop())).toEqual(["useQuarantine.ts"]);
      expect(callers[0].src.split(`${name}(`)).toHaveLength(2);
      for (const { src } of feature) {
        expect(src).not.toMatch(/useMutation|retry:\s*(true|[1-9])|retryDelay/);
        expect(src).not.toMatch(/writeOffAll|closeAll|repairAll|bulk/i);
      }
    },
  );

  test("it does not reach into the ERP-sync dead-letter wrappers", () => {
    for (const { file, src } of feature) {
      expect(src, file).not.toContain("@/lib/sale-sync-ops-queries");
    }
  });

  test("no POS route, POS credential or ERP system is reached", () => {
    for (const src of all) {
      expect(src).not.toMatch(/\/api\/pos\//);
      expect(src).not.toMatch(/X-Cashier-Admission|operatorAuthorization/i);
      expect(src).not.toMatch(/frappe|\/api\/resource|\/api\/method/i);
    }
  });

  test("no hand-rolled fetch, and no Authorization/Bearer header", () => {
    for (const src of all) {
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/[Aa]uthorization\s*:/);
      expect(src).not.toMatch(/[Bb]earer\s+/);
    }
  });
});
