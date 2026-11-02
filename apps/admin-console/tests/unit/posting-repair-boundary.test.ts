import * as queries from "@/lib/erp-posting-repair-queries";
import { describe, expect, test } from "vitest";
import { readSource, sourcesUnder } from "./source-scan";

/**
 * RT-1072 boundary (RT-977 §4, §5, D5, D9). The sale detail's posting repair
 * uses exactly one operation of the generated `erpnext-reconciliation` client,
 * `repairPosting`, through its wrapper: one POST per confirmation, body `{}`
 * (no `note`), never a bulk repair. Backend-Core only: no ERPNext / Frappe /
 * Connector call, no hand-rolled fetch, no Authorization header. The stored
 * ERPNext reason is never logged or sent to telemetry. Return, refund and
 * credit-return reversals are not repaired here (D9). Static scan, comments
 * stripped.
 */
const wrapperSrc = readSource("src/lib/erp-posting-repair-queries.ts");
const bannerSrc = readSource("src/sales/ErpFailureBanner.tsx");
const feature = [
  ...sourcesUnder("src/posting-repair"),
  { file: "src/sales/ErpFailureBanner.tsx", src: bannerSrc },
];
const all = [wrapperSrc, ...feature.map((f) => f.src)];

describe("sale detail posting repair boundary (RT-1072)", () => {
  test("exactly the one repair wrapper is exported", () => {
    const functions = Object.entries(queries)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(functions).toEqual(["repairPosting"]);
  });

  test("the wrapper calls only the repairPosting path, with an Idempotency-Key and an empty body", () => {
    const paths = [...wrapperSrc.matchAll(/apiClient\.(\w+)\(\s*"([^"]+)"/g)].map(
      ([, method, path]) => `${method} ${path}`,
    );
    expect(paths).toEqual([
      "POST /api/v1/catalog/erpnext-reconciliation/postings/{workItemRef}/repair",
    ]);
    expect(wrapperSrc).toContain('"Idempotency-Key": idempotencyKey');
    expect(wrapperSrc).toContain("body: {}");
    expect(wrapperSrc).not.toMatch(/\bnote\b/);
  });

  test("the feature uses the wrapper, never the client directly", () => {
    for (const { file, src } of feature) expect(src, file).not.toContain("@/generated/client");
  });

  test("the repair is called from one place; no bulk repair; no other 017 write", () => {
    const callers = feature.filter(({ src }) => /\brepairPosting\(/.test(src));
    expect(callers.map(({ file }) => file.split("/").pop())).toEqual(["usePostingRepair.ts"]);
    for (const src of all) {
      expect(src).not.toMatch(/useMutation|repairAll|retryAll|bulkRepair/i);
      expect(src).not.toMatch(/reResolvePosting|triggerReconciliationRun|postings\/backlog/);
    }
  });

  test("no ERPNext, Frappe or Connector call; no POS route", () => {
    for (const src of all) {
      expect(src).not.toMatch(/frappe|\/api\/resource|\/api\/method/i);
      expect(src).not.toMatch(/connector-admin|\/api\/connector\//i);
      expect(src).not.toMatch(/\/api\/pos\//);
    }
  });

  test("no hand-rolled fetch, and no Authorization/Bearer header", () => {
    for (const src of all) {
      expect(src).not.toMatch(/\bfetch\s*\(/);
      expect(src).not.toMatch(/[Aa]uthorization\s*:/);
      expect(src).not.toMatch(/[Bb]earer\s+/);
    }
  });

  test("the stored reason is never logged, sent to telemetry or rendered as HTML", () => {
    for (const src of all) {
      expect(src).not.toMatch(/console\.(log|info|warn|error|debug)/);
      expect(src).not.toMatch(/Sentry|captureException|captureMessage|@\/observability/);
      expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    }
  });
});
