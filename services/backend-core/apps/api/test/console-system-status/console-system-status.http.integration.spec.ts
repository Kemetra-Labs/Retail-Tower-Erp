/**
 * RT-1062 — the console system status over HTTP against real Postgres
 * (every migration, the NOBYPASSRLS `app_test` pool) and the real module
 * graph (`SessionOnlyAdminGuard`, `TenantContextGuard`, `RolesGuard`). Only
 * cookie authentication is faked (the RT-192 header pattern).
 *
 *   GET /api/v1/system-status  consoleGetSystemStatus
 *
 * What this proves (RT-1062 acceptance):
 *   - every `saleSync` and `erpConnector` reason over real rows, and the
 *     worst-of `overall`; `unknown` is never `ok`;
 *   - a check that does not answer in time is that component's `unknown` /
 *     `check_timed_out` (a held table lock), never a 500 and never `ok`;
 *   - the non-disclosing 404 for roles outside owner / tenant_admin, the 401
 *     for every bearer and for no session, and the 400 for any query key;
 *   - cross-tenant isolation: another tenant's queue and connectors never
 *     reach the body, for any caller;
 *   - every 200 and error body validates against the contract, with
 *     `Cache-Control: no-store`.
 *
 * Docker policy (`scoped-http-harness.ts`): HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { PoolClient } from "pg";
import type request from "supertest";

import { TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import { SES_ADMIN_SPEC, SES_OWNER_ALL } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  DASHBOARD_TOKEN,
  DEVICE_TOKEN,
  OPERATOR_TOKEN,
  SES_MANAGER,
  SES_PLATFORM,
  SES_STAFF,
} from "../console-sales/__support__/console-sales-fixture";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { ConsoleSystemStatusModule } from "../../src/console-system-status/console-system-status.module";
import {
  clearState,
  insertDeadletter,
  insertRegistration,
  insertSaleEvent,
  SES_C_OWNER,
  seedConsoleSystemStatusFixture,
  TENANT_C,
} from "./__support__/console-system-status-fixture";

const PATH = "/api/v1/system-status";

interface Status {
  asOf: string;
  overall: string;
  components: {
    server: { state: string; reason: string; observedAt: string; link: string };
    saleSync: {
      state: string;
      reason: string;
      observedAt: string | null;
      link: string;
      facts: { undeliveredCount: number; oldestUndeliveredAgeSeconds: number | null; needsRepairCount: number } | null;
    };
    erpConnector: {
      state: string;
      reason: string;
      observedAt: string | null;
      link: string;
      facts: {
        registeredCount: number;
        enabledCount: number;
        healthyCount: number;
        staleCount: number;
        neverSeenCount: number;
        erpUnreachableReportedCount: number;
      } | null;
    };
  };
}

const http = scopedHttpHarness({
  label: "RT-1062 system status",
  contractId: "console-system-status.openapi",
  module: ConsoleSystemStatusModule,
  seed: seedConsoleSystemStatusFixture,
});

const skip = (): boolean => http.skipped();
const admin = () => http.env().admin;
const get = (session: string | null, query: Record<string, string> = {}): request.Test =>
  http.get(PATH, session, query);

async function status(session: string = SES_OWNER_ALL): Promise<Status> {
  const res = await get(session);
  if (res.status !== 200) throw new Error(`system status ${res.status}: ${JSON.stringify(res.body)}`);
  expect(res.headers["cache-control"]).toBe("no-store");
  http.conforms("ConsoleSystemStatus", res.body);
  const body = res.body as Status;
  expect(body.overall === "ok").toBe(Object.values(body.components).every((c) => c.state === "ok"));
  return body;
}

async function expectError(res: request.Response, statusCode: number, code: string): Promise<void> {
  expect(res.status).toBe(statusCode);
  http.conforms("Error", res.body);
  expect(res.body.error.code).toBe(code);
}

afterEach(async () => {
  if (!skip()) await clearState(admin());
});

// ===========================================================================
// server and the empty tenant
// ===========================================================================

describe("RT-1062 system status — the empty tenant", () => {
  it("server is ok/answered at asOf; an empty queue keeps up; no registration is unknown, never ok", async () => {
    if (skip()) return;
    const before = Date.now();
    const s = await status();
    expect(Date.parse(s.asOf)).toBeGreaterThanOrEqual(before - 1000);
    expect(s.components.server).toEqual({ state: "ok", reason: "answered", observedAt: s.asOf, link: "none" });
    expect(s.components.saleSync).toEqual({
      state: "ok",
      reason: "keeping_up",
      observedAt: s.asOf,
      link: "sale_sync_ops",
      facts: { undeliveredCount: 0, oldestUndeliveredAgeSeconds: null, needsRepairCount: 0 },
    });
    expect(s.components.erpConnector).toEqual({
      state: "unknown",
      reason: "not_configured",
      observedAt: null,
      link: "erp_connection",
      facts: {
        registeredCount: 0,
        enabledCount: 0,
        healthyCount: 0,
        staleCount: 0,
        neverSeenCount: 0,
        erpUnreachableReportedCount: 0,
      },
    });
    expect(s.overall).toBe("unknown");
  });

  it("tenant_admin reads the same tenant status", async () => {
    if (skip()) return;
    const s = await status(SES_ADMIN_SPEC);
    expect(s.components.saleSync.reason).toBe("keeping_up");
  });
});

// ===========================================================================
// saleSync
// ===========================================================================

describe("RT-1062 system status — saleSync reasons (D-1)", () => {
  beforeEach(async () => {
    if (!skip()) await insertRegistration(admin(), { tenantId: TENANT_A, lastSeenSecondsAgo: 10 });
  });

  it("undelivered events no older than 5 minutes keep up; delivered and dead-lettered ones are not counted", async () => {
    if (skip()) return;
    await insertSaleEvent(admin(), { tenantId: TENANT_A, state: "pending", ageSeconds: 60 });
    await insertSaleEvent(admin(), { tenantId: TENANT_A, state: "claimed", ageSeconds: 120 });
    await insertSaleEvent(admin(), { tenantId: TENANT_A, state: "delivered", ageSeconds: 7200 });
    await insertSaleEvent(admin(), { tenantId: TENANT_A, state: "dead_lettered", ageSeconds: 7200 });
    await insertSaleEvent(admin(), {
      tenantId: TENANT_A,
      state: "pending",
      ageSeconds: 7200,
      eventType: "audit.event.created",
    });
    const s = await status();
    expect(s.components.saleSync).toMatchObject({ state: "ok", reason: "keeping_up" });
    expect(s.components.saleSync.facts!.undeliveredCount).toBe(2);
    expect(s.components.saleSync.facts!.oldestUndeliveredAgeSeconds).toBeGreaterThanOrEqual(120);
    expect(s.components.saleSync.facts!.oldestUndeliveredAgeSeconds).toBeLessThan(180);
    expect(s.overall).toBe("ok");
  });

  it("an undelivered event older than 5 minutes is degraded / queue_behind", async () => {
    if (skip()) return;
    await insertSaleEvent(admin(), { tenantId: TENANT_A, state: "failed", ageSeconds: 6 * 60 });
    const s = await status();
    expect(s.components.saleSync).toMatchObject({ state: "degraded", reason: "queue_behind" });
    expect(s.overall).toBe("degraded");
  });

  it("an undelivered event older than 30 minutes is down / queue_stalled", async () => {
    if (skip()) return;
    await insertSaleEvent(admin(), { tenantId: TENANT_A, state: "claimed", ageSeconds: 31 * 60 });
    await insertSaleEvent(admin(), { tenantId: TENANT_A, state: "pending", ageSeconds: 10 });
    const s = await status();
    expect(s.components.saleSync).toMatchObject({ state: "down", reason: "queue_stalled" });
    expect(s.components.saleSync.facts!.undeliveredCount).toBe(2);
    expect(s.overall).toBe("down");
  });

  it("an open NEEDS_REPAIR sale is degraded / needs_repair; resolved and retryable ones are not counted", async () => {
    if (skip()) return;
    await insertDeadletter(admin(), { tenant: "A", classification: "needs-repair" });
    const s = await status();
    expect(s.components.saleSync).toMatchObject({ state: "degraded", reason: "needs_repair" });
    expect(s.components.saleSync.facts!.needsRepairCount).toBe(1);
    await clearState(admin());
    await insertRegistration(admin(), { tenantId: TENANT_A, lastSeenSecondsAgo: 10 });
    await insertDeadletter(admin(), { tenant: "A", classification: "needs-repair", resolved: true });
    await insertDeadletter(admin(), { tenant: "A", classification: "retryable" });
    const t = await status();
    expect(t.components.saleSync).toMatchObject({ state: "ok", reason: "keeping_up" });
    expect(t.components.saleSync.facts!.needsRepairCount).toBe(0);
  });

  it("queue_behind wins over needs_repair", async () => {
    if (skip()) return;
    await insertDeadletter(admin(), { tenant: "A", classification: "needs-repair" });
    await insertSaleEvent(admin(), { tenantId: TENANT_A, state: "pending", ageSeconds: 10 * 60 });
    const s = await status();
    expect(s.components.saleSync).toMatchObject({ state: "degraded", reason: "queue_behind" });
    expect(s.components.saleSync.facts!.needsRepairCount).toBe(1);
  });
});

// ===========================================================================
// erpConnector
// ===========================================================================

describe("RT-1062 system status — erpConnector reasons (D-1)", () => {
  it.each([
    ["every enabled one healthy", [{ lastSeenSecondsAgo: 10, erpnextReachable: true }], "ok", "heartbeat_fresh"],
    [
      "all healthy, one self-reports ERPNext unreachable",
      [{ lastSeenSecondsAgo: 10, erpnextReachable: true }, { lastSeenSecondsAgo: 20, erpnextReachable: false }],
      "degraded",
      "erp_unreachable_reported",
    ],
    [
      "some but not all enabled ones healthy",
      [{ lastSeenSecondsAgo: 10 }, { lastSeenSecondsAgo: 600 }],
      "degraded",
      "some_instances_stale",
    ],
    [
      "a healthy one and a never-seen one",
      [{ lastSeenSecondsAgo: 10 }, { lastSeenSecondsAgo: null }],
      "degraded",
      "some_instances_stale",
    ],
    [
      "none healthy, one stale",
      [{ lastSeenSecondsAgo: 600 }, { lastSeenSecondsAgo: null }],
      "down",
      "heartbeat_stale",
    ],
    ["every enabled one never seen", [{ lastSeenSecondsAgo: null }, { lastSeenSecondsAgo: null }], "unknown", "never_seen"],
    [
      "every registration disabled",
      [{ lastSeenSecondsAgo: 10, disabled: true }],
      "unknown",
      "all_disabled",
    ],
  ])("%s → %s / %s", async (_label, regs, state, reason) => {
    if (skip()) return;
    for (const r of regs) await insertRegistration(admin(), { tenantId: TENANT_A, ...r });
    const s = await status();
    expect(s.components.erpConnector).toMatchObject({ state, reason, link: "erp_connection" });
    const f = s.components.erpConnector.facts!;
    expect(f.registeredCount).toBe(regs.length);
    expect(f.healthyCount + f.staleCount + f.neverSeenCount).toBe(f.enabledCount);
    if (state !== "ok") expect(s.overall).not.toBe("ok");
  });

  it("a disabled registration is ignored beside a healthy one; observedAt is the newest enabled lastSeenAt", async () => {
    if (skip()) return;
    await insertRegistration(admin(), { tenantId: TENANT_A, lastSeenSecondsAgo: 5, disabled: true });
    await insertRegistration(admin(), { tenantId: TENANT_A, lastSeenSecondsAgo: 30 });
    await insertRegistration(admin(), { tenantId: TENANT_A, lastSeenSecondsAgo: 60 });
    const s = await status();
    expect(s.components.erpConnector).toMatchObject({ state: "ok", reason: "heartbeat_fresh" });
    expect(s.components.erpConnector.facts).toEqual({
      registeredCount: 3,
      enabledCount: 2,
      healthyCount: 2,
      staleCount: 0,
      neverSeenCount: 0,
      erpUnreachableReportedCount: 0,
    });
    const newest = await admin().query<{ t: Date }>(
      `SELECT max(h.last_seen_at) AS t FROM connector_health h
         JOIN connector_registration r ON r.id = h.connector_registration_id
        WHERE r.tenant_id = $1 AND r.disabled_at IS NULL`,
      [TENANT_A],
    );
    expect(s.components.erpConnector.observedAt).toBe(newest.rows[0]!.t.toISOString());
  });
});

// ===========================================================================
// Check bound
// ===========================================================================

describe("RT-1062 system status — a check that does not answer in time (D-4)", () => {
  /** Hold an ACCESS EXCLUSIVE lock on `table` while `fn` runs. */
  async function withLock<T>(table: string, fn: () => Promise<T>): Promise<T> {
    const client: PoolClient = await admin().connect();
    try {
      await client.query("BEGIN");
      await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
      return await fn();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  it("a blocked queue check is saleSync unknown / check_timed_out, the other components still answer", async () => {
    if (skip()) return;
    await insertRegistration(admin(), { tenantId: TENANT_A, lastSeenSecondsAgo: 10 });
    const s = await withLock("outbox_events", () => status());
    expect(s.components.saleSync).toEqual({
      state: "unknown",
      reason: "check_timed_out",
      observedAt: null,
      link: "sale_sync_ops",
      facts: null,
    });
    expect(s.components.erpConnector).toMatchObject({ state: "ok", reason: "heartbeat_fresh" });
    expect(s.overall).toBe("unknown");
  }, 15_000);

  it("a blocked connector check is erpConnector unknown / check_timed_out, never ok", async () => {
    if (skip()) return;
    await insertRegistration(admin(), { tenantId: TENANT_A, lastSeenSecondsAgo: 10 });
    const s = await withLock("connector_registration", () => status());
    expect(s.components.erpConnector).toEqual({
      state: "unknown",
      reason: "check_timed_out",
      observedAt: null,
      link: "erp_connection",
      facts: null,
    });
    expect(s.components.saleSync).toMatchObject({ state: "ok", reason: "keeping_up" });
    expect(s.overall).toBe("unknown");
  }, 15_000);

  it("a timed-out check does not hide a down component in overall", async () => {
    if (skip()) return;
    await insertSaleEvent(admin(), { tenantId: TENANT_A, state: "pending", ageSeconds: 3600 });
    const s = await withLock("connector_registration", () => status());
    expect(s.components.erpConnector.reason).toBe("check_timed_out");
    expect(s.components.saleSync.state).toBe("down");
    expect(s.overall).toBe("down");
  }, 15_000);
});

// ===========================================================================
// Tenant isolation
// ===========================================================================

describe("RT-1062 system status — cross-tenant isolation (RLS)", () => {
  beforeEach(async () => {
    if (skip()) return;
    // Tenant B: a stalled queue, an open repair and a stale connector.
    await insertSaleEvent(admin(), { tenantId: TENANT_B, state: "pending", ageSeconds: 3600 });
    await insertDeadletter(admin(), { tenant: "B", classification: "needs-repair" });
    await insertRegistration(admin(), { tenantId: TENANT_B, lastSeenSecondsAgo: 3600 });
    // Tenant A: a healthy connector, a fresh queue.
    await insertRegistration(admin(), { tenantId: TENANT_A, lastSeenSecondsAgo: 10 });
    await insertSaleEvent(admin(), { tenantId: TENANT_A, state: "pending", ageSeconds: 10 });
  });

  it("tenant A never sees tenant B's queue or connector", async () => {
    if (skip()) return;
    const s = await status(SES_OWNER_ALL);
    expect(s.overall).toBe("ok");
    expect(s.components.saleSync.facts).toEqual({
      undeliveredCount: 1,
      oldestUndeliveredAgeSeconds: expect.any(Number),
      needsRepairCount: 0,
    });
    expect(s.components.saleSync.facts!.oldestUndeliveredAgeSeconds).toBeLessThan(60);
    expect(s.components.erpConnector.facts!.registeredCount).toBe(1);
  });

  it("tenant C, which has nothing, sees neither A nor B", async () => {
    if (skip()) return;
    const s = await status(SES_C_OWNER);
    expect(s.components.saleSync.facts).toEqual({
      undeliveredCount: 0,
      oldestUndeliveredAgeSeconds: null,
      needsRepairCount: 0,
    });
    expect(s.components.erpConnector).toMatchObject({ state: "unknown", reason: "not_configured" });
    expect(s.components.erpConnector.facts!.registeredCount).toBe(0);
    const rows = await admin().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM connector_registration WHERE tenant_id = $1`,
      [TENANT_C],
    );
    expect(rows.rows[0]!.n).toBe(0);
  });

  it("a platform admin reads its active tenant only, never platform-wide state", async () => {
    if (skip()) return;
    const s = await status(SES_PLATFORM);
    expect(s.components.saleSync.facts!.undeliveredCount).toBe(1);
    expect(s.components.saleSync.facts!.needsRepairCount).toBe(0);
    expect(s.components.erpConnector.facts!.registeredCount).toBe(1);
    expect(s.overall).toBe("ok");
  });

  it("the body holds no tenant id, host name or version", async () => {
    if (skip()) return;
    const text = JSON.stringify(await status(SES_OWNER_ALL));
    for (const leak of [TENANT_A, TENANT_B, TENANT_C, "example.test", "connector"]) {
      expect(text).not.toContain(leak);
    }
  });
});

// ===========================================================================
// Refusals
// ===========================================================================

describe("RT-1062 system status — refusals (D-3)", () => {
  it.each([
    ["store_manager", SES_MANAGER],
    ["store_staff", SES_STAFF],
  ])("%s is the non-disclosing 404, before the query is checked", async (_label, session) => {
    if (skip()) return;
    for (const query of [{}, { store_id: "x" }]) {
      const res = await get(session, query);
      await expectError(res, 404, "not_found");
      expect(res.body.error.message).toBe("Not Found");
    }
  });

  it.each([
    ["a dashboard_api token", DASHBOARD_TOKEN],
    ["a POS operator token", OPERATOR_TOKEN],
    ["a device token", DEVICE_TOKEN],
  ])("%s is 401", async (_label, token) => {
    if (skip()) return;
    const res = await get(null).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    http.conforms("Error", res.body);
  });

  it("no session is 401", async () => {
    if (skip()) return;
    const res = await get(null);
    expect(res.status).toBe(401);
    http.conforms("Error", res.body);
  });

  it.each([["store_id"], ["tenant_id"], ["refresh"]])("a %s query key is 400 validation_error", async (key) => {
    if (skip()) return;
    await expectError(await get(SES_OWNER_ALL, { [key]: "1" }), 400, "validation_error");
  });
});
