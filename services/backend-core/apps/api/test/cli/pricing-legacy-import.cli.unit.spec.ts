/**
 * RT-1485 PR-16a-2a — the legacy import CLI: argument parsing (MC-10 inputs required, never
 * defaulted), exit codes and the report (ids, classes and counts only).
 */
import { EXIT, parseArgs, runImportCli, USAGE, type ParsedArgs } from "../../src/cli/pricing-legacy-import/cli";
import type { LegacyImportResult } from "../../src/pricing";

const TENANT = "0a000000-0000-7000-8000-000000001485";
const ACTOR = "0a000000-0000-7000-8000-0000000014a1";
const BASE = ["run", "--tenant", TENANT, "--actor", ACTOR, "--currency", "EGP", "--tax-basis", "inclusive"];

describe("parseArgs", () => {
  it("parses the required inputs and the optional flags", () => {
    expect(parseArgs(BASE)).toEqual({
      tenantId: TENANT,
      actorUserId: ACTOR,
      inputs: { currencyCode: "EGP", taxPriceBasis: "inclusive", referenceZone: null },
      dryRun: false,
      json: false,
    });
    expect(parseArgs([...BASE, "--reference-zone", "Africa/Cairo", "--dry-run", "--json"])).toMatchObject({
      inputs: { referenceZone: "Africa/Cairo" },
      dryRun: true,
      json: true,
    });
  });

  it.each([
    ["no command", BASE.slice(1)],
    ["another command", ["import", ...BASE.slice(1)]],
    ["no currency", ["run", "--tenant", TENANT, "--actor", ACTOR, "--tax-basis", "inclusive"]],
    ["no tax basis", ["run", "--tenant", TENANT, "--actor", ACTOR, "--currency", "EGP"]],
    ["no actor", ["run", "--tenant", TENANT, "--currency", "EGP", "--tax-basis", "inclusive"]],
    ["a bad tenant id", ["run", "--tenant", "x", "--actor", ACTOR, "--currency", "EGP", "--tax-basis", "inclusive"]],
    ["a lower-case currency", [...BASE.slice(0, 6), "egp", ...BASE.slice(7)]],
    ["an unknown currency", [...BASE.slice(0, 6), "XYZ", ...BASE.slice(7)]],
    ["a bad tax basis", [...BASE.slice(0, 8), "gross"]],
    ["an unknown zone", [...BASE, "--reference-zone", "Mars/Olympus"]],
    ["a repeated flag", [...BASE, "--json", "--json"]],
    ["an unknown flag", [...BASE, "--force"]],
    ["a flag with no value", [...BASE, "--reference-zone"]],
  ])("refuses %s", (_name, argv) => {
    expect(parseArgs(argv)).toBeNull();
  });
});

const imported: LegacyImportResult = {
  outcome: "imported",
  revisionNo: 1,
  priceBookId: "0a000000-0000-7000-8000-0000000014b0",
  bookCreated: true,
  runId: "0a000000-0000-7000-8000-0000000014c0",
  changeLogSequence: 42,
  counts: { bookEvents: 2, storeEvents: 1, zeroPrice: 1, notRepresentable: 0 },
  exceptions: [{ cls: "zero_price", scope: "store", storeId: "0a000000-0000-7000-8000-0000000014d0", productId: "0a000000-0000-7000-8000-0000000014e0" }],
};

async function cli(argv: readonly string[], result: LegacyImportResult): Promise<{ code: number; lines: string[]; calls: ParsedArgs[] }> {
  const lines: string[] = [];
  const calls: ParsedArgs[] = [];
  const code = await runImportCli(argv, {
    out: (l) => lines.push(l),
    run: async (args) => {
      calls.push(args);
      return result;
    },
  });
  return { code, lines, calls };
}

describe("runImportCli", () => {
  it("prints usage and exits 2 without running on bad arguments", async () => {
    const r = await cli(["run"], imported);
    expect(r).toEqual({ code: EXIT.usage, lines: [USAGE], calls: [] });
  });

  it("reports an import with its exceptions and exits 0", async () => {
    const r = await cli(BASE, imported);
    expect(r.code).toBe(EXIT.ok);
    expect(r.lines[0]).toContain("imported; revision 1");
    expect(r.lines[0]).toContain("(created)");
    expect(r.lines.join("\n")).toContain("exception zero_price store product 0a000000-0000-7000-8000-0000000014e0 store 0a000000-0000-7000-8000-0000000014d0");
    expect(r.lines.at(-1)).toContain("blocks this tenant's cutover");
  });

  it("exits 3 on a refusal and prints its reason", async () => {
    const r = await cli(BASE, { outcome: "refused", reason: "delta_import_pending_decision", detail: { head: 1 } });
    expect(r.code).toBe(EXIT.refused);
    expect(r.lines).toEqual([`tenant ${TENANT}: import refused (delta_import_pending_decision) {"head":1}`]);
  });

  it("prints one JSON document with --json", async () => {
    const r = await cli([...BASE, "--json"], imported);
    expect(JSON.parse(r.lines[0]!)).toMatchObject({ tenantId: TENANT, outcome: "imported", revisionNo: 1 });
    expect(r.lines).toHaveLength(1);
  });
});
