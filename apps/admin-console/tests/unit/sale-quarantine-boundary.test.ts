import * as queries from "@/lib/sale-quarantine-queries";
import { describe, expect, test } from "vitest";
import { readSource, sourcesUnder } from "./source-scan";

/**
 * RT-1312 boundary (Phase 3(b) slice B). The sale quarantine surfaces use only the three
 * operations of the generated client that slice B implements, through their wrappers. The
 * write-off is the one write: one POST per confirmation, never retried by the client, and no bulk
 * close. The repair (`consoleRepairQuarantinedSale`, slice C) is not reachable from the Console
 * yet: a test here has to change on purpose when slice C lands. No POS route, no ERPNext call, no
 * hand-rolled fetch, no Authorization header. Static scan, comments stripped.
 */
const wrapperSrc = readSource("src/lib/sale-quarantine-queries.ts");
const feature = sourcesUnder("src/sale-quarantine");
const all = [wrapperSrc, ...feature.map((f) => f.src)];

describe("sale quarantine boundary (RT-1312)", () => {
  test("exactly the three slice B wrappers are exported", () => {
    const functions = Object.entries(queries)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual([
      "consoleGetQuarantinedSale",
      "consoleListQuarantinedSales",
      "consoleWriteOffQuarantinedSale",
    ]);
  });

  test("the wrappers call only the quarantine paths; the one POST is the write-off", () => {
    const paths = [...wrapperSrc.matchAll(/apiClient\s*\.(\w+)\(\s*"([^"]+)"/g)].map(
      ([, method, path]) => `${method} ${path}`,
    );
    expect(paths.sort()).toEqual([
      "GET /api/v1/catalog/sale-sync-ops/quarantined-sales",
      "GET /api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}",
      "POST /api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}/write-off",
    ]);
  });

  test("the repair is not reachable: slice C is contract-only", () => {
    for (const src of all) {
      expect(src).not.toMatch(/consoleRepairQuarantinedSale/);
      expect(src).not.toMatch(/quarantined-sales\/\{quarantineRef\}\/repair/);
    }
  });

  test("the feature reads through the wrappers, never the client directly", () => {
    for (const { file, src } of feature) expect(src, file).not.toContain("@/generated/client");
  });

  test("the write-off is called from one place and never retried by the client", () => {
    const callers = feature.filter(({ src }) => /consoleWriteOffQuarantinedSale\(/.test(src));
    expect(callers.map(({ file }) => file.split("/").pop())).toEqual(["useQuarantine.ts"]);
    expect(callers[0].src.match(/consoleWriteOffQuarantinedSale\(/g)).toHaveLength(1);
    for (const { src } of feature) {
      expect(src).not.toMatch(/useMutation|retry:\s*(true|[1-9])|retryDelay/);
      expect(src).not.toMatch(/writeOffAll|closeAll|bulk/i);
    }
  });

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
