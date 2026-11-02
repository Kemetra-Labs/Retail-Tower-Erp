/**
 * RT-1062 — unit tests for the console system-status rules
 * (`console-system-status.projections.ts`) and the check bound of
 * `ConsoleSystemStatusService` over a fake pool. No database.
 *
 * Every `saleSync` and `erpConnector` reason, its first-match precedence,
 * the worst-of `overall`, and that `unknown` is never `ok`.
 */
import type { Pool } from "pg";

import {
  type ComponentState,
  type ConnectorRegistrationFacts,
  erpConnectorComponent,
  saleSyncComponent,
  serverComponent,
  toConsoleSystemStatus,
  worstOf,
} from "../../src/console-system-status/console-system-status.projections";
import { ConsoleSystemStatusService } from "../../src/console-system-status/console-system-status.service";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const ago = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);
const reg = (over: Partial<ConnectorRegistrationFacts> = {}): ConnectorRegistrationFacts => ({
  disabledAt: null,
  lastSeenAt: ago(10),
  erpnextReachable: true,
  ...over,
});
const facts = (undeliveredCount: number, oldest: number | null, needsRepairCount = 0) => ({
  undeliveredCount,
  oldestUndeliveredAgeSeconds: oldest,
  needsRepairCount,
});

describe("RT-1062 server", () => {
  it("is always ok / answered / none at the read time", () => {
    expect(serverComponent(NOW)).toEqual({
      state: "ok",
      reason: "answered",
      observedAt: NOW.toISOString(),
      link: "none",
    });
  });
});

describe("RT-1062 saleSync (D-1, first match wins)", () => {
  it.each([
    ["an empty queue", facts(0, null), "ok", "keeping_up"],
    ["an event exactly 5 minutes old", facts(1, 300), "ok", "keeping_up"],
    ["an event older than 5 minutes", facts(1, 301), "degraded", "queue_behind"],
    ["an event exactly 30 minutes old", facts(3, 1800), "degraded", "queue_behind"],
    ["an event older than 30 minutes", facts(3, 1801), "down", "queue_stalled"],
    ["an open repair, a fresh queue", facts(1, 10, 2), "degraded", "needs_repair"],
    ["an open repair, an empty queue", facts(0, null, 1), "degraded", "needs_repair"],
    ["an open repair, a queue behind", facts(1, 600, 1), "degraded", "queue_behind"],
    ["an open repair, a stalled queue", facts(1, 3600, 1), "down", "queue_stalled"],
  ])("%s → %s / %s", (_label, f, state, reason) => {
    expect(saleSyncComponent(f, NOW)).toEqual({
      state,
      reason,
      observedAt: NOW.toISOString(),
      link: "sale_sync_ops",
      facts: f,
    });
  });

  it("facts not read in time → unknown / check_timed_out, no facts, no observedAt", () => {
    expect(saleSyncComponent(null, NOW)).toEqual({
      state: "unknown",
      reason: "check_timed_out",
      observedAt: null,
      link: "sale_sync_ops",
      facts: null,
    });
  });
});

describe("RT-1062 erpConnector (D-1, first match wins)", () => {
  it.each<[string, ConnectorRegistrationFacts[], ComponentState, string]>([
    ["no registration", [], "unknown", "not_configured"],
    ["every registration disabled", [reg({ disabledAt: ago(5) }), reg({ disabledAt: ago(5) })], "unknown", "all_disabled"],
    ["every enabled one never seen", [reg({ lastSeenAt: null }), reg({ disabledAt: ago(1) })], "unknown", "never_seen"],
    ["none healthy, one stale", [reg({ lastSeenAt: ago(301) }), reg({ lastSeenAt: null })], "down", "heartbeat_stale"],
    ["one healthy, one stale", [reg(), reg({ lastSeenAt: ago(900) })], "degraded", "some_instances_stale"],
    ["one healthy, one never seen", [reg(), reg({ lastSeenAt: null })], "degraded", "some_instances_stale"],
    [
      "a stale one reporting unreachable beside a healthy one",
      [reg(), reg({ lastSeenAt: ago(900), erpnextReachable: false })],
      "degraded",
      "some_instances_stale",
    ],
    ["all healthy, one reports unreachable", [reg(), reg({ erpnextReachable: false })], "degraded", "erp_unreachable_reported"],
    ["all healthy, reachability unreported", [reg({ erpnextReachable: null })], "ok", "heartbeat_fresh"],
    ["all healthy (5 minutes exactly)", [reg({ lastSeenAt: ago(300) })], "ok", "heartbeat_fresh"],
    [
      "all enabled healthy, a disabled one reporting unreachable",
      [reg(), reg({ disabledAt: ago(1), erpnextReachable: false })],
      "ok",
      "heartbeat_fresh",
    ],
  ])("%s → %s / %s", (_label, regs, state, reason) => {
    const c = erpConnectorComponent(regs, NOW);
    expect(c).toMatchObject({ state, reason, link: "erp_connection" });
    const f = c.facts!;
    expect(f.registeredCount).toBe(regs.length);
    expect(f.healthyCount + f.staleCount + f.neverSeenCount).toBe(f.enabledCount);
  });

  it("counts the facts and takes observedAt from the newest enabled lastSeenAt", () => {
    const c = erpConnectorComponent(
      [
        reg({ lastSeenAt: ago(30) }),
        reg({ lastSeenAt: ago(600), erpnextReachable: false }),
        reg({ lastSeenAt: null }),
        reg({ lastSeenAt: ago(1), disabledAt: ago(1) }),
      ],
      NOW,
    );
    expect(c.facts).toEqual({
      registeredCount: 4,
      enabledCount: 3,
      healthyCount: 1,
      staleCount: 1,
      neverSeenCount: 1,
      erpUnreachableReportedCount: 1,
    });
    expect(c.observedAt).toBe(ago(30).toISOString());
  });

  it("observedAt is null without an enabled heartbeat", () => {
    expect(erpConnectorComponent([reg({ lastSeenAt: null })], NOW).observedAt).toBeNull();
    expect(erpConnectorComponent([reg({ disabledAt: ago(1) })], NOW).observedAt).toBeNull();
  });

  it("facts not read in time → unknown / check_timed_out", () => {
    expect(erpConnectorComponent(null, NOW)).toEqual({
      state: "unknown",
      reason: "check_timed_out",
      observedAt: null,
      link: "erp_connection",
      facts: null,
    });
  });
});

describe("RT-1062 overall (worst of down > degraded > unknown > ok)", () => {
  const ALL: ComponentState[] = ["ok", "degraded", "down", "unknown"];

  it.each([
    [["ok", "ok", "ok"], "ok"],
    [["ok", "unknown", "ok"], "unknown"],
    [["ok", "unknown", "degraded"], "degraded"],
    [["down", "unknown", "degraded"], "down"],
    [["ok", "ok", "unknown"], "unknown"],
  ] as Array<[ComponentState[], ComponentState]>)("%j → %s", (states, expected) => {
    expect(worstOf(states)).toBe(expected);
  });

  it("is ok only when every component is ok, for every combination", () => {
    for (const a of ALL) for (const b of ALL) for (const c of ALL) {
      expect(worstOf([a, b, c]) === "ok").toBe(a === "ok" && b === "ok" && c === "ok");
      if ([a, b, c].includes("unknown")) expect(worstOf([a, b, c])).not.toBe("ok");
    }
  });

  it("the body: asOf, server, every component evaluated at the same time", () => {
    const body = toConsoleSystemStatus(NOW, null, []);
    expect(body.asOf).toBe(NOW.toISOString());
    expect(body.components.server.observedAt).toBe(body.asOf);
    expect(body.overall).toBe("unknown");
  });
});

describe("RT-1062 ConsoleSystemStatusService check bound (D-4)", () => {
  const TENANT = "0a000000-0000-7000-8000-000000000001";

  it("a pool that never yields a connection is check_timed_out for both checks, never a hang or a 500", async () => {
    const pool = { connect: () => new Promise(() => undefined) } as unknown as Pool;
    const service = new ConsoleSystemStatusService(pool, 50);
    const started = Date.now();
    const body = await service.read({ tenantId: TENANT });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(body.components.saleSync.reason).toBe("check_timed_out");
    expect(body.components.erpConnector.reason).toBe("check_timed_out");
    expect(body.overall).toBe("unknown");
  });

  it("a connection that arrives after the deadline runs no status query and is released", async () => {
    const statements: string[] = [];
    let released = 0;
    const client = {
      query: (sql: string) => {
        statements.push(sql);
        return Promise.resolve({ rows: [] });
      },
      release: () => {
        released += 1;
      },
    };
    const pool = {
      connect: () => new Promise((resolve) => setTimeout(() => resolve(client), 120)),
    } as unknown as Pool;
    const body = await new ConsoleSystemStatusService(pool, 30).read({ tenantId: TENANT });
    expect(body.components.saleSync.reason).toBe("check_timed_out");
    expect(body.components.erpConnector.reason).toBe("check_timed_out");
    await new Promise((r) => setTimeout(r, 200));
    expect(released).toBe(2);
    expect(statements.some((s) => /outbox_events|sale_sync_deadletters|connector_registration|statement_timeout/.test(s))).toBe(false);
  });

  /** A fake client: `onQuery` answers each statement after the tenant GUCs and the timeout. */
  function poolWith(onQuery: (sql: string) => Promise<{ rows: unknown[] }>): { pool: Pool; statements: string[] } {
    const statements: string[] = [];
    const client = {
      query: (sql: string, params?: unknown[]) => {
        statements.push(params ? `${sql} ${JSON.stringify(params)}` : sql);
        if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.includes("set_config")) return Promise.resolve({ rows: [] });
        return onQuery(sql);
      },
      release: () => undefined,
    };
    return { pool: { connect: () => Promise.resolve(client) } as unknown as Pool, statements };
  }

  it("a statement_timeout cancel (57014) is check_timed_out; the bound is set on the transaction", async () => {
    const { pool, statements } = poolWith(() => Promise.reject(Object.assign(new Error("canceled"), { code: "57014" })));
    const body = await new ConsoleSystemStatusService(pool, 1500).read({ tenantId: TENANT });
    expect(body.components.saleSync.reason).toBe("check_timed_out");
    expect(body.components.erpConnector.reason).toBe("check_timed_out");
    expect(statements.filter((s) => s.includes("statement_timeout") && s.includes('"1500ms"'))).toHaveLength(2);
    // Every check runs under the caller's tenant, never as a platform admin.
    expect(statements.filter((s) => s.includes("app.current_tenant") && s.includes(TENANT))).toHaveLength(2);
    expect(statements.filter((s) => s.includes("app.is_platform_admin") && s.includes('["false"]'))).toHaveLength(2);
  });

  it("any other error is not hidden as a timeout: the read rejects (500)", async () => {
    const { pool } = poolWith(() => Promise.reject(Object.assign(new Error("boom"), { code: "42P01" })));
    await expect(new ConsoleSystemStatusService(pool, 1000).read({ tenantId: TENANT })).rejects.toThrow("boom");
  });

  it("maps the rows to facts", async () => {
    const { pool } = poolWith((sql) => {
      if (sql.includes("outbox_events")) return Promise.resolve({ rows: [{ undelivered_count: 2, oldest_age_seconds: "400" }] });
      if (sql.includes("sale_sync_deadletters")) return Promise.resolve({ rows: [{ needs_repair_count: 1 }] });
      return Promise.resolve({
        rows: [{ disabled_at: null, last_seen_at: new Date(), erpnext_reachable: true }],
      });
    });
    const body = await new ConsoleSystemStatusService(pool, 1000).read({ tenantId: TENANT });
    expect(body.components.saleSync).toMatchObject({
      state: "degraded",
      reason: "queue_behind",
      facts: { undeliveredCount: 2, oldestUndeliveredAgeSeconds: 400, needsRepairCount: 1 },
    });
    expect(body.components.erpConnector).toMatchObject({ state: "ok", reason: "heartbeat_fresh" });
  });
});
