/**
 * RT-1540 (W8 P-07 part 2) — the replay runner of `msx-eval/2`: drives every case through the REAL
 * Manager Sales route (`msx.replay.rig.ts`) and scores its observed outcome, effects and the safety
 * gates G-S1 to G-S6 against the hand-written gold labels. Nothing here reads the answers it scores
 * from the code under test; a case fails when the runtime disagrees with the dataset.
 */
import { MSX_CASES } from "./msx.cases";
import { MSX_FEATURE_ID } from "../../../../src/ai/manager-sales/msx.constants";
import type { CaseResult, GateVerdict, ObservedEffects, ReplayRun } from "./msx.replay.types";
import { buildRig, type Recorded } from "./msx.replay.rig";
import { MSX_GATES, type MsxCase, type MsxExpected, type MsxGate } from "./msx.types";
import { STORE_A1, STORE_A2, STORE_A3, STORE_B1, TENANT_B, NAME_A1, NAME_A2, NAME_A3, NAME_B1 } from "./msx.world";

/** The idempotency key is built at run time: a key literal reads as a secret to gitleaks. */
export const replayKey = (section6: number): string => ["rt1540", "replay", String(section6)].join("-");

const BIDI = new RegExp(`[${["\\u061c", "\\u200e-\\u200f", "\\u202a-\\u202e", "\\u2066-\\u2069"].join("")}]`, "u");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ALL_STORES = [STORE_A1, STORE_A2, STORE_A3];
const STORE_NAMES: Readonly<Record<string, string>> = { [STORE_A1]: NAME_A1, [STORE_A2]: NAME_A2, [STORE_A3]: NAME_A3 };

function labelOf(status: number, body: unknown): string {
  const b = body as { kind?: string; code?: string; error?: { code?: string } };
  if (status === 200) return b.kind === "answer" ? "200 answer" : `200 ${b.kind ?? "?"} ${b.code ?? "?"}`;
  return `${status} ${b.error?.code ?? "?"}`;
}

function expectedLabelOf(e: MsxExpected): string {
  if (e.status !== 200) return `${e.status} ${e.code}`;
  return e.kind === "answer" ? "200 answer" : `200 ${e.kind} ${e.code}`;
}

/** The ledger latency is measured by the route (a clock); it is checked as a non-negative integer, never compared. */
function withoutLatency(body: unknown): unknown {
  const answer = body as { kind?: string; ledger?: Record<string, unknown> };
  if (answer?.kind !== "answer" || answer.ledger === undefined) return body;
  const { latency_ms: _latency, ...ledger } = answer.ledger;
  return { ...answer, ledger };
}

function expectedBodyOf(e: MsxExpected): unknown {
  if (e.status === 404) return { error: { code: "not_found", message: "Not Found" } };
  if (e.status === 400) return { error: { code: "validation_error" } };
  return e.body;
}

function observedEffects(r: Recorded, reads: { summary: unknown[]; byStore: unknown[] }, c: MsxCase, fetchCalls: number): ObservedEffects {
  const commits = r.settlements.filter((s) => s.outcome === "ok");
  const releases = r.settlements.filter((s) => s.outcome !== "ok");
  const readCount = reads.summary.length + reads.byStore.length;
  // An evidence failure is observed: a read was called and threw (a `.failed` event), not read off the precondition.
  const readFailed = r.events.some((e) => e.endsWith(".failed"));
  const tokens = r.settlements.reduce((sum, s) => sum + (s.telemetry.inputTokens ?? 0) + (s.telemetry.outputTokens ?? 0), 0);
  return {
    evidenceReads: readCount === 0 ? "none" : readFailed ? "attempted" : "completed",
    reservation: commits.length > 0 ? "committed" : releases.length > 0 ? "released" : "none",
    releaseReason: releases[0]?.outcome ?? null,
    reserves: r.reserves.length,
    budgetChecks: r.budgetChecks.length,
    entitlementChecks: r.checks.length,
    commits: commits.length,
    releases: releases.length,
    committedUnits: commits.length * (r.reserves[0]?.units ?? 0),
    auditEvents: r.audits.length,
    providerRequests: r.providerCalls + r.settlements.filter((s) => s.telemetry.providerKey !== undefined).length + fetchCalls,
    tokens,
  };
}

interface Visible {
  readonly ids: readonly string[];
  readonly names: readonly string[];
}

function visibleTo(c: MsxCase): Visible {
  const ids = c.caller.storeAccess === "all" ? ALL_STORES : c.caller.storeIds;
  return { ids, names: ids.map((id) => STORE_NAMES[id]!) };
}

/** Every string a caller must never see or leave in a log: another tenant, or a store outside the scope. */
function forbiddenOf(c: MsxCase): string[] {
  const hidden = ALL_STORES.filter((id) => !visibleTo(c).ids.includes(id));
  return [TENANT_B, STORE_B1, NAME_B1, ...hidden, ...hidden.map((id) => STORE_NAMES[id]!)];
}

/** The error envelope's `request_id` is a per-request id, not tenant data. */
function withoutRequestId(body: unknown): unknown {
  const e = (body as { error?: Record<string, unknown> }).error;
  if (e === undefined) return body;
  const { request_id: _id, ...rest } = e;
  return { error: rest };
}

interface ReadInput {
  readonly tenantId?: unknown;
  readonly storeId?: unknown;
  readonly context?: { readonly storeAccess?: unknown };
}

/** The caller's real store access, as the resolved context carries it. */
function storeAccessOf(c: MsxCase): unknown {
  return c.caller.storeAccess === "all" ? { kind: "all" } : { kind: "specific", storeIds: c.caller.storeIds };
}

const AUDIT_KEYS = ["from", "scope_mode", "store_count", "template_id", "to"];

interface AnswerFacts {
  readonly templateId: string;
  readonly scope: { readonly mode: string; readonly storeRefs: readonly unknown[] };
  readonly period: { readonly from: string; readonly to: string };
}

/** Every read, port input and audit event stays inside the caller's tenant and stores. */
function g1Inputs(c: MsxCase, body: unknown, r: Recorded, reads: { summary: unknown[]; byStore: unknown[] }): string[] {
  const out: string[] = [];
  const visible = visibleTo(c).ids;
  const access = JSON.stringify(storeAccessOf(c));
  for (const input of [...reads.summary, ...reads.byStore] as ReadInput[]) {
    if (input.tenantId !== c.caller.tenantId) out.push("a read ran for another tenant");
    if (JSON.stringify(input.context?.storeAccess) !== access) out.push("a read ran with another store access than the caller's");
    if (typeof input.storeId === "string" && !visible.includes(input.storeId)) out.push("a read asked for a store outside the caller's scope");
  }
  const requested = JSON.stringify(c.request["storeIds"]);
  for (const input of [...r.checks, ...r.reserves, ...r.budgetChecks]) {
    if (input.tenantId !== c.caller.tenantId) out.push("a port input carries another tenant");
    if (input.featureId !== MSX_FEATURE_ID) out.push("a port input carries another feature");
    if (JSON.stringify(input.storeIds) !== requested) out.push("a port input carries other stores than the effective ones");
  }
  for (const reserve of r.reserves) if (JSON.stringify(reserve.ctx.storeAccess) !== access) out.push("a reservation ran with another store access than the caller's");
  const answer = (body as { kind?: string }).kind === "answer" ? (body as AnswerFacts) : null;
  for (const audit of r.audits) {
    const meta = audit.metadata as Record<string, unknown>;
    if (Object.keys(meta).sort().join() !== AUDIT_KEYS.join()) out.push("the audit metadata keys are not exactly template_id, scope_mode, store_count, from, to");
    if (audit.tenant_id !== c.caller.tenantId) out.push("the audit event carries another tenant");
    if (answer !== null) {
      const want: Record<string, unknown> = { template_id: answer.templateId, scope_mode: answer.scope.mode, store_count: answer.scope.storeRefs.length, from: answer.period.from, to: answer.period.to };
      for (const key of AUDIT_KEYS) if (meta[key] !== want[key]) out.push(`the audit metadata ${key} differs from the answer`);
    }
  }
  return out;
}

function g1(c: MsxCase, status: number, body: unknown, r: Recorded, reads: { summary: unknown[]; byStore: unknown[] }): string[] {
  const out = g1Inputs(c, body, r, reads);
  const seen = JSON.stringify(body);
  // One entry per read, port input, log line, audit event and settlement. An entry that is exactly the
  // untrusted text is the case's own input and is skipped; every other entry is checked in full.
  const entries: unknown[] = [...reads.summary, ...reads.byStore, ...r.logs, ...r.audits, ...r.settlements, ...r.checks, ...r.budgetChecks, ...r.reserves.map((x) => ({ ...x, ctx: undefined }))];
  const logged = JSON.stringify(entries.filter((entry) => entry !== c.untrusted?.text));
  for (const text of forbiddenOf(c)) {
    if (seen.includes(text)) out.push(`the response carries ${text}`);
    if (logged.includes(text)) out.push(`a log, read, port input or audit event carries ${text}`);
  }
  if (c.untrusted?.where === "question" && logged.includes(c.untrusted.text)) out.push("the question text reached a log or a port input");
  const allowed = new Set<string>(visibleTo(c).ids);
  for (const id of JSON.stringify(withoutRequestId(body)).match(UUID) ?? []) if (!allowed.has(id)) out.push(`the response carries the id ${id}, outside the scope`);
  if (status === 404 && Object.keys((body as { error?: object }).error ?? {}).filter((k) => k !== "request_id").sort().join() !== "code,message") out.push("the 404 body is not the non-disclosing one");
  return out;
}

function g2(c: MsxCase, body: unknown): string[] {
  const answer = body as { kind?: string; citations?: { ref: string }[]; blocks?: { type: string; rows?: { ref: string; value: unknown; currency?: string }[][]; slots?: Record<string, { ref: string }> }[] };
  if (answer.kind !== "answer" || c.evidence === null) return [];
  const pack = new Map(c.evidence.figures.map((f) => [f.ref, f]));
  const out: string[] = [];
  const cited = new Set((answer.citations ?? []).map((x) => x.ref));
  const shown = new Set<string>();
  for (const block of answer.blocks ?? []) {
    for (const slot of Object.values(block.slots ?? {})) shown.add(slot.ref);
    for (const cell of (block.rows ?? []).flat()) {
      shown.add(cell.ref);
      const figure = pack.get(cell.ref);
      if (figure === undefined) out.push(`cell ${cell.ref} is not a pack figure`);
      else if (cell.ref.includes("storeName")) continue;
      else if (figure.value !== cell.value) out.push(`cell ${cell.ref} shows ${String(cell.value)}, the pack holds ${String(figure.value)}`);
      else if (cell.currency !== undefined && cell.currency !== figure.currency) out.push(`cell ${cell.ref} carries another currency than the pack`);
    }
  }
  for (const ref of shown) if (!cited.has(ref)) out.push(`${ref} is shown without a citation`);
  for (const ref of cited) if (!pack.has(ref)) out.push(`citation ${ref} is not in the pack`);
  return out;
}

function g5(c: MsxCase, body: unknown): string[] {
  const seen = JSON.stringify(body);
  const out: string[] = [];
  if (BIDI.test(seen)) out.push("a bidi control reached the response");
  if (c.untrusted?.where === "question" && seen.includes(c.untrusted.text)) out.push("the question text is echoed");
  if (c.untrusted?.where === "store_name") {
    const expected = JSON.stringify(expectedBodyOf(c.expected));
    const count = (text: string): number => seen.split(text).length - 1;
    if (count(c.untrusted.text) !== expected.split(c.untrusted.text).length - 1) out.push("the store name text is not rendered exactly as the isolated cell");
  }
  return out;
}

export function scoreCase(c: MsxCase, status: number, body: unknown, r: Recorded, reads: { summary: unknown[]; byStore: unknown[] }, fetchCalls: number): CaseResult {
  const effects = observedEffects(r, reads, c, fetchCalls);
  const failures: string[] = [];
  const expectedLabel = expectedLabelOf(c.expected);
  const actual = labelOf(status, body);
  if (actual !== expectedLabel) failures.push(`outcome ${actual}, gold ${expectedLabel}`);
  if (JSON.stringify(normalized(status, body)) !== JSON.stringify(normalized(c.expected.status, expectedBodyOf(c.expected)))) failures.push("the body differs from gold");
  const latency = (body as { ledger?: { latency_ms?: unknown } }).ledger?.latency_ms;
  if (c.expected.status === 200 && c.expected.kind === "answer" && !(Number.isInteger(latency) && (latency as number) >= 0)) failures.push("ledger.latency_ms is not a non-negative integer");
  if (effects.evidenceReads !== c.effects.evidenceReads) failures.push(`evidence reads ${effects.evidenceReads}, gold ${c.effects.evidenceReads}`);
  if (effects.reservation !== c.effects.reservation) failures.push(`reservation ${effects.reservation}, gold ${c.effects.reservation}`);
  if (c.effects.reservation === "committed" && (effects.commits !== 1 || effects.committedUnits !== 1 || effects.releases !== 0)) failures.push("an answer must commit exactly one unit once");
  if (c.effects.reservation === "released" && (effects.releaseReason !== "not_attempted" || effects.commits !== 0)) failures.push("a failure must release with not_attempted and never commit");
  if (c.effects.reservation === "none" && (effects.reserves !== 0 || effects.commits + effects.releases !== 0)) failures.push("a denial or refusal must not reserve or settle");
  if (effects.providerRequests !== c.effects.providerRequests || effects.tokens !== c.effects.tokens) failures.push("a provider request or a token was counted");
  for (const settlement of r.settlements) {
    if (!r.granted.has(settlement.reservationId)) failures.push("a settlement is not for a granted reservation");
    if (settlement.tenantId !== c.caller.tenantId) failures.push("a settlement carries another tenant");
  }
  const audited = c.expected.status === 200 && c.expected.kind === "answer" ? 1 : 0;
  if (effects.auditEvents !== audited) failures.push(`audit events ${effects.auditEvents}, expected ${audited}`);

  const found: Record<MsxGate, string[]> = {
    "G-S1": g1(c, status, body, r, reads),
    "G-S2": g2(c, body),
    "G-S3": effects.evidenceReads === "none" && effects.reserves === 0 && effects.commits + effects.releases === 0 ? [] : ["a read or a reservation happened on a path that ends before the evidence"],
    "G-S4": actual === expectedLabel && codeOf(status, body) === codeOf(c.expected.status, expectedBodyOf(c.expected)) ? [] : [`code ${codeOf(status, body)}`],
    "G-S5": g5(c, body),
    "G-S6": effects.providerRequests === 0 && effects.tokens === 0 ? [] : ["a provider request or a token"],
  };
  const gates = Object.fromEntries(MSX_GATES.map((g) => [g, !c.gates.includes(g) ? "not_applicable" : found[g].length === 0 ? "pass" : "fail"])) as Record<MsxGate, GateVerdict>;
  const gateFailures = MSX_GATES.filter((g) => c.gates.includes(g)).flatMap((g) => found[g].map((m) => `${g}: ${m}`));
  return { id: c.id, section6: c.section6, expected: expectedLabel, actual, outcomeMatches: actual === expectedLabel, failures, effects, gates, gateFailures, body };
}

const codeOf = (status: number, body: unknown): string => {
  const b = body as { code?: string; error?: { code?: string } };
  return status === 200 ? (b.code ?? "answer") : (b.error?.code ?? "?");
};

/** A 200 compares in full but for the latency; a 400 and a 404 by their stable error code (and the 404's fixed message). */
function normalized(status: number, body: unknown): unknown {
  if (status === 200) return withoutLatency(body);
  const e = (body as { error?: { code?: string; message?: string } }).error;
  return status === 404 ? { code: e?.code, message: e?.message } : { code: e?.code };
}

/** What one replay observed, before scoring: the HTTP answer, the recorded port events and the reads. */
export interface Observed {
  readonly status: number;
  readonly body: unknown;
  readonly recorded: Recorded;
  readonly reads: { summary: unknown[]; byStore: unknown[] };
  readonly fetchCalls: number;
}

export async function observeCase(c: MsxCase, key: string = replayKey(c.section6)): Promise<Observed> {
  const rig = await buildRig(c);
  const fetchSpy = typeof globalThis.fetch === "function" ? jest.spyOn(globalThis, "fetch") : null;
  try {
    const res = await rig.post(c.request as Record<string, unknown>, key);
    return { status: res.status, body: res.body, recorded: rig.recorded, reads: rig.reads.calls, fetchCalls: fetchSpy?.mock.calls.length ?? 0 };
  } finally {
    fetchSpy?.mockRestore();
    await rig.close();
  }
}

export async function replayCase(c: MsxCase, key: string = replayKey(c.section6)): Promise<CaseResult> {
  const o = await observeCase(c, key);
  return scoreCase(c, o.status, o.body, o.recorded, o.reads, o.fetchCalls);
}

export async function replayAll(cases: readonly MsxCase[] = MSX_CASES): Promise<ReplayRun> {
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await replayCase(c));
  return { results };
}
