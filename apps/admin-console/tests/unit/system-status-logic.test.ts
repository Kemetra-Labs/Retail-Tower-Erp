import type { ConsoleSystemStatus } from "@/lib/system-status-queries";
import {
  STALE_AFTER_MS,
  ageMinutes,
  isStale,
  linkRoute,
  statusView,
  unknownView,
  worstOf,
} from "@/shell/systemStatusLogic";
import { describe, expect, test } from "vitest";

const AT = "2026-11-02T10:00:00.000Z";

function body(over: {
  server?: object;
  saleSync?: object;
  erpConnector?: object;
  overall?: string;
}): ConsoleSystemStatus {
  return {
    asOf: AT,
    overall: over.overall ?? "ok",
    components: {
      server: { state: "ok", reason: "answered", observedAt: AT, link: "none", ...over.server },
      saleSync: {
        state: "ok",
        reason: "keeping_up",
        observedAt: AT,
        link: "sale_sync_ops",
        facts: null,
        ...over.saleSync,
      },
      erpConnector: {
        state: "ok",
        reason: "heartbeat_fresh",
        observedAt: AT,
        link: "erp_connection",
        facts: null,
        ...over.erpConnector,
      },
    },
  } as ConsoleSystemStatus;
}

describe("RT-1071 reason → state mapping (D-1)", () => {
  const cases: [string, string, string][] = [
    ["saleSync", "keeping_up", "ok"],
    ["saleSync", "queue_behind", "degraded"],
    ["saleSync", "needs_repair", "degraded"],
    ["saleSync", "queue_stalled", "down"],
    ["saleSync", "check_timed_out", "unknown"],
    ["erpConnector", "heartbeat_fresh", "ok"],
    ["erpConnector", "erp_unreachable_reported", "degraded"],
    ["erpConnector", "some_instances_stale", "degraded"],
    ["erpConnector", "heartbeat_stale", "down"],
    ["erpConnector", "not_configured", "unknown"],
    ["erpConnector", "all_disabled", "unknown"],
    ["erpConnector", "never_seen", "unknown"],
    ["erpConnector", "check_timed_out", "unknown"],
  ];
  test.each(cases)("%s %s → %s", (id, reason, state) => {
    const view = statusView(
      body({ [id]: { state, reason }, overall: state === "ok" ? "ok" : state }),
    );
    const c = view.components.find((x) => x.id === id);
    expect(c?.state).toBe(state);
    expect(c?.reasonKey).toBe(`shell.status.reason.${reason}`);
  });

  test("the server is ok / answered with no link", () => {
    const c = statusView(body({})).components[0];
    expect(c).toMatchObject({ id: "server", state: "ok", route: null });
  });

  test("a reason that disagrees with its state is unknown, never ok", () => {
    const view = statusView(
      body({ saleSync: { state: "ok", reason: "queue_stalled" }, overall: "ok" }),
    );
    expect(view.components[1]).toMatchObject({ state: "unknown", reasonKey: null });
    expect(view.overall).toBe("unknown");
  });

  test("a reason that belongs to another component is unknown, never ok", () => {
    const sale = statusView(
      body({ saleSync: { state: "ok", reason: "heartbeat_fresh" }, overall: "ok" }),
    );
    expect(sale.components[1]).toMatchObject({ state: "unknown", reasonKey: null });
    const erp = statusView(body({ erpConnector: { state: "ok", reason: "keeping_up" } }));
    expect(erp.components[2].state).toBe("unknown");
    const server = statusView(body({ server: { state: "ok", reason: "keeping_up" } }));
    expect(server.components[0].state).toBe("unknown");
    expect(server.overall).toBe("unknown");
  });

  test("an unrecognised state is unknown", () => {
    const view = statusView(
      body({ erpConnector: { state: "healthy", reason: "heartbeat_fresh" } }),
    );
    expect(view.components[2].state).toBe("unknown");
    expect(view.overall).toBe("unknown");
  });

  test("a missing component is unknown", () => {
    const b = body({});
    (b.components as unknown as Record<string, unknown>).saleSync = undefined;
    expect(statusView(b).components[1].state).toBe("unknown");
  });
});

describe("RT-1071 overall (worst-of)", () => {
  test("order down > degraded > unknown > ok", () => {
    expect(worstOf(["ok", "unknown", "degraded", "down"])).toBe("down");
    expect(worstOf(["ok", "unknown", "degraded"])).toBe("degraded");
    expect(worstOf(["ok", "unknown"])).toBe("unknown");
    expect(worstOf(["ok", "ok"])).toBe("ok");
  });

  test("ok only when every component and the server's overall are ok", () => {
    expect(statusView(body({})).overall).toBe("ok");
    expect(statusView(body({ overall: "down" })).overall).toBe("down");
    const degraded = body({
      saleSync: { state: "degraded", reason: "queue_behind" },
      overall: "ok",
    });
    expect(statusView(degraded).overall).toBe("degraded");
  });
});

describe("RT-1071 destinations (D-5, UX-09)", () => {
  test("closed links map to existing routes; none and unknown map to nothing", () => {
    expect(linkRoute("sale_sync_ops")).toBe("/sales-needing-repair");
    expect(linkRoute("erp_connection")).toBe("/erp-connection");
    expect(linkRoute("none")).toBeNull();
    expect(linkRoute("https://elsewhere.example")).toBeNull();
    expect(linkRoute(undefined)).toBeNull();
  });
});

describe("RT-1071 failed read and freshness", () => {
  test("a failed read is every component unknown with no destination", () => {
    const v = unknownView();
    expect(v.overall).toBe("unknown");
    expect(v.components.map((c) => c.state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(v.components.every((c) => c.route === null && c.reasonKey === null)).toBe(true);
  });

  test("stale 10 minutes after receipt, by the local clock", () => {
    expect(isStale(0, STALE_AFTER_MS - 1)).toBe(false);
    expect(isStale(0, STALE_AFTER_MS)).toBe(true);
    expect(ageMinutes(0, 30_000)).toBe(1);
    expect(ageMinutes(0, 11 * 60_000 + 5_000)).toBe(11);
  });
});
