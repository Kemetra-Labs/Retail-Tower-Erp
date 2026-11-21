/**
 * RT-1539 — the Manager Sales feature on the REAL entitlement port, the REAL sales reads and the REAL
 * ledger (Testcontainers Postgres, every migration, the NOBYPASSRLS `app_test` pool, only the RT-664
 * grants on the 0055 tables), through the real AiGateway and the real feature. The production plan
 * catalogue grants no AI feature, so this spec seeds its OWN catalogue (`ai_msx@1`: the feature
 * `ai.manager_sales.ask_explain` with exactly one request meter) and a `tenant_ai_entitlements`
 * revision, as the ai-entitlements db specs do.
 *
 * What it proves against the database:
 *   - an answer reads the caller's own sales, reserves ONE request unit, commits it once at zero
 *     provider cost (no provider, no tokens), and states the stored figures as the reads returned them;
 *   - a refusal (preflight) leaves no reservation and no ledger row, and the quota is untouched;
 *   - not entitled and quota exhausted deny before any read, charging nothing;
 *   - an evidence failure releases the reservation (the meter is unchanged, the ledger says
 *     `not_attempted`);
 *   - a store outside the caller's scope is refused by the Gateway with nothing reserved;
 *   - a retry with the same Idempotency-Key never runs twice and charges once.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (then the tests return early).
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { AiEntitlementChecker } from "../../../src/ai-entitlements/entitlement-checker";
import { AiEntitlementGrants } from "../../../src/ai-entitlements/entitlement-grants";
import { AiGatewayEntitlementPort } from "../../../src/ai-entitlements/gateway-entitlement.port";
import { FailClosedAiBudget } from "../../../src/ai/gateway/ai-gateway.defaults";
import { AiGateway } from "../../../src/ai/gateway/ai-gateway.service";
import type { AiGatewayResult } from "../../../src/ai/gateway/ai-gateway.types";
import { MSX_FEATURE_ID } from "../../../src/ai/manager-sales/msx.constants";
import { ManagerSalesEvidenceBuilder } from "../../../src/ai/manager-sales/msx.evidence";
import { managerSalesFeature } from "../../../src/ai/manager-sales/msx.feature";
import type { ManagerSalesAnswer } from "../../../src/ai/manager-sales/msx.output";
import { ConsoleSalesByStoreService } from "../../../src/console-sales/console-sales-by-store.service";
import { ConsoleSalesSummaryService } from "../../../src/console-sales/console-sales-summary.service";
import { MembershipRepository } from "../../../src/context/membership.repository";
import type { PgTestEnv } from "../../_helpers/postgres-container";
import {
  counter,
  ctxFor,
  key,
  ledgerKinds,
  newTenant,
  PLATFORM_ADMIN,
  startAiDb,
  stopAiDb,
  type AiTenant,
} from "../../ai-entitlements/__support__/ai-fixture";

const PLAN = "ai_msx";
const METER = "ask_requests";
const LIMIT = 3;
const ZERO_HASH = "0".repeat(64);
const RANGE = { from: "2026-10-01", to: "2026-10-07" };

let env: PgTestEnv | null = null;
let gateway: AiGateway;
let failing: AiGateway;
let grants: AiEntitlementGrants;

/** The test catalogue: one plan, one feature, exactly one request meter (the production `core@1` has none). */
async function seedManagerSalesCatalogue(admin: Pool): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO ai_plan_catalog (plan_code, catalog_version) VALUES ($1, 1)`, [PLAN]);
    await client.query(`INSERT INTO ai_plan_catalog_features (plan_code, catalog_version, feature_id) VALUES ($1, 1, $2)`, [PLAN, MSX_FEATURE_ID]);
    await client.query(
      `INSERT INTO ai_plan_catalog_meters (plan_code, catalog_version, feature_id, meter, unit, window_kind, meter_scope, limit_value)
       VALUES ($1, 1, $2, $3, 'request', 'month', 'tenant', $4)`,
      [PLAN, MSX_FEATURE_ID, METER, LIMIT],
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  env = await startAiDb("RT-1539 manager sales");
  if (env === null) return;
  await seedManagerSalesCatalogue(env.admin);
  const port = new AiGatewayEntitlementPort(new AiEntitlementChecker(env.app, { reservationTtlSeconds: 900 }));
  grants = new AiEntitlementGrants(env.app, new MembershipRepository(env.app));
  const memberships = new MembershipRepository(env.app);
  const summary = new ConsoleSalesSummaryService(env.app, memberships);
  const byStore = new ConsoleSalesByStoreService(env.app, memberships);
  const deps = {
    features: [managerSalesFeature],
    entitlement: port,
    budget: new FailClosedAiBudget(),
    routes: [],
    providers: [],
    runtime: { isEnabled: () => true, isProduction: () => false },
    metrics: { recordRun: () => undefined, recordProviderCall: () => undefined },
  } as const;
  gateway = new AiGateway({ ...deps, evidence: new ManagerSalesEvidenceBuilder(summary, byStore) });
  const broken = { summary: () => Promise.reject(new Error("read failed")) };
  failing = new AiGateway({ ...deps, evidence: new ManagerSalesEvidenceBuilder(broken as never, byStore) });
}, 240_000);

afterAll(async () => {
  await stopAiDb(env);
}, 60_000);

const skip = (): boolean => env === null;

async function entitled(t: AiTenant): Promise<void> {
  await grants.publishRevision({ actorUserId: PLATFORM_ADMIN, requestId: null }, t.tenantId, {
    expectedVersion: 0,
    state: "active",
    planCode: PLAN,
    catalogVersion: 1,
    reason: "RT-1539 manager sales spec",
  });
}

async function sale(t: AiTenant, storeId: string, total: string, businessDate: string): Promise<void> {
  const id = randomUUID();
  await env!.admin.query(
    `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', $4::numeric, ($5::date + time '10:00') AT TIME ZONE 'UTC', $5::date, 'rt1539-seed', $6, $7, $8)`,
    [id, t.tenantId, storeId, total, businessDate, `rt1539-${id}`, ZERO_HASH, t.ownerId],
  );
}

const run = (gw: AiGateway, t: AiTenant, params: Record<string, unknown>, options: { storeIds?: string[]; idempotencyKey?: string; ctx?: ReturnType<typeof ctxFor> } = {}) =>
  gw.run<ManagerSalesAnswer>(MSX_FEATURE_ID, {
    ctx: options.ctx ?? ctxFor(t),
    storeIds: options.storeIds ?? [],
    correlationId: "corr-rt1539",
    idempotencyKey: options.idempotencyKey ?? key(),
    params: { storeIds: options.storeIds ?? [], locale: "en", ...RANGE, ...params },
  });

const used = (t: AiTenant) => counter(env!.admin, t.tenantId, METER);

function okOutput(result: AiGatewayResult<ManagerSalesAnswer>): ManagerSalesAnswer {
  if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.output;
}

describe("an answer", () => {
  it("states the stored figures, reserves one unit and commits it once at zero provider cost", async () => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    await entitled(t);
    await sale(t, t.storeA, "100.0000", "2026-10-02");
    await sale(t, t.storeB, "50.5000", "2026-10-03");

    const result = await run(gateway, t, { templateId: "T-01" });
    const answer = okOutput(result);
    expect(result).toMatchObject({ kind: "ok", routeKey: "deterministic_no_model", usage: { inputTokens: 0, outputTokens: 0 } });
    expect(answer.templateId).toBe("T-01");
    const rows = answer.blocks.flatMap((b) => (b.type === "table" ? b.rows.map((r) => r.map((c) => c.value)) : []));
    expect(rows).toEqual([["150.5000", 2]]);
    expect(answer.sources[0]).toMatchObject({ operationId: "consoleGetSalesSummary", completeness: "received_only" });

    expect(await used(t)).toEqual({ used: 1, reserved: 0 });
    expect(await ledgerKinds(env!.admin, t.tenantId)).toEqual(["reserved", "committed"]);
    const ledger = await env!.admin.query(`SELECT outcome, route_key, provider_key, model_id FROM ai_usage_ledger WHERE tenant_id = $1 AND entry_kind = 'committed'`, [t.tenantId]);
    expect(ledger.rows).toEqual([{ outcome: "ok", route_key: "deterministic_no_model", provider_key: null, model_id: null }]);
  });

  it("a by-store template ranks the stored sales", async () => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    await entitled(t);
    await sale(t, t.storeA, "300.0000", "2026-10-02");
    await sale(t, t.storeB, "100.0000", "2026-10-02");
    const answer = okOutput(await run(gateway, t, { templateId: "T-04", currency: "EGP" }));
    const rows = answer.blocks.flatMap((b) => (b.type === "table" ? b.rows.map((r) => r.map((c) => c.value)) : []));
    expect(rows).toEqual([
      ["A", 1, "300.0000", 1, "0.7500"],
      ["B", 2, "100.0000", 1, "0.2500"],
    ]);
  });
});

describe("what is never charged", () => {
  it("a refusal: no reservation, no ledger row, the meter untouched", async () => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    await entitled(t);
    const result = await run(gateway, t, { question: "what is our profit margin" });
    expect(result).toEqual({ kind: "declined", decline: { code: "finance_source_absent" } });
    expect(await used(t)).toBeNull();
    expect(await ledgerKinds(env!.admin, t.tenantId)).toEqual([]);
  });

  it("not entitled: denied before any read or reservation", async () => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    expect(await run(gateway, t, { templateId: "T-01" })).toMatchObject({ kind: "fallback", reason: "not_entitled" });
    expect(await ledgerKinds(env!.admin, t.tenantId)).toEqual([]);
  });

  it("quota exhausted: the fourth answer of a three-request meter is denied", async () => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    await entitled(t);
    await sale(t, t.storeA, "10.0000", "2026-10-02");
    for (let i = 0; i < LIMIT; i += 1) expect((await run(gateway, t, { templateId: "T-01" })).kind).toBe("ok");
    expect(await run(gateway, t, { templateId: "T-01" })).toMatchObject({ kind: "fallback", reason: "quota_exhausted" });
    expect(await used(t)).toEqual({ used: LIMIT, reserved: 0 });
  });

  it("an evidence failure releases the reservation: the meter is unchanged and the ledger says not_attempted", async () => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    await entitled(t);
    expect(await run(failing, t, { templateId: "T-01" })).toMatchObject({ kind: "fallback", reason: "evidence_unavailable" });
    expect(await used(t)).toEqual({ used: 0, reserved: 0 });
    const released = await env!.admin.query(`SELECT outcome FROM ai_usage_ledger WHERE tenant_id = $1 AND entry_kind = 'released'`, [t.tenantId]);
    expect(released.rows).toEqual([{ outcome: "not_attempted" }]);
  });

  it("a store outside the caller's scope is refused by the Gateway: nothing reserved", async () => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    await entitled(t);
    const ctx = ctxFor(t, { storeAccess: { kind: "specific", storeIds: [t.storeA] } });
    expect(await run(gateway, t, { templateId: "T-01" }, { storeIds: [t.storeA, t.storeB], ctx })).toMatchObject({ kind: "fallback", reason: "store_out_of_scope" });
    expect(await ledgerKinds(env!.admin, t.tenantId)).toEqual([]);
  });
});

describe("idempotency", () => {
  it("a retry with the same key never runs twice and charges once", async () => {
    if (skip()) return;
    const t = await newTenant(env!.admin);
    await entitled(t);
    await sale(t, t.storeA, "10.0000", "2026-10-02");
    const k = key();
    const first = await run(gateway, t, { templateId: "T-01" }, { idempotencyKey: k });
    const retry = await run(gateway, t, { templateId: "T-01" }, { idempotencyKey: k });
    expect(first.kind).toBe("ok");
    expect(retry).toMatchObject({ kind: "fallback", reason: "entitlement_unavailable" });
    expect(await used(t)).toEqual({ used: 1, reserved: 0 });
  });
});
