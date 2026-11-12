import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as client from "@/lib/client";
import { describe, expect, test } from "vitest";

/**
 * RT-1109 boundary. The vouchers page calls Backend-Core only, through the four
 * generated-client wrappers of vouchers-admin.openapi.yaml. Its own code
 * (src/vouchers/**) holds no hand-rolled fetch and never touches browser
 * storage, so a voucher code cannot outlive the issue drawer (acceptance
 * criterion 1: codes never reach browser storage; a reload cannot show them).
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

const clientSrc = stripComments(readFileSync(join(process.cwd(), "src/lib/client.ts"), "utf8"));
const voucherSrc = filesUnder(join(process.cwd(), "src/vouchers"))
  .map((f) => stripComments(readFileSync(f, "utf8")))
  .join("\n");

describe("voucher wrappers", () => {
  test("the four wrappers are exported", () => {
    expect(typeof client.consoleIssueVouchers).toBe("function");
    expect(typeof client.consoleListVouchers).toBe("function");
    expect(typeof client.consoleGetVoucher).toBe("function");
    expect(typeof client.consoleCancelVoucher).toBe("function");
  });

  test("they call the generated voucher paths, never a hand-rolled fetch", () => {
    expect(clientSrc).toContain('"/api/v1/vouchers"');
    expect(clientSrc).toContain('"/api/v1/vouchers/{voucher_id}"');
    expect(clientSrc).toContain('"/api/v1/vouchers/{voucher_id}/cancel"');
    expect(clientSrc).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("the vouchers page's own code", () => {
  test("reaches Backend-Core only through the voucher wrappers", () => {
    expect(voucherSrc).not.toMatch(/\bfetch\s*\(/);
    expect(voucherSrc).not.toMatch(/XMLHttpRequest|axios/);
    expect(voucherSrc).not.toMatch(/\/api\/resource|\/api\/method|frappe|erpnext/i);
    const wrappers = new Set(voucherSrc.match(/\bconsole[A-Z]\w+(?=\()/g) ?? []);
    expect([...wrappers].sort()).toEqual([
      "consoleCancelVoucher",
      "consoleGetVoucher",
      "consoleIssueVouchers",
      "consoleListVouchers",
    ]);
  });

  test("never touches browser storage, the URL or a log with voucher data", () => {
    expect(voucherSrc).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(voucherSrc).not.toMatch(/history\.(push|replace)State|searchParams/);
    expect(voucherSrc).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  test("the issue response is not a react-query mutation or query", () => {
    expect(voucherSrc).not.toMatch(/useMutation/);
  });
});
