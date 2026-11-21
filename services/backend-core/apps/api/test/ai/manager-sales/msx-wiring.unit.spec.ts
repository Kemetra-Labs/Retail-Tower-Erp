/**
 * RT-1539 — the real AppModule graph (DB-less): the route is mounted behind the human-session guard,
 * the feature is registered with the AI Gateway, the evidence builder is the Manager Sales one, and
 * the safe defaults of `AiModule` are kept (kill switch OFF, empty route allowlist, disabled provider,
 * fail-closed budget). In production the route answers `not_entitled` until a gated migration grants the
 * feature: here, with no database, an enabled run fails closed as `entitlement_unavailable`, which also
 * proves the feature is registered (an unregistered id would be `unknown_feature`).
 */
import "reflect-metadata";

import request from "supertest";

import { AiGateway } from "../../../src/ai/gateway/ai-gateway.service";
import { AI_EVIDENCE_BUILDER, AI_FEATURES, AI_MODEL_PROVIDERS, AI_ROUTE_ALLOWLIST } from "../../../src/ai/ai.tokens";
import { DisabledModelProvider } from "../../../src/ai/adapters/disabled/disabled-model-provider";
import { ManagerSalesEvidenceBuilder } from "../../../src/ai/manager-sales/msx.evidence";
import { MSX_FEATURE_ID } from "../../../src/ai/manager-sales/msx.constants";
import { managerSalesFeature } from "../../../src/ai/manager-sales/msx.feature";
import { bootDbLessApp, type DbLessApp } from "../../_helpers/db-less-app";
import { SAME_ORIGIN } from "../../_helpers/same-origin";
import { ownerCtx, STORE_A1 } from "./__support__/msx-fixtures";

describe("Manager Sales wiring in the real app", () => {
  let booted: DbLessApp;
  const saved = process.env["AI_GATEWAY_ENABLED"];

  beforeAll(async () => {
    booted = await bootDbLessApp("msx-wiring");
  });

  afterAll(async () => {
    await booted.close();
    if (saved === undefined) delete process.env["AI_GATEWAY_ENABLED"];
    else process.env["AI_GATEWAY_ENABLED"] = saved;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env["AI_GATEWAY_ENABLED"];
    else process.env["AI_GATEWAY_ENABLED"] = saved;
  });

  it("registers the feature and the Manager Sales evidence builder, and keeps the safe defaults", () => {
    const get = <T>(token: symbol): T => booted.app.get<T>(token, { strict: false });
    expect(get<unknown[]>(AI_FEATURES)).toEqual([managerSalesFeature]);
    expect(get(AI_EVIDENCE_BUILDER)).toBeInstanceOf(ManagerSalesEvidenceBuilder);
    expect(get<unknown[]>(AI_ROUTE_ALLOWLIST)).toEqual([]);
    const providers = get<unknown[]>(AI_MODEL_PROVIDERS);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toBeInstanceOf(DisabledModelProvider);
  });

  it("the Gateway of the route is off by default: feature_disabled_system", async () => {
    delete process.env["AI_GATEWAY_ENABLED"];
    const gateway = booted.app.get(AiGateway, { strict: false });
    const result = await gateway.run(MSX_FEATURE_ID, { ctx: ownerCtx(), storeIds: [], correlationId: "c", idempotencyKey: "rt1539-wiring-key-0001", params: {} });
    expect(result).toEqual({ kind: "fallback", reason: "feature_disabled_system", providerRequested: false });
  });

  it("enabled, with no entitlement store, the registered feature fails closed: entitlement_unavailable (never unknown_feature)", async () => {
    process.env["AI_GATEWAY_ENABLED"] = "true";
    const gateway = booted.app.get(AiGateway, { strict: false });
    const result = await gateway.run(MSX_FEATURE_ID, { ctx: ownerCtx(), storeIds: [STORE_A1], correlationId: "c", idempotencyKey: "rt1539-wiring-key-0002", params: {} });
    expect(result).toMatchObject({ kind: "fallback", reason: "entitlement_unavailable", providerRequested: false });
  });

  it("mounts the POST route behind the session guard: no credential is 401 (and nothing is read)", async () => {
    const res = await request(booted.app.getHttpServer())
      .post("/api/v1/ai/manager-sales/explain")
      .set(SAME_ORIGIN)
      .set("Idempotency-Key", "rt1539-wiring-key-0003")
      .send({ templateId: "T-01", storeIds: [], from: "2026-11-08", to: "2026-11-14", locale: "en" });
    expect(res.status).toBe(401);
  });
});
