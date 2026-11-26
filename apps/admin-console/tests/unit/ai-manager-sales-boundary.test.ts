import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as queries from "@/lib/ai-manager-sales-queries";
import { describe, expect, test } from "vitest";
import { readSource, sourcesUnder } from "./source-scan";

/**
 * RT-1541 boundary (RT-1526 §5, AI-11, AI-13): the panel reads one operation through the
 * generated client, renders untrusted text as text, does no arithmetic on figures, logs nothing,
 * and stays OFF by default in every committed config. A crash stays inside the panel.
 */
const wrapperSrc = readSource("src/lib/ai-manager-sales-queries.ts");
const feature = sourcesUnder("src/ai-manager-sales");
const all = [wrapperSrc, ...feature.map((f) => f.src)];

describe("data boundary", () => {
  test("exactly one wrapper is exported, a POST to the one operation, nothing else", () => {
    const functions = Object.entries(queries)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(functions).toEqual(["consoleExplainSales"]);
    expect(wrapperSrc).toContain('"/api/v1/ai/manager-sales/explain"');
    expect(wrapperSrc.match(/apiClient\.POST/g)).toHaveLength(1);
    expect(wrapperSrc).toContain('"Idempotency-Key"');
    for (const src of all) expect(src).not.toMatch(/apiClient\.(GET|PUT|PATCH|DELETE)/);
  });

  test("the feature reads through the wrapper, never the client or fetch, and builds no auth header", () => {
    for (const { file, src } of feature) {
      expect(src, file).not.toContain("@/generated/client");
      expect(src, file).not.toMatch(/\bfetch\s*\(/);
      expect(src, file).not.toMatch(/[Aa]uthorization\s*:|[Bb]earer\s+/);
      expect(src, file).not.toMatch(/frappe|\/api\/resource|\/api\/method|ERPNext-Connector/i);
    }
  });

  test("a fresh Idempotency-Key per submit is minted per call by the shared helper", () => {
    const hook = readSource("src/ai-manager-sales/useManagerSalesAsk.ts");
    expect(hook).toContain("newIdempotencyKey()");
    expect(hook).toContain("@/lib/idempotency-key");
    expect(hook).not.toMatch(/useRef|useState|localStorage|sessionStorage/);
  });
});

describe("untrusted text and privacy", () => {
  test("no dangerouslySetInnerHTML, innerHTML or eval anywhere in the feature", () => {
    for (const { file, src } of feature) {
      expect(src, file).not.toMatch(
        /dangerouslySetInnerHTML|\.innerHTML|insertAdjacentHTML|\beval\s*\(|new Function/,
      );
    }
  });

  test("nothing logs, stores or sends a question or a figure", () => {
    for (const { file, src } of feature) {
      expect(src, file).not.toMatch(
        /console\.|localStorage|sessionStorage|indexedDB|sendBeacon|captureMessage/,
      );
      expect(src, file).not.toMatch(/captureException\(\s*(error|e|err)\b/);
    }
  });
});

describe("no arithmetic on figures (AI-13)", () => {
  test("figure values are never parsed or combined", () => {
    for (const { file, src } of feature) {
      expect(src, file).not.toMatch(
        /parseFloat|\bNumber\(|\.toFixed|Math\.(round|floor|ceil|sum)|BigInt|\.reduce\(/,
      );
      expect(src, file).not.toMatch(/\.value\s*[-+*/]\s|\bvalue\s*[-+*/]\s*\d/);
    }
  });
});

describe("default OFF in every committed config", () => {
  const appRoot = process.cwd();
  const repoRoot = join(appRoot, "..", "..");
  const NAME = "VITE_AI_MANAGER_SALES_PANEL";

  test("no env file, build config, package script or workflow turns the flag on", () => {
    const files = [
      ...readdirSync(appRoot).filter((f) => f.startsWith(".env")),
      "vite.config.ts",
      "vitest.config.ts",
      "playwright.config.ts",
      "package.json",
      "index.html",
    ].map((f) => join(appRoot, f));
    const workflows = join(repoRoot, ".github", "workflows");
    for (const f of readdirSync(workflows)) files.push(join(workflows, f));
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toContain(NAME);
    }
  });

  test("only the exact string 'true' is ON", () => {
    const src = readSource("src/ai-manager-sales/managerSalesAccess.ts");
    expect(src).toContain(`import.meta.env.${NAME} === "true"`);
  });
});
