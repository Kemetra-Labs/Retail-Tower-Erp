/**
 * RT-1540 (W8 P-07 part 2) — the replay of every `msx-eval/2` case through the real Manager Sales
 * route (`msx.replay.rig.ts`): each case's exact outcome, effects and safety gates against gold, plus
 * the same-key idempotency, the currency-less by-store question, and negative controls that prove the
 * scorer can fail.
 */
import { MSX_CASES, caseOf } from "./msx.cases";
import { observeCase, replayAll, replayCase, replayKey, scoreCase } from "./msx.replay";
import { buildRig } from "./msx.replay.rig";
import { MSX_GATES } from "./msx.types";

describe("msx replay: every case through the real route", () => {
  it.each(MSX_CASES.map((c) => [c.id, c] as const))("%s matches its gold outcome, effects and gates", async (_id, c) => {
    const result = await replayCase(c);
    expect({ failures: result.failures, gates: result.gateFailures }).toEqual({ failures: [], gates: [] });
    expect(result.actual).toBe(result.expected);
  });

  it("scores every gate G-S1 to G-S6 on at least one case, with no failure", async () => {
    const run = await replayAll(MSX_CASES);
    for (const gate of MSX_GATES) {
      const scored = run.results.filter((r) => r.gates[gate] !== "not_applicable");
      expect({ gate, scored: scored.length > 0, failing: scored.filter((r) => r.gates[gate] === "fail").map((r) => r.id) }).toEqual({ gate, scored: true, failing: [] });
    }
  });

  it("charges one unit once per answer and nothing else: 24 commits, 1 release, zero provider requests and tokens", async () => {
    const run = await replayAll(MSX_CASES);
    const sum = (pick: (r: (typeof run.results)[number]) => number): number => run.results.reduce((n, r) => n + pick(r), 0);
    expect(sum((r) => r.effects.commits)).toBe(24);
    expect(sum((r) => r.effects.committedUnits)).toBe(24);
    expect(sum((r) => r.effects.releases)).toBe(1);
    expect(sum((r) => r.effects.providerRequests)).toBe(0);
    expect(sum((r) => r.effects.tokens)).toBe(0);
    // Denials, refusals, 400s and 404s never reserve, read or settle (G-S3).
    for (const r of run.results.filter((x) => x.expected !== "200 answer" && x.id !== "case-32")) {
      expect({ id: r.id, reserves: r.effects.reserves, settled: r.effects.commits + r.effects.releases, reads: r.effects.evidenceReads }).toEqual({ id: r.id, reserves: 0, settled: 0, reads: "none" });
    }
  });

  it("runs the kill switch (33) and the opt-out (34) before any read or reservation, and case 32 releases with not_attempted", async () => {
    const killed = await replayCase(caseOf("case-33"));
    expect(killed.effects).toMatchObject({ entitlementChecks: 0, budgetChecks: 0, reserves: 0, evidenceReads: "none" });
    const optedOut = await replayCase(caseOf("case-34"));
    expect(optedOut.effects).toMatchObject({ entitlementChecks: 1, budgetChecks: 0, reserves: 0, evidenceReads: "none" });
    const failed = await replayCase(caseOf("case-32"));
    expect(failed.effects).toMatchObject({ evidenceReads: "attempted", reservation: "released", releaseReason: "not_attempted", reserves: 1, commits: 0, auditEvents: 0 });
  });

  it("records the port events of an answer in order: entitlement, budget, reservation, reads, commit", async () => {
    const o = await observeCase(caseOf("case-01"));
    expect(o.recorded.events).toEqual(["entitlement.check", "budget.check", "reserve", "read.summary", "settle.ok"]);
    expect(o.recorded.settlements[0]?.telemetry).not.toHaveProperty("providerKey");
    expect(o.recorded.reserves[0]).toMatchObject({ units: 1, idempotencyKey: replayKey(1) });
    expect(o.recorded.budgetChecks[0]).toMatchObject({ providerCost: "zero", routeKey: "deterministic_no_model" });
  });
});

describe("msx replay: idempotency and the missing currency", () => {
  it("a same-key replay charges once: one reservation is granted and one unit is committed", async () => {
    const rig = await buildRig(caseOf("case-01"));
    try {
      const key = replayKey(1);
      const first = await rig.post(caseOf("case-01").request as Record<string, unknown>, key);
      const second = await rig.post(caseOf("case-01").request as Record<string, unknown>, key);
      expect(first.body).toMatchObject({ kind: "answer" });
      // The global idempotency interceptor answers a replay from the stored response before the route;
      // without it the usage ledger still refuses to run the same key twice: nothing is reserved again.
      expect(second.body).toEqual({ kind: "unavailable", family: "gateway", code: "entitlement_unavailable" });
      expect(rig.recorded.granted.size).toBe(1);
      expect(rig.recorded.settlements.filter((s) => s.outcome === "ok")).toHaveLength(1);
      expect(rig.recorded.audits).toHaveLength(1);
    } finally {
      await rig.close();
    }
  });

  it("a new key is a new charge", async () => {
    const rig = await buildRig(caseOf("case-01"));
    try {
      await rig.post(caseOf("case-01").request as Record<string, unknown>, replayKey(1));
      await rig.post(caseOf("case-01").request as Record<string, unknown>, replayKey(101));
      expect(rig.recorded.granted.size).toBe(2);
      expect(rig.recorded.settlements.filter((s) => s.outcome === "ok")).toHaveLength(2);
    } finally {
      await rig.close();
    }
  });

  it("a question-only by-store request with no currency is unavailable / evidence_unavailable, reservation released, nothing read", async () => {
    const base = caseOf("case-08");
    const { currency: _dropped, ...request } = base.request as Record<string, unknown>;
    const o = await observeCase({ ...base, request }, replayKey(808));
    expect(o.status).toBe(200);
    expect(o.body).toEqual({ kind: "unavailable", family: "gateway", code: "evidence_unavailable" });
    expect(o.recorded.settlements.map((s) => s.outcome)).toEqual(["not_attempted"]);
    expect(o.recorded.audits).toHaveLength(0);
  });
});

describe("msx replay: the scorer can fail", () => {
  async function scoredWith(id: string, edit: (body: Record<string, unknown>) => void) {
    const c = caseOf(id);
    const o = await observeCase(c);
    const body = JSON.parse(JSON.stringify(o.body)) as Record<string, unknown>;
    edit(body);
    return scoreCase(c, o.status, body, o.recorded, o.reads, o.fetchCalls);
  }

  it("rejects a changed figure (outcome) and a figure that is not its pack field (G-S2)", async () => {
    const r = await scoredWith("case-01", (b) => {
      const cell = (b["blocks"] as { rows: { value: unknown }[][] }[])[0]!.rows[0]![0]!;
      cell.value = "22065.5001";
    });
    expect(r.failures).toContain("the body differs from gold");
    expect(r.gates["G-S2"]).toBe("fail");
  });

  it("rejects a leaked out-of-scope store in a response (G-S1)", async () => {
    const r = await scoredWith("case-04", (b) => {
      (b["scope"] as { storeRefs: string[] }).storeRefs.push("0191e540-0000-7000-8000-0000000000a3");
    });
    expect(r.gates["G-S1"]).not.toBe("pass");
  });

  it("rejects a bidi control and an echoed question (G-S5)", async () => {
    const bidi = await scoredWith("case-37", (b) => {
      const cell = (b["blocks"] as { rows: { value: unknown }[][] }[])[0]!.rows[1]![0]!;
      cell.value = `${String.fromCodePoint(0x202e)}${String(cell.value)}`;
    });
    expect(bidi.gates["G-S5"]).toBe("fail");
    const echoed = await scoredWith("case-21", (b) => {
      (b["notices"] as string[]).push("Zamalek Branch B1");
    });
    expect(echoed.gates["G-S5"]).toBe("fail");
  });

  it("rejects a provider request, a token and a missing commit (G-S6, effects)", async () => {
    const c = caseOf("case-01");
    const o = await observeCase(c);
    const withProvider = scoreCase(c, o.status, o.body, o.recorded, o.reads, 1);
    expect(withProvider.gates["G-S6"]).toBe("fail");
    const uncommitted = scoreCase(c, o.status, o.body, { ...o.recorded, settlements: [] }, o.reads, 0);
    expect(uncommitted.failures.join(" ")).toContain("reservation none, gold committed");
  });

  it("rejects a read or a reservation on a path that must end before the evidence (G-S3)", async () => {
    const c = caseOf("case-24");
    const o = await observeCase(c);
    const r = scoreCase(c, o.status, o.body, { ...o.recorded, reserves: [{ ...caseOf("case-01") } as never] }, o.reads, 0);
    expect(r.gates["G-S3"]).toBe("fail");
  });
});
