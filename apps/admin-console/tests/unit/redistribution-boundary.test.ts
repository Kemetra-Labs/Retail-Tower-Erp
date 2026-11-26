import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as queries from "@/lib/redistribution-queries";
import { describe, expect, test } from "vitest";

/**
 * RT-1601 boundary. The redistribution screens call Backend-Core only, through the six generated-client
 * wrappers of `inventory/redistribution-proposals.yaml`. They hold no hand-rolled fetch, no browser
 * storage, no ERP or Frappe call, and no stock arithmetic: the rule, the validator, the freshness gate
 * and the accept re-check are Backend-Core's (RT-1600); the Console only sends and shows.
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
function filesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) filesUnder(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}
const source = filesUnder(join(process.cwd(), "src/redistribution"))
  .map((f) => stripComments(readFileSync(f, "utf8")))
  .join("\n");

describe("redistribution boundary", () => {
  test("exactly the six contract operations are wrapped", () => {
    const wrapped = Object.keys(queries).filter(
      (k) => typeof (queries as Record<string, unknown>)[k] === "function",
    );
    expect(wrapped.sort()).toEqual([
      "acceptRedistributionProposal",
      "createRedistributionProposal",
      "getRedistributionProposal",
      "listRedistributionProposals",
      "rejectRedistributionProposal",
      "reviewRedistributionProposal",
    ]);
  });

  test("no fetch, no storage, no ERP call, no quantity arithmetic", () => {
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(source).not.toMatch(/erpnext|frappe/i);
    expect(source).not.toMatch(/parseFloat|Number\(\s*\w*\.?(quantity|deficit)/);
    expect(source).not.toMatch(/apiClient/);
  });
});
