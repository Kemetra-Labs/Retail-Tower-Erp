/**
 * RT-1540 — the reviewer report generator for `msx-eval/1`.
 *
 * The report is deterministic (no clock, no timing, no host data) and is checked
 * byte for byte against a committed golden, as `e1-report.golden.md` is.
 *
 * To refresh the golden after an intentional dataset change (a new dataset
 * version): UPDATE_MSX_GOLDEN=1 pnpm --filter @data-pulse-2/api test -- msx-report
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { datasetHash } from "./msx.canonical";
import { MSX_CASES } from "./msx.cases";
import { renderMsxReport } from "./msx.report";
import { MSX_GATES, MSX_LANGUAGES } from "./msx.types";

const GOLDEN = join(__dirname, "msx-report.golden.md");
const INFO = { runDate: "fixture", codeSha: "fixture" } as const;
const normalize = (text: string): string => text.replace(/\r\n/g, "\n");

describe("msx-eval/1 reviewer report", () => {
  const report = renderMsxReport(MSX_CASES, INFO);

  it("renders byte-for-byte equal to the committed golden", () => {
    if (process.env["UPDATE_MSX_GOLDEN"] === "1") writeFileSync(GOLDEN, report, "utf8");
    expect(existsSync(GOLDEN)).toBe(true);
    expect(normalize(readFileSync(GOLDEN, "utf8"))).toBe(report);
  });

  it("is reproducible: a second render is identical", () => {
    expect(renderMsxReport(MSX_CASES, INFO)).toBe(report);
  });

  it("states the fixture version, the dataset hash and the contract it validates against", () => {
    expect(report).toContain("Dataset: msx-eval/1");
    expect(report).toContain(`sha256 ${datasetHash()}`);
    expect(report).toContain("ai-manager-sales-explain.openapi.yaml");
    expect(report).toContain("1.0.0-draft");
  });

  it("counts cases by category, language and gate, and lists every gate", () => {
    expect(report).toContain("| Answer | 12 |");
    expect(report).toContain("| Store leakage | 2 |");
    for (const lang of MSX_LANGUAGES) expect(report).toContain(`| ${lang} | ${MSX_CASES.filter((c) => c.language === lang).length} |`);
    for (const gate of MSX_GATES) {
      const ids = MSX_CASES.filter((c) => c.gates.includes(gate)).map((c) => c.id);
      expect(report).toContain(`| ${gate} | ${ids.length} |`);
    }
    expect(report).toContain("| 200 answer | 24 |");
    expect(report).toContain("| 404 not_found | 3 |");
    expect(report).toContain("| 400 validation_error | 2 |");
  });

  it("follows the dataset: removing a case or a gate changes the counts", () => {
    const fewer = renderMsxReport(MSX_CASES.slice(1), INFO);
    expect(fewer).toContain("Cases: 37");
    const ungated = renderMsxReport(
      MSX_CASES.map((c) => ({ ...c, gates: c.gates.filter((g) => g !== "G-S5") })),
      INFO,
    );
    expect(ungated).toContain("| G-S5 | 0 | none |");
  });

  it("records the owner 404 decision, the reproducible commands and the remaining P-06 runtime dependency", () => {
    expect(report).toContain("RT-1538 comment 18048");
    expect(report).toContain("case-18, case-19, case-36");
    expect(report).toContain("pnpm lint:eslint");
    expect(report).toContain("RT-1539");
    expect(report).toContain("RT-1542");
  });

  it("never presents a model quality score and says what was not measured", () => {
    for (const required of ["synthetic", "No model was evaluated", "no provider", "Replay runner: not part of this report", "Human review: not performed"]) {
      expect(report).toContain(required);
    }
    expect(report).not.toMatch(/\bGO\b(?! |\/)/);
  });
});
