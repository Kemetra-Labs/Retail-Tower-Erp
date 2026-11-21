/**
 * RT-1540 — the reviewer report of the `msx-eval/1` dataset.
 *
 * Deterministic: no clock, no timing, no host data. The only run-specific inputs
 * (`runDate`, `codeSha`) are passed in. It reports the dataset and its safety-gate
 * map; it carries no quality score because nothing here runs the feature (the
 * replay runner depends on P-06, RT-1539, itself blocked by RT-1542).
 */
import { sha256Of } from "./msx.canonical";
import { MSX_GATE_TITLES, MSX_GATES, MSX_LANGUAGES, MSX_VERSIONS, type MsxCase } from "./msx.types";
import { MSX_AMBIGUITIES } from "./msx.ambiguities";

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
const idsOf = (cases: readonly MsxCase[]): string => (cases.length === 0 ? "none" : cases.map((c) => c.id).join(", "));

function outcomeOf(c: MsxCase): string {
  const e = c.expected;
  if (e.status !== 200) return `${e.status} ${e.code}`;
  return e.kind === "answer" ? "200 answer" : `200 ${e.kind} ${e.code}`;
}

function identityLines(cases: readonly MsxCase[], info: RunInfo): string[] {
  return [
    "## 1. Dataset identity",
    "",
    `- Dataset: ${MSX_VERSIONS.dataset}, sha256 ${sha256Of({ version: MSX_VERSIONS.dataset, cases })}`,
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
    "- Slice: Manager Sales Ask/Explain (W8, AI-WS05C S02 and S10). Phase: synthetic fixtures only, no model, no provider, no network.",
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

function gateLines(cases: readonly MsxCase[]): string[] {
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

const COMMANDS = [
  "## 6. Reproducible commands",
  "",
  "From `services/backend-core`:",
  "",
  "```bash",
  "pnpm install --frozen-lockfile --ignore-scripts",
  'pnpm --filter "@data-pulse-2/api^..." build',
  "cd apps/api",
  "npx jest test/ai/eval/manager-sales",
  "npx jest test/ai/eval/e1",
  "UPDATE_MSX_GOLDEN=1 npx jest test/ai/eval/manager-sales/msx-report   # only for a new dataset version",
  "cd ../..",
  "pnpm lint:eslint",
  "node tools/code-health/check.mjs",
  "```",
  "",
];

function closingLines(): string[] {
  return [
    "## 7. Not measured and known gaps",
    "",
    "- No model was evaluated, no provider or network was used, and no quality score exists.",
    "- Replay runner: not part of this report. It executes these cases against the P-06 feature (RT-1539), which does not exist yet and is blocked by RT-1542. Until then the dataset is validated against the contract only; no gate is scored on a live path.",
    "- Human review: not performed. Gold labels are transcribed from RT-1526 v6 section 6, not adjudicated.",
    "- Fixture figures are hand-written synthetic literals. Citation `fieldPath` values and ledger `task_class` are placeholders until RT-1539 and RT-1527 fix their domains.",
    "",
    "## 8. Interpretations of RT-1526 v6 section 6",
    "",
    ...MSX_AMBIGUITIES.map((line) => `- ${line}`),
    "",
  ];
}

export function renderMsxReport(cases: readonly MsxCase[], info: RunInfo): string {
  return [
    "# RT-1540 offline dataset report — Manager Sales Ask/Explain (dataset only)",
    "",
    "> Synthetic fixtures only. No model was evaluated, no provider or network was used, and no quality score exists. This reports the",
    "> `msx-eval/1` dataset and its safety-gate map; the replay runner waits for P-06 (RT-1539, blocked by RT-1542).",
    "",
    ...identityLines(cases, info),
    ...scopeLines(cases),
    ...countLines(cases),
    ...gateLines(cases),
    ...decisionLines(cases),
    ...COMMANDS,
    ...closingLines(),
  ].join("\n");
}
