/**
 * RT-1542 (RT-641 foundation, RT-1527 D-1R) — the deterministic Tier-0 route.
 *
 * Tier 0 (`deterministic_no_model`) runs a feature-supplied pure executor
 * instead of a provider call. It is still a Gateway run: authorize, kill
 * switch, entitlement, budget pre-check and the quota reservation come first;
 * the evidence pack is built; the executor output goes through the SAME strict
 * output schema and evidence-ref check as model output. A validated run
 * commits ONE request-count unit (AD-AI-ENT-001 D-3); every other end releases
 * (D-8). No provider is requested, no model or provider cost exists, and the
 * ledger row uses the existing schema (`ok`, provider and model NULL, no
 * tokens, no cost).
 */
import { z } from "zod";

import {
  DETERMINISTIC_ROUTE_KEY,
  type AiDeterministicFeatureDefinition,
  type AiFeatureDefinition,
  type AiRegisteredFeature,
} from "../../src/ai/gateway/ai-feature";
import { FailClosedAiBudget } from "../../src/ai/gateway/ai-gateway.defaults";
import { resolveRoute } from "../../src/ai/gateway/ai-gateway.routing";
import { AiGateway } from "../../src/ai/gateway/ai-gateway.service";
import type { EvidencePack } from "../../src/ai/ports/model-provider.port";
import {
  DEFAULT_PACK,
  EXPLAIN_OUTPUT_SCHEMA,
  FAKE_ROUTE,
  FEATURE_ID,
  STORE_A,
  STORE_B,
  TENANT_ID,
  TEST_FEATURE,
  buildHarness,
  scope,
  sessionCtx,
  type HarnessOptions,
} from "./_support/gateway-harness";

const MODEL_FEATURE = TEST_FEATURE as AiFeatureDefinition;
const RESERVATION = "0191a000-0000-7000-8000-0000000000c1";
const TIER0_FEATURE_ID = "ai.tier0_probe";

type Executor = AiDeterministicFeatureDefinition["execute"];

/** A Tier-0 feature whose executor counts its invocations (plain closure, restoreMocks-proof). */
function tier0(execute: Executor): { feature: AiDeterministicFeatureDefinition; invocations: () => number } {
  let count = 0;
  const feature: AiDeterministicFeatureDefinition = {
    tier: "deterministic_no_model",
    featureId: TIER0_FEATURE_ID,
    routeKey: DETERMINISTIC_ROUTE_KEY,
    promptTemplateId: "tier0.probe",
    promptTemplateVersion: "1",
    outputSchemaId: "tier0.probe.output@1",
    outputSchema: EXPLAIN_OUTPUT_SCHEMA,
    extractEvidenceRefs: (output) => (output as z.infer<typeof EXPLAIN_OUTPUT_SCHEMA>).evidenceRefs,
    execute: (pack, input) => {
      count += 1;
      return execute(pack, input);
    },
  };
  return { feature, invocations: () => count };
}

const echoRefs: Executor = (pack) => ({ summary: "deterministic", evidenceRefs: pack.items.map((i) => i.ref) });

function build(execute: Executor = echoRefs, options: HarnessOptions = {}) {
  const t = tier0(execute);
  const h = buildHarness({ features: [t.feature], routes: [], providers: [], ...options });
  return { h, ...t };
}

describe("AiGateway — Tier 0 deterministic route", () => {
  describe("a validated run", () => {
    it("never requests a provider, resolves no route allowlist entry, and returns the validated output", async () => {
      const { h, invocations } = build();
      const out = await h.gateway.run(TIER0_FEATURE_ID, scope({ params: { storeId: STORE_A } }));
      expect(out).toEqual({
        kind: "ok",
        output: { summary: "deterministic", evidenceRefs: ["sale:1", "sale:2"] },
        evidenceRefs: ["sale:1", "sale:2"],
        routeKey: DETERMINISTIC_ROUTE_KEY,
        usage: { inputTokens: 0, outputTokens: 0, reported: true },
      });
      expect(invocations()).toBe(1);
      expect(h.provider.calls).toHaveLength(0);
      expect(h.provider.behaviorConsultations).toBe(0);
      expect(h.providerMetrics).toEqual([]);
      expect(h.runMetrics).toEqual([{ feature: TIER0_FEATURE_ID, outcome: "ok" }]);
    });

    it("hands the executor the built pack and the caller's validated params, in that order", async () => {
      const seen: unknown[] = [];
      const { h } = build((pack: EvidencePack, input) => {
        seen.push(pack, input);
        return echoRefs(pack, input);
      });
      await h.gateway.run(TIER0_FEATURE_ID, scope({ params: { day: "2026-11-01" } }));
      expect(seen).toEqual([DEFAULT_PACK, { day: "2026-11-01" }]);
    });

    it("hands the executor a frozen copy of the pack, so it cannot widen the known refs", async () => {
      let received: EvidencePack | undefined;
      let receivedInput: Readonly<Record<string, unknown>> | undefined;
      const { h } = build((pack, input) => {
        received = pack;
        receivedInput = input;
        (pack.items as unknown as unknown[]).push({ ref: "sale:forged" });
        return { summary: "forged", evidenceRefs: ["sale:forged"] };
      });
      const params = { storeId: STORE_A };
      const out = await h.gateway.run(TIER0_FEATURE_ID, scope({ params }));
      // Asserted outside the executor, so a gateway catch cannot mask a failure.
      expect(received).toBeDefined();
      expect(Object.isFrozen(received)).toBe(true);
      expect(Object.isFrozen(received!.items)).toBe(true);
      expect(receivedInput).not.toBe(params);
      expect(Object.isFrozen(receivedInput)).toBe(true);
      expect(out.kind).toBe("fallback");
      expect(h.settlements.map((s) => s.outcome)).toEqual(["not_attempted"]);
      expect(DEFAULT_PACK.items.map((i) => i.ref)).toEqual(["sale:1", "sale:2"]);
    });

    it("commits exactly one request unit with the existing-schema ledger shape: ok, no provider, no model, no tokens", async () => {
      const { h } = build();
      await h.gateway.run(TIER0_FEATURE_ID, scope({ idempotencyKey: "rt1542-tier0-key-0001", correlationId: "corr-t0" }));
      expect(h.reserves).toHaveLength(1);
      expect(h.reserves[0]).toMatchObject({ featureId: TIER0_FEATURE_ID, units: 1, idempotencyKey: "rt1542-tier0-key-0001" });
      expect(h.settlements).toHaveLength(1);
      const settlement = h.settlements[0]!;
      expect(settlement).toMatchObject({ tenantId: TENANT_ID, reservationId: RESERVATION, outcome: "ok" });
      expect(settlement.telemetry).toEqual({
        requestId: "corr-t0",
        routeKey: "deterministic_no_model",
        promptTemplateId: "tier0.probe",
        promptTemplateVersion: "1",
        outputSchemaId: "tier0.probe.output@1",
        evidenceRefIds: ["sale:1", "sale:2"],
      });
      for (const absent of ["providerKey", "modelId", "providerRequestId", "inputTokens", "outputTokens", "cachedInputTokens", "tokenCountSource"]) {
        expect(settlement.telemetry).not.toHaveProperty(absent);
      }
    });

    it("never writes prompt, evidence field values or output text into the ledger metadata or the logs", async () => {
      const { h } = build((pack) => ({ summary: "SECRET-OUTPUT-TEXT", evidenceRefs: pack.items.map((i) => i.ref) }));
      await h.gateway.run(TIER0_FEATURE_ID, scope());
      const dump = JSON.stringify([h.settlements, h.logs]);
      expect(dump).not.toContain("SECRET-OUTPUT-TEXT");
      expect(dump).not.toContain("250");
      expect(h.logs.find((l) => l.obj["event"] === "ai.gateway.run")?.obj).toMatchObject({
        route: DETERMINISTIC_ROUTE_KEY,
        outcome: "ok",
        provider_requested: false,
      });
    });

    it("a replayed Idempotency-Key (not runnable) never runs the executor and never settles a second unit", async () => {
      const { h, invocations } = build(echoRefs, {
        reservation: { allowed: true, reservationId: RESERVATION, entitlementVersion: 1, runnable: false },
      });
      const out = await h.gateway.run(TIER0_FEATURE_ID, scope());
      expect(out).toMatchObject({ kind: "fallback", reason: "entitlement_unavailable", providerRequested: false });
      expect(invocations()).toBe(0);
      expect(h.settlements).toHaveLength(0);
      expect(h.provider.calls).toHaveLength(0);
    });

    it("still commits when the settle fails nothing in the result (the sweeper is the backstop)", async () => {
      const { h } = build(echoRefs, { settleFails: true });
      expect((await h.gateway.run(TIER0_FEATURE_ID, scope())).kind).toBe("ok");
    });
  });

  describe("a run that does not validate releases, never commits", () => {
    const cases: [string, Executor, string, string][] = [
      ["an output failing the strict schema", () => ({ nope: 1 }), "output_schema_invalid", "output_invalid"],
      ["an output with an extra field (strict schema)", () => ({ summary: "s", evidenceRefs: ["sale:1"], extra: 1 }), "output_schema_invalid", "output_invalid"],
      ["an output citing an evidence ref outside the pack", () => ({ summary: "s", evidenceRefs: ["sale:999"] }), "output_unknown_evidence_ref", "output_invalid"],
      [
        "an executor that throws",
        () => {
          throw new Error("executor bug");
        },
        "internal_error",
        "not_attempted",
      ],
    ];

    it.each(cases)("%s → %s, released as %s", async (_name, execute, reason, outcome) => {
      const { h, invocations } = build(execute);
      const out = await h.gateway.run(TIER0_FEATURE_ID, scope());
      expect(out).toEqual({ kind: "fallback", reason, providerRequested: false });
      expect(invocations()).toBe(1);
      expect(h.settlements).toHaveLength(1);
      expect(h.settlements[0]).toMatchObject({ reservationId: RESERVATION, outcome });
      expect(h.settlements.some((s) => s.outcome === "ok")).toBe(false);
      expect(h.provider.calls).toHaveLength(0);
    });

    it.each([
      ["an empty pack", { pack: { items: [] } }],
      ["a throwing evidence builder", { pack: () => Promise.reject(new Error("x")) }],
    ] as [string, HarnessOptions][])("%s → evidence_unavailable, executor never runs, released as not_attempted", async (_name, options) => {
      const { h, invocations } = build(echoRefs, options);
      const out = await h.gateway.run(TIER0_FEATURE_ID, scope());
      expect(out).toEqual({ kind: "fallback", reason: "evidence_unavailable", providerRequested: false });
      expect(invocations()).toBe(0);
      expect(h.settlements.map((s) => s.outcome)).toEqual(["not_attempted"]);
    });

    it("an executor that returns a non-object or nothing is output_schema_invalid", async () => {
      for (const value of [undefined, null, "text", 7]) {
        const { h } = build(() => value);
        expect(await h.gateway.run(TIER0_FEATURE_ID, scope())).toMatchObject({ kind: "fallback", reason: "output_schema_invalid" });
      }
    });

    it("an executor returning a promise is refused (the executor is a synchronous pure function)", async () => {
      const { h } = build(() => Promise.resolve({ summary: "s", evidenceRefs: ["sale:1"] }));
      expect(await h.gateway.run(TIER0_FEATURE_ID, scope())).toMatchObject({ kind: "fallback", reason: "output_schema_invalid" });
      expect(h.settlements.map((s) => s.outcome)).toEqual(["output_invalid"]);
    });

    it("an executor returning a REJECTED promise is refused and leaves no unhandled rejection", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        const { h } = build(() => Promise.reject(new Error("async executor failed")));
        expect(await h.gateway.run(TIER0_FEATURE_ID, scope())).toMatchObject({ kind: "fallback", reason: "output_schema_invalid" });
        expect(h.settlements.map((s) => s.outcome)).toEqual(["output_invalid"]);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });

  describe("deny paths: no executor call, no commit", () => {
    const denies: [string, string, HarnessOptions, ReturnType<typeof sessionCtx> | undefined][] = [
      ["the kill switch", "feature_disabled_system", { enabled: false }, undefined],
      ["an unauthorized principal", "not_authorized", {}, sessionCtx({ userId: null })],
      ["an entitlement deny", "not_entitled", { entitlement: { allowed: false, reason: "not_entitled" } }, undefined],
      ["a denying budget pre-check", "spend_cap_reached", { budget: { allowed: false, reason: "spend_cap_reached" } }, undefined],
      ["an exhausted quota (reservation refused)", "quota_exhausted", { reservation: { allowed: false, reason: "quota_exhausted" } }, undefined],
    ];

    it.each(denies)("%s → %s", async (_name, reason, options, ctx) => {
      const { h, invocations } = build(echoRefs, options);
      const out = await h.gateway.run(TIER0_FEATURE_ID, scope(ctx === undefined ? {} : { ctx }));
      expect(out).toEqual({ kind: "fallback", reason, providerRequested: false });
      expect(invocations()).toBe(0);
      expect(h.calls.evidence).toBe(0);
      expect(h.settlements).toHaveLength(0);
      expect(h.provider.calls).toHaveLength(0);
    });

    it("a denying budget blocks Tier 0 before the quota is reserved (the budget is still consulted)", async () => {
      const { h } = build(echoRefs, { budget: { allowed: false, reason: "spend_cap_reached" } });
      await h.gateway.run(TIER0_FEATURE_ID, scope());
      expect(h.calls.budget).toBe(1);
      expect(h.calls.reserve).toBe(0);
    });

    it("a run without an Idempotency-Key cannot reserve and fails closed", async () => {
      const { h, invocations } = build();
      const { idempotencyKey: _omitted, ...noKey } = scope();
      expect(await h.gateway.run(TIER0_FEATURE_ID, noKey)).toMatchObject({ kind: "fallback", reason: "entitlement_unavailable" });
      expect(invocations()).toBe(0);
    });
  });

  describe("budget: zero provider cost is declared by the gateway, never by the caller", () => {
    it("the budget pre-check of a Tier-0 run carries providerCost: zero; a model run carries no such field", async () => {
      const t = tier0(echoRefs);
      const h = buildHarness({ features: [t.feature, MODEL_FEATURE] });
      await h.gateway.run(TIER0_FEATURE_ID, scope());
      await h.gateway.run(FEATURE_ID, scope({ idempotencyKey: "rt1542-model-key-0001" }));
      expect(h.budgetInputs[0]).toMatchObject({ featureId: TIER0_FEATURE_ID, routeKey: DETERMINISTIC_ROUTE_KEY, providerCost: "zero" });
      expect(h.budgetInputs[1]).not.toHaveProperty("providerCost");
    });

    it("the module-default FailClosedAiBudget still denies a MODEL route but passes a zero-cost Tier-0 run", async () => {
      const t = tier0(echoRefs);
      const failClosed = new FailClosedAiBudget();
      const base = buildHarness({ features: [t.feature, MODEL_FEATURE] });
      // Rebuild the gateway around the real default budget, keeping the harness doubles.
      const gateway = new AiGateway({
        features: [t.feature, MODEL_FEATURE],
        entitlement: {
          check: () => Promise.resolve({ allowed: true }),
          reserve: () => Promise.resolve({ allowed: true, reservationId: RESERVATION, entitlementVersion: 1, runnable: true }),
          settle: (s) => {
            base.settlements.push(s);
            return Promise.resolve();
          },
          reservationTtlMs: 900_000,
        },
        budget: failClosed,
        evidence: { build: () => Promise.resolve(DEFAULT_PACK) },
        routes: [FAKE_ROUTE],
        providers: [base.provider],
        runtime: { isEnabled: () => true, isProduction: () => false },
        metrics: { recordRun: () => undefined, recordProviderCall: () => undefined },
      });

      expect(await gateway.run(FEATURE_ID, scope())).toEqual({ kind: "fallback", reason: "entitlement_unavailable", providerRequested: false });
      expect(base.provider.calls).toHaveLength(0);
      expect(base.settlements).toHaveLength(0);

      expect((await gateway.run(TIER0_FEATURE_ID, scope())).kind).toBe("ok");
      expect(base.settlements.map((s) => s.outcome)).toEqual(["ok"]);
      expect(base.provider.calls).toHaveLength(0);
    });

    it("FailClosedAiBudget denies an input with no cost marker or a metered one", async () => {
      const budget = new FailClosedAiBudget();
      const input = { tenantId: "t", userId: "u", featureId: "f", storeIds: [], routeKey: "r" };
      await expect(budget.check(input)).resolves.toEqual({ allowed: false, reason: "entitlement_unavailable" });
      // Only the exact "zero" marker passes; a forged or unknown value is denied.
      await expect(budget.check({ ...input, providerCost: "metered" as never })).resolves.toEqual({ allowed: false, reason: "entitlement_unavailable" });
      await expect(budget.check({ ...input, providerCost: "zero" })).resolves.toEqual({ allowed: true });
    });
  });

  describe("preflight (RT-1539): a pure product decline after the kill switch and entitlement, before budget and reserve", () => {
    type Preflight = NonNullable<AiDeterministicFeatureDefinition["preflight"]>;

    function withPreflight(preflight: Preflight, options: HarnessOptions = {}) {
      const t = tier0(echoRefs);
      const feature: AiDeterministicFeatureDefinition = { ...t.feature, preflight };
      const h = buildHarness({ features: [feature], routes: [], providers: [], ...options });
      return { h, invocations: t.invocations };
    }

    function counted(result: ReturnType<Preflight>): { preflight: Preflight; calls: () => number } {
      let n = 0;
      return {
        preflight: () => {
          n += 1;
          return result;
        },
        calls: () => n,
      };
    }

    it("a decline returns a declined result with no budget call, no reservation, no evidence, no executor and no settlement", async () => {
      const p = counted({ code: "unsupported_question" });
      const { h, invocations } = withPreflight(p.preflight);
      const out = await h.gateway.run(TIER0_FEATURE_ID, scope());
      expect(out).toEqual({ kind: "declined", decline: { code: "unsupported_question" } });
      expect(p.calls()).toBe(1);
      expect(h.calls).toEqual({ entitlement: 1, budget: 0, evidence: 0, reserve: 0 });
      expect(invocations()).toBe(0);
      expect(h.settlements).toHaveLength(0);
      expect(h.provider.calls).toHaveLength(0);
      expect(h.runMetrics).toEqual([{ feature: TIER0_FEATURE_ID, outcome: "declined" }]);
    });

    it("a null result continues: the budget is consulted, one unit is reserved, and the run commits", async () => {
      const p = counted(null);
      const { h, invocations } = withPreflight(p.preflight);
      expect((await h.gateway.run(TIER0_FEATURE_ID, scope())).kind).toBe("ok");
      expect(p.calls()).toBe(1);
      expect(h.calls).toEqual({ entitlement: 1, budget: 1, evidence: 1, reserve: 1 });
      expect(invocations()).toBe(1);
      expect(h.settlements.map((s) => s.outcome)).toEqual(["ok"]);
    });

    it("a feature without a preflight runs exactly as before", async () => {
      const { h } = build();
      expect((await h.gateway.run(TIER0_FEATURE_ID, scope())).kind).toBe("ok");
    });

    it("a disabled system never reaches the preflight", async () => {
      const p = counted({ code: "unsupported_question" });
      const { h } = withPreflight(p.preflight, { enabled: false });
      expect(await h.gateway.run(TIER0_FEATURE_ID, scope())).toEqual({ kind: "fallback", reason: "feature_disabled_system", providerRequested: false });
      expect(p.calls()).toBe(0);
    });

    it("a denied entitlement never reaches the preflight", async () => {
      const p = counted({ code: "unsupported_question" });
      const { h } = withPreflight(p.preflight, { entitlement: { allowed: false, reason: "not_entitled" } });
      expect(await h.gateway.run(TIER0_FEATURE_ID, scope())).toEqual({ kind: "fallback", reason: "not_entitled", providerRequested: false });
      expect(p.calls()).toBe(0);
      expect(h.calls.budget).toBe(0);
    });

    it("an unauthorized or out-of-scope caller never reaches the preflight", async () => {
      const p = counted({ code: "unsupported_question" });
      const { h } = withPreflight(p.preflight);
      expect(await h.gateway.run(TIER0_FEATURE_ID, scope({ storeIds: [STORE_B], ctx: sessionCtx({ storeAccess: { kind: "specific", storeIds: [STORE_A] } }) }))).toMatchObject({
        kind: "fallback",
        reason: "store_out_of_scope",
      });
      expect(p.calls()).toBe(0);
    });

    it("a throwing preflight is a safe internal_error with nothing reserved", async () => {
      const { h } = withPreflight(() => {
        throw new Error("SECRET-QUESTION-TEXT");
      });
      const out = await h.gateway.run(TIER0_FEATURE_ID, scope());
      expect(out).toEqual({ kind: "fallback", reason: "internal_error", providerRequested: false });
      expect(h.calls).toMatchObject({ budget: 0, reserve: 0, evidence: 0 });
      expect(h.settlements).toHaveLength(0);
      expect(JSON.stringify(h.logs)).not.toContain("SECRET-QUESTION-TEXT");
    });

    it("a preflight returning a promise is internal_error, nothing reserved, and a rejection leaves no unhandled rejection", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        const { h } = withPreflight((() => Promise.reject(new Error("async preflight"))) as unknown as Preflight);
        expect(await h.gateway.run(TIER0_FEATURE_ID, scope())).toEqual({ kind: "fallback", reason: "internal_error", providerRequested: false });
        expect(h.calls).toMatchObject({ budget: 0, reserve: 0 });
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it.each([["undefined", undefined], ["a string", "decline"], ["an empty code", { code: "" }], ["a non-string code", { code: 7 }]])(
      "a malformed preflight result (%s) is internal_error with nothing reserved",
      async (_name, value) => {
        const { h } = withPreflight((() => value) as unknown as Preflight);
        expect(await h.gateway.run(TIER0_FEATURE_ID, scope())).toEqual({ kind: "fallback", reason: "internal_error", providerRequested: false });
        expect(h.calls).toMatchObject({ budget: 0, reserve: 0 });
      },
    );

    it("hands the preflight a frozen copy of the caller's params, never the original", async () => {
      let received: Readonly<Record<string, unknown>> | undefined;
      const params = { question: "q", storeIds: [STORE_A] };
      const { h } = withPreflight((input) => {
        received = input;
        return null;
      });
      await h.gateway.run(TIER0_FEATURE_ID, scope({ params }));
      expect(received).toEqual(params);
      expect(received).not.toBe(params);
      expect(Object.isFrozen(received)).toBe(true);
      expect(Object.isFrozen(received!["storeIds"])).toBe(true);
    });

    it("a model feature has no preflight: the field is not part of its definition", async () => {
      const h = buildHarness();
      expect((await h.gateway.run(FEATURE_ID, scope())).kind).toBe("ok");
    });
  });

  describe("route model: deterministic and model routes never cross", () => {
    it("a model feature cannot select the deterministic route key", () => {
      const sneaky = { ...MODEL_FEATURE, routeKey: DETERMINISTIC_ROUTE_KEY };
      expect(() => buildHarness({ features: [sneaky] })).toThrow(/deterministic_no_model/);
    });

    it("a model allowlist entry can never use the deterministic route key", () => {
      expect(() => buildHarness({ features: [], routes: [{ ...FAKE_ROUTE, routeKey: DETERMINISTIC_ROUTE_KEY }] })).toThrow(/reserved/);
    });

    it("a Tier-0 feature naming any other route key is refused at construction", () => {
      const { feature } = tier0(echoRefs);
      const wrong = { ...feature, routeKey: "sync_doctor.explain_sale@v1" } as unknown as AiRegisteredFeature;
      expect(() => buildHarness({ features: [wrong] })).toThrow(/deterministic_no_model/);
    });

    it("a Tier-0 feature with a non-strict output schema is refused at construction", () => {
      const { feature } = tier0(echoRefs);
      const loose = { ...feature, outputSchema: z.object({ summary: z.string(), evidenceRefs: z.array(z.string()) }) };
      expect(() => buildHarness({ features: [loose] })).toThrow(/strict/);
    });

    it("resolveRoute refuses the deterministic key for a model feature even if a route were allowlisted under it", () => {
      const reserved = { ...FAKE_ROUTE, routeKey: DETERMINISTIC_ROUTE_KEY };
      const feature = { ...MODEL_FEATURE, routeKey: DETERMINISTIC_ROUTE_KEY };
      const resolved = resolveRoute(feature, {
        routes: [reserved],
        providers: [buildHarness().provider],
        runtime: { isEnabled: () => true, isProduction: () => false },
      });
      expect(resolved).toEqual({ reason: "route_not_allowlisted" });
    });

    it("a Tier-0 feature runs with an empty allowlist and no provider, and beside a model feature that is unchanged", async () => {
      const t = tier0(echoRefs);
      const h = buildHarness({ features: [t.feature, MODEL_FEATURE] });
      expect((await h.gateway.run(TIER0_FEATURE_ID, scope())).kind).toBe("ok");
      expect(h.provider.calls).toHaveLength(0);
      const model = await h.gateway.run(FEATURE_ID, scope({ idempotencyKey: "rt1542-model-key-0002" }));
      expect(model).toMatchObject({ kind: "ok", routeKey: FAKE_ROUTE.routeKey });
      expect(h.provider.calls).toHaveLength(1);
    });

    it("an unknown feature id still fails closed", async () => {
      const { h } = build();
      expect(await h.gateway.run("ai.unknown", scope())).toMatchObject({ kind: "fallback", reason: "unknown_feature" });
    });

    it("a duplicate feature id across tiers is refused", () => {
      const { feature } = tier0(echoRefs);
      expect(() => buildHarness({ features: [feature, { ...feature }] })).toThrow(/Duplicate/);
    });
  });
});
