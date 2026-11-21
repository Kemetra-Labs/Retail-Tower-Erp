/**
 * RT-1540 — the reviewer report and the machine-readable report of the `msx-eval/2` dataset and its
 * replay through the real Manager Sales route.
 *
 * Deterministic: no clock, no timing, no host data. The only run-specific inputs (`runDate`,
 * `codeSha`) are passed in. The report carries no quality score: it states, per case, the expected
 * and the observed outcome and effects, and a pass or fail verdict per safety gate. It never prints a
 * response body, a store name or a figure beyond the fixed synthetic dataset.
 */
import { sha256Of } from "./msx.canonical";
import { MSX_AMBIGUITIES } from "./msx.ambiguities";
import type { CaseResult, ReplayRun } from "./msx.replay.types";
import { MSX_GATE_TITLES, MSX_GATES, MSX_LANGUAGES, MSX_VERSIONS, type MsxCase, type MsxGate } from "./msx.types";

export interface RunInfo {
  readonly runDate: string;
  readonly codeSha: string;
}

const countBy = (cases: readonly MsxCase[], key: (c: MsxCase) => string): [string, number][] => {
  const counts = new Map<string, number>();
  for (const c of cases) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
};

const rows = (pairs: readonly (readonly [string, number])[]): string[] => pairs.map(([name, n]) => `| ${name} | ${n} |`);
const idsOf = (cases: readonly { readonly id: string }[]): string => (cases.length === 0 ? "none" : cases.map((c) => c.id).join(", "));

function outcomeOf(c: MsxCase): string {
  const e = c.expected;
  if (e.status !== 200) return `${e.status} ${e.code}`;
  return e.kind === "answer" ? "200 answer" : `200 ${e.kind} ${e.code}`;
}

/** The replay results of the cases the report covers, in case order. */
function resultsFor(cases: readonly MsxCase[], run: ReplayRun): CaseResult[] {
  const byId = new Map(run.results.map((r) => [r.id, r]));
  return cases.map((c) => {
    const found = byId.get(c.id);
    if (found === undefined) throw new Error(`the replay run has no result for ${c.id}`);
    return found;
  });
}

const passed = (r: CaseResult): boolean => r.failures.length === 0 && r.gateFailures.length === 0;

interface Totals {
  readonly cases: number;
  readonly passing: number;
  readonly reserves: number;
  readonly commits: number;
  readonly committedUnits: number;
  readonly releases: number;
  readonly auditEvents: number;
  readonly providerRequests: number;
  readonly tokens: number;
}

function totalsOf(results: readonly CaseResult[]): Totals {
  const sum = (pick: (r: CaseResult) => number): number => results.reduce((n, r) => n + pick(r), 0);
  return {
    cases: results.length,
    passing: results.filter(passed).length,
    reserves: sum((r) => r.effects.reserves),
    commits: sum((r) => r.effects.commits),
    committedUnits: sum((r) => r.effects.committedUnits),
    releases: sum((r) => r.effects.releases),
    auditEvents: sum((r) => r.effects.auditEvents),
    providerRequests: sum((r) => r.effects.providerRequests),
    tokens: sum((r) => r.effects.tokens),
  };
}

interface GateRow {
  readonly gate: MsxGate;
  readonly cases: number;
  readonly passing: number;
  readonly failing: readonly string[];
  readonly verdict: "PASS" | "FAIL";
}

function gateRowsOf(cases: readonly MsxCase[], results: readonly CaseResult[]): GateRow[] {
  return MSX_GATES.map((gate) => {
    const scored = results.filter((r) => r.gates[gate] !== "not_applicable");
    const failing = scored.filter((r) => r.gates[gate] === "fail").map((r) => r.id);
    const declared = cases.filter((c) => c.gates.includes(gate)).length;
    return { gate, cases: scored.length, passing: scored.length - failing.length, failing, verdict: failing.length === 0 && scored.length === declared ? "PASS" : "FAIL" };
  });
}

function identityLines(cases: readonly MsxCase[], info: RunInfo): string[] {
  return [
    "## 1. Dataset identity",
    "",
    `- Dataset: ${MSX_VERSIONS.dataset}, sha256 ${sha256Of({ version: MSX_VERSIONS.dataset, cases })}`,
    `- Fixture version: ${MSX_VERSIONS.dataset} (the dataset, its synthetic world and its gold labels)`,
    `- Run date: ${info.runDate}`,
    `- Code SHA: ${info.codeSha}`,
    `- Planning source: ${MSX_VERSIONS.planning}, section 6 (cases 1 to 38) and gates G-S1 to G-S6`,
    `- Contract validated against: ${MSX_VERSIONS.contractFile} (${MSX_VERSIONS.contractVersion}, operation ${MSX_VERSIONS.operationId})`,
    `- Template catalogue ${MSX_VERSIONS.templates}; match ${MSX_VERSIONS.match}; pack ${MSX_VERSIONS.pack}; answer codes ${MSX_VERSIONS.answerCodes}`,
    "",
  ];
}

function scopeLines(cases: readonly MsxCase[]): string[] {
  return [
    "## 2. Scope",
    "",
    "- Slice: Manager Sales Ask/Explain (W8, AI-WS05C S02 and S10). Phase: the real P-06 route (controller, role gate, store scope, AiGateway with its preflight, feature, matcher, evidence builder, renderer, response mapping) over synthetic reads and recording ports. No model, no provider, no network.",
    "- Synthetic only: the session and tenant-context guards, the membership lookup, the store-liveness lookup, the sales reads' fact rows, the entitlement and budget ports (recording fakes) and the audit queue.",
    "- Tenants and stores: synthetic. Tenant A has stores A1 (EGP), A2 (EGP) and A3 (SAR); tenant B has store B1.",
    "- Callers: OA owner (tenant-wide), MA store manager (A1, A2), MS store manager (A1), PA platform admin.",
    `- Cases: ${cases.length}`,
    "",
  ];
}

function countLines(cases: readonly MsxCase[]): string[] {
  const gateCounts: [string, number][] = MSX_GATES.map((gate) => [gate, cases.filter((c) => c.gates.includes(gate)).length]);
  return [
    "## 3. Counts",
    "",
    "| Category | Cases |",
    "| --- | --- |",
    ...rows(countBy(cases, (c) => c.category)),
    "",
    "| Language | Cases |",
    "| --- | --- |",
    ...rows(MSX_LANGUAGES.map((lang): [string, number] => [lang, cases.filter((c) => c.language === lang).length])),
    "",
    "| Gate | Cases |",
    "| --- | --- |",
    ...rows(gateCounts),
    "",
    "| Expected outcome | Cases |",
    "| --- | --- |",
    ...rows(countBy(cases, outcomeOf)),
    "",
  ];
}

function gateMapLines(cases: readonly MsxCase[]): string[] {
  return [
    "## 4. Safety-gate map",
    "",
    "| Gate | Cases | Case ids | Rule |",
    "| --- | --- | --- | --- |",
    ...MSX_GATES.map((gate) => {
      const declared = cases.filter((c) => c.gates.includes(gate));
      return `| ${gate} | ${declared.length} | ${idsOf(declared)} | ${MSX_GATE_TITLES[gate]} |`;
    }),
    "",
    "| Case | RT-1526 v6 section 6 | Category | Language | Expected outcome | Gates |",
    "| --- | --- | --- | --- | --- | --- |",
    ...cases.map((c) => `| ${c.id} | row ${c.section6} | ${c.category} | ${c.language} | ${outcomeOf(c)} | ${c.gates.join(", ")} |`),
    "",
  ];
}

function decisionLines(cases: readonly MsxCase[]): string[] {
  const decided = cases.filter((c) => c.traceability.includes("RT-1538 comment 18048"));
  return [
    "## 5. Owner decision encoded (RT-1538 comment 18048)",
    "",
    "- An out-of-scope or unknown store, and a refused role (platform admin included), is the non-disclosing HTTP 404 `not_found`, not a 200 `unavailable` with `store_out_of_scope` or `not_authorized`.",
    `- Cases encoded as 404 under this decision: ${idsOf(decided)}.`,
    "- No expected outcome of this dataset carries `store_out_of_scope` or `not_authorized`.",
    "",
  ];
}

const yesNo = (value: boolean): string => (value ? "pass" : "FAIL");

function replayLines(results: readonly CaseResult[]): string[] {
  return [
    "## 6. Replay results (expected against observed)",
    "",
    "| Case | Expected | Observed | Reads | Reservation | Reserves | Commits | Releases | Result |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.id} | ${r.expected} | ${r.actual} | ${r.effects.evidenceReads} | ${r.effects.reservation}${r.effects.releaseReason === null ? "" : ` (${r.effects.releaseReason})`} | ${r.effects.reserves} | ${r.effects.commits} | ${r.effects.releases} | ${yesNo(passed(r))} |`,
    ),
    "",
    `- Cases passing: ${results.filter(passed).length} of ${results.length}.`,
    `- Failing cases: ${idsOf(results.filter((r) => !passed(r)))}.`,
    "",
  ];
}

function gateVerdictLines(gateRows: readonly GateRow[]): string[] {
  return [
    "## 7. Gate verdicts from the replay",
    "",
    "| Gate | Cases scored | Passing | Failing cases | Verdict |",
    "| --- | --- | --- | --- | --- |",
    ...gateRows.map((g) => `| ${g.gate} | ${g.cases} | ${g.passing} | ${g.failing.length === 0 ? "none" : g.failing.join(", ")} | ${g.verdict} |`),
    "",
  ];
}

function settlementLines(t: Totals): string[] {
  return [
    "## 8. Settlement and provider calls",
    "",
    `- Answers committed: ${t.commits} (units committed: ${t.committedUnits}, each one unit at zero provider cost).`,
    `- Reservations released: ${t.releases} (an evidence failure releases with the \`not_attempted\` outcome).`,
    `- Reservations made: ${t.reserves}.`,
    `- Audit events: ${t.auditEvents} (one per 200 answer, none for a refusal, a denial or a failure).`,
    `- Provider requests: ${t.providerRequests}. Tokens: ${t.tokens}.`,
    "",
  ];
}

const COMMANDS = [
  "## 9. Reproducible commands",
  "",
  "From `services/backend-core`:",
  "",
  "```bash",
  "pnpm install --frozen-lockfile --ignore-scripts",
  'pnpm --filter "@data-pulse-2/api^..." build',
  "cd apps/api",
  "npx jest test/ai/eval/manager-sales",
  "npx jest test/ai/eval/e1",
  "MIGRATION_TEST_ALLOW_SKIP=1 npx jest test/ai",
  "UPDATE_MSX_GOLDEN=1 npx jest test/ai/eval/manager-sales/msx-report   # only for a new dataset version",
  "MSX_REPORT_OUT=<dir> MSX_CODE_SHA=<main sha> MSX_RUN_DATE=<date> npx jest test/ai/eval/manager-sales/msx-report   # writes the report for a run",
  "cd ../..",
  "pnpm lint:eslint",
  "```",
  "",
];

function closingLines(): string[] {
  return [
    "## 10. Not measured and known gaps",
    "",
    "- No model was evaluated, no provider or network was used, and no quality score exists.",
    "- The replay runs the real route over synthetic reads: the two sales reads' SQL, the tenant-context and session guards, the entitlement and budget services, and the idempotency interceptor are not exercised here (the P-06 db integration spec and the interceptor's own specs cover them).",
    "- Human review: not performed. Gold labels are transcribed from RT-1526 v6 section 6 and aligned to the runtime presentation, not adjudicated.",
    "",
    "## 11. Interpretations of RT-1526 v6 section 6 and alignments to the runtime",
    "",
    ...MSX_AMBIGUITIES.map((line) => `- ${line}`),
    "",
  ];
}

export function renderMsxReport(cases: readonly MsxCase[], info: RunInfo, run: ReplayRun): string {
  const results = resultsFor(cases, run);
  return [
    "# RT-1540 replay report — Manager Sales Ask/Explain (msx-eval/2)",
    "",
    "> Synthetic fixtures only. Every case is replayed through the real Manager Sales route. No model was evaluated, no provider or network was",
    "> used, and no quality score exists. This reports the `msx-eval/2` dataset, its safety-gate map and the observed outcome of each case.",
    "",
    ...identityLines(cases, info),
    ...scopeLines(cases),
    ...countLines(cases),
    ...gateMapLines(cases),
    ...decisionLines(cases),
    ...replayLines(results),
    ...gateVerdictLines(gateRowsOf(cases, results)),
    ...settlementLines(totalsOf(results)),
    ...COMMANDS,
    ...closingLines(),
  ].join("\n");
}

/** The machine-readable report: stable key order, no clock, no body, no store name. */
export function renderMsxReportJson(cases: readonly MsxCase[], info: RunInfo, run: ReplayRun): string {
  const results = resultsFor(cases, run);
  const report = {
    schema: "msx-replay-report/1",
    dataset: { version: MSX_VERSIONS.dataset, sha256: sha256Of({ version: MSX_VERSIONS.dataset, cases }), cases: cases.length },
    run: { runDate: info.runDate, codeSha: info.codeSha },
    versions: { contract: MSX_VERSIONS.contractVersion, templates: MSX_VERSIONS.templates, match: MSX_VERSIONS.match, pack: MSX_VERSIONS.pack, planning: MSX_VERSIONS.planning },
    totals: totalsOf(results),
    gates: gateRowsOf(cases, results).map((g) => ({ gate: g.gate, casesScored: g.cases, passing: g.passing, failing: g.failing, verdict: g.verdict })),
    cases: results.map((r) => ({
      id: r.id,
      section6: r.section6,
      expected: r.expected,
      observed: r.actual,
      passed: passed(r),
      failures: r.failures,
      gateFailures: r.gateFailures,
      gates: r.gates,
      effects: r.effects,
    })),
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}
