import * as queries from "@/lib/count-session-queries";
import { describe, expect, test } from "vitest";
import { readSource, sourcesUnder } from "./source-scan";

/**
 * RT-1425 boundary. The Count Session screens use the eleven Count Session
 * operations of the generated inventory client through their wrappers and nothing
 * else of inventory: no legacy `recordStockCount`, no stock or on-hand read (capture
 * is blind), no ERPNext call, no hand-rolled fetch, no Authorization header, and no
 * tenant, store or actor in a request body. Static scan, comments stripped.
 */
const wrapperSrc = readSource("src/lib/count-session-queries.ts");
const feature = sourcesUnder("src/count-sessions");
const all = [wrapperSrc, ...feature.map((f) => f.src)];

describe("count sessions boundary (RT-1425)", () => {
  test("exactly the eleven Count Session wrappers and the four setting wrappers are exported", () => {
    const functions = Object.entries(queries)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name)
      .sort();
    expect(functions).toEqual([
      "approveCountSession",
      "cancelCountSession",
      "createCountSession",
      "getCountSelfApprovalSetting",
      "getCountSession",
      "getCountSessionsSetting",
      "listCountLateEventFindings",
      "listCountSessions",
      "listCountVarianceLines",
      "recordCountObservations",
      "requestCountRecount",
      "setCountSelfApprovalSetting",
      "setCountSessionsSetting",
      "submitCountSession",
      "takeCountCut",
    ]);
  });

  test("every call targets a count-sessions path of the store or the self-approval setting, and only those", () => {
    const calls = [...wrapperSrc.matchAll(/apiClient\.(\w+)\(\s*([^,)]+)[,)]/g)].map(
      ([, method, path]) => `${method} ${path.trim()}`,
    );
    expect(calls).toHaveLength(15);
    for (const call of calls) {
      expect(call).toMatch(
        /^(GET|POST|PUT) (SESSIONS|SESSION|SELF_APPROVAL|ACTIVATION|`\$\{SESSION\}\/[a-z-]+`)$/,
      );
    }
    expect(wrapperSrc).toContain('"/api/inventory/v1/settings/count-self-approval"');
    expect(wrapperSrc).toContain('"/api/inventory/v1/settings/count-sessions"');
    expect(wrapperSrc).toContain('"/api/inventory/v1/stores/{storeId}/count-sessions"');
  });

  test("the feature goes through the wrappers, never the generated client", () => {
    for (const { file, src } of feature) {
      expect(src, file).not.toContain("@/generated/client");
      expect(src, file).not.toMatch(
        /recordStockCount|createStockMovement|createStockTransfer|createStatusMove|createRelocation/,
      );
    }
  });

  test("capture is blind: no on-hand, movement or stock-level read in the feature", () => {
    for (const { file, src } of feature) {
      expect(src, file).not.toMatch(
        /getOnHand|listStoreMovements|stock-level-queries|stock-discrepancy-queries|listReconciliation|listErpnextNegativeOnHand/,
      );
    }
  });

  test("no request body carries tenant, store or actor", () => {
    const logic = readSource("src/count-sessions/countLogic.ts");
    expect(logic).not.toMatch(/tenantId|storeId|actorId|createdBy|openedBy:/);
  });

  test("no ERP system, hand-rolled fetch or Authorization header", () => {
    for (const src of all) {
      expect(src).not.toMatch(/frappe|\/api\/resource|\/api\/method/i);
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/[Aa]uthorization\s*:/);
    }
  });

  test("no manual-resolution action is shipped (no contract behind it)", () => {
    for (const { file, src } of feature) {
      expect(src, file).not.toMatch(/erp_absorbed|resolveCount|breakGlass/i);
    }
  });

  test("the legacy Desk Stock Reconciliation help no longer invites an independent ERP adjustment", () => {
    const en = readSource("src/i18n/messages/en/stock.ts");
    expect(en).not.toContain("Or record a physical count with a Stock Reconciliation");
    expect(en).toContain("Do not adjust stock yourself");
  });
});
