/**
 * RT-1540 — the reviewer and machine-readable reports of `msx-eval/2` and its replay.
 *
 * Both are deterministic (no clock, no timing, no host data) and are checked byte for byte against
 * committed goldens, as `e1-report.golden.md` is. The replay behind them runs here, through the real
 * Manager Sales route, so a runtime change that moves a case changes the report and fails this spec.
 *
 * To refresh the goldens after an intentional dataset change (a new dataset version):
 *   UPDATE_MSX_GOLDEN=1 npx jest test/ai/eval/manager-sales/msx-report
 * To write the reports of a run with its main SHA and date:
 *   MSX_REPORT_OUT=<dir> MSX_CODE_SHA=<sha> MSX_RUN_DATE=<date> npx jest test/ai/eval/manager-sales/msx-report
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { datasetHash } from "./msx.canonical";
import { MSX_CASES } from "./msx.cases";
import { renderMsxReport, renderMsxReportJson } from "./msx.report";
import { replayAll, type ReplayRun } from "./msx.replay";
import { MSX_GATES, MSX_LANGUAGES } from "./msx.types";

const GOLDEN = join(__dirname, "msx-report.golden.md");
const GOLDEN_JSON = join(__dirname, "msx-report.golden.json");
const INFO = { runDate: "fixture", codeSha: "fixture" } as const;
const normalize = (text: string): string => text.replace(/\r\n/g, "\n");

describe("msx-eval/2 replay report", () => {
  let run: ReplayRun;
  let report: string;
  let json: string;

  beforeAll(async () => {
    run = await replayAll(MSX_CASES);
    report = renderMsxReport(MSX_CASES, INFO, run);
    json = renderMsxReportJson(MSX_CASES, INFO, run);
  });

  it("renders byte-for-byte equal to the committed golden", () => {
    if (process.env["UPDATE_MSX_GOLDEN"] === "1") writeFileSync(GOLDEN, report, "utf8");
    expect(existsSync(GOLDEN)).toBe(true);
    expect(normalize(readFileSync(GOLDEN, "utf8"))).toBe(report);
  });

  it("renders the machine-readable report byte-for-byte equal to its golden", () => {
    if (process.env["UPDATE_MSX_GOLDEN"] === "1") writeFileSync(GOLDEN_JSON, json, "utf8");
    expect(existsSync(GOLDEN_JSON)).toBe(true);
    expect(normalize(readFileSync(GOLDEN_JSON, "utf8"))).toBe(json);
  });

  it("is reproducible: a second replay and render are identical", async () => {
    const again = await replayAll(MSX_CASES);
    expect(renderMsxReport(MSX_CASES, INFO, again)).toBe(report);
    expect(renderMsxReportJson(MSX_CASES, INFO, again)).toBe(json);
  });

  it("writes the reports of a run with its SHA and date when MSX_REPORT_OUT is set", () => {
    const out = process.env["MSX_REPORT_OUT"];
    if (out === undefined || out === "") return;
    const info = { runDate: process.env["MSX_RUN_DATE"] ?? "unspecified", codeSha: process.env["MSX_CODE_SHA"] ?? "unspecified" };
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "msx-report.md"), renderMsxReport(MSX_CASES, info, run), "utf8");
    writeFileSync(join(out, "msx-report.json"), renderMsxReportJson(MSX_CASES, info, run), "utf8");
  });

  it("states the fixture version, the dataset hash, the SHA slot and the contract it validates against", () => {
    expect(report).toContain("Dataset: msx-eval/2");
    expect(report).toContain("Fixture version: msx-eval/2");
    expect(report).toContain("Code SHA: fixture");
    expect(report).toContain(`sha256 ${datasetHash()}`);
    expect(report).toContain("ai-manager-sales-explain.openapi.yaml");
    expect(report).toContain("1.0.0-draft");
    const parsed = JSON.parse(json) as { dataset: { version: string; sha256: string }; run: { codeSha: string } };
    expect(parsed.dataset).toMatchObject({ version: "msx-eval/2", sha256: datasetHash() });
    expect(parsed.run.codeSha).toBe("fixture");
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
    const fewer = renderMsxReport(MSX_CASES.slice(1), INFO, run);
    expect(fewer).toContain("Cases: 37");
    const ungated = renderMsxReport(
      MSX_CASES.map((c) => ({ ...c, gates: c.gates.filter((g) => g !== "G-S5") })),
      INFO,
      run,
    );
    expect(ungated).toContain("| G-S5 | 0 | none |");
  });

  it("reports every case's observed outcome, the six gate verdicts, the settlement counts and zero provider calls", () => {
    expect(report).toContain("Cases passing: 38 of 38.");
    for (const gate of MSX_GATES) expect(report).toMatch(new RegExp(`\\| ${gate} \\| \\d+ \\| \\d+ \\| none \\| PASS \\|`));
    expect(report).toContain("Answers committed: 24 (units committed: 24");
    expect(report).toContain("Reservations released: 1 ");
    expect(report).toContain("Provider requests: 0. Tokens: 0.");
    const parsed = JSON.parse(json) as { totals: { providerRequests: number; tokens: number; commits: number; passing: number }; cases: { passed: boolean }[]; gates: { verdict: string }[] };
    expect(parsed.totals).toMatchObject({ providerRequests: 0, tokens: 0, commits: 24, passing: 38 });
    expect(parsed.cases).toHaveLength(38);
    expect(parsed.cases.every((c) => c.passed)).toBe(true);
    expect(parsed.gates.map((g) => g.verdict)).toEqual(Array(6).fill("PASS"));
  });

  it("a failing replay result turns its case and its gate to FAIL in both reports", () => {
    const broken: ReplayRun = {
      results: run.results.map((r) => (r.id === "case-18" ? { ...r, failures: ["outcome 200 answer, gold 404 not_found"], gateFailures: ["G-S1: the response carries a store"], gates: { ...r.gates, "G-S1": "fail" } } : r)),
    };
    const text = renderMsxReport(MSX_CASES, INFO, broken);
    expect(text).toContain("Cases passing: 37 of 38.");
    expect(text).toContain("Failing cases: case-18.");
    expect(text).toMatch(/\| G-S1 \| \d+ \| \d+ \| case-18 \| FAIL \|/);
    expect(JSON.parse(renderMsxReportJson(MSX_CASES, INFO, broken)).gates[0]).toMatchObject({ gate: "G-S1", verdict: "FAIL", failing: ["case-18"] });
  });

  it("records the owner 404 decision and the reproducible commands", () => {
    expect(report).toContain("RT-1538 comment 18048");
    expect(report).toContain("case-18, case-19, case-36");
    expect(report).toContain("pnpm lint:eslint");
    expect(report).toContain("MIGRATION_TEST_ALLOW_SKIP=1 npx jest test/ai");
    expect(report).toContain("MSX_REPORT_OUT=");
  });

  it("never presents a model quality score, says what was not measured and prints no response body", () => {
    for (const required of ["synthetic", "No model was evaluated", "no provider", "Human review: not performed"]) {
      expect(report).toContain(required);
    }
    expect(report).not.toMatch(/\bGO\b(?! |\/)/);
    expect(report).not.toContain("13459.5000");
    expect(json).not.toContain("13459.5000");
    expect(json).not.toContain("request_id");
  });
});
