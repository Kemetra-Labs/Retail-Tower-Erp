/**
 * RT-563 — unit tests for the connector_health domain rollup (pure function).
 * RT-1404 — the structured `instances` counts ({ total, stale, neverSeen }).
 */
import { rollupConnectorHealth } from "../../../src/catalog/erpnext-sync-ops/connector-health-rollup";
import {
  DEFAULT_STALENESS_THRESHOLD_MS,
  deriveLiveness,
} from "../../../src/connector-health/connector-health.liveness";

describe("rollupConnectorHealth (RT-563)", () => {
  it("no instances -> not_available (never ok)", () => {
    expect(rollupConnectorHealth([])).toEqual({
      domain: "connector_health",
      status: "not_available",
      headlineCount: null,
      detail: "No connector instances registered",
    });
  });

  it("only disabled instances -> not_available", () => {
    const r = rollupConnectorHealth(["disabled", "disabled"]);
    expect(r.status).toBe("not_available");
    expect(r.headlineCount).toBeNull();
  });

  it("all never_seen -> attention, never ok", () => {
    const r = rollupConnectorHealth(["never_seen", "never_seen"]);
    expect(r.status).toBe("attention");
    expect(r.headlineCount).toBe(2);
    expect(r.detail).toBe("2 of 2 connector instance(s) not healthy (0 stale, 2 never seen)");
  });

  it("mixed healthy + stale -> attention with the unhealthy count", () => {
    const r = rollupConnectorHealth(["healthy", "stale", "healthy"]);
    expect(r.status).toBe("attention");
    expect(r.headlineCount).toBe(1);
    expect(r.detail).toBe("1 of 3 connector instance(s) not healthy (1 stale, 0 never seen)");
  });

  it("healthy + never_seen -> attention", () => {
    const r = rollupConnectorHealth(["healthy", "never_seen"]);
    expect(r.status).toBe("attention");
    expect(r.headlineCount).toBe(1);
  });

  it("all healthy -> ok", () => {
    const r = rollupConnectorHealth(["healthy", "healthy"]);
    expect(r).toEqual({
      domain: "connector_health",
      status: "ok",
      headlineCount: 0,
      detail: "All 2 active connector instance(s) healthy",
      instances: { total: 2, stale: 0, neverSeen: 0 },
    });
  });

  it("disabled instances are ignored when active ones exist", () => {
    expect(rollupConnectorHealth(["healthy", "disabled"]).status).toBe("ok");
    expect(rollupConnectorHealth(["stale", "disabled"]).status).toBe("attention");
  });
});

describe("rollupConnectorHealth — instances counts (RT-1404)", () => {
  it.each([
    ["no instances", [] as const],
    ["only disabled instances", ["disabled", "disabled"] as const],
  ])("%s -> not_available with no instances key", (_label, verdicts) => {
    const r = rollupConnectorHealth(verdicts);
    expect(r.status).toBe("not_available");
    expect(r).not.toHaveProperty("instances");
  });

  it.each([
    ["all healthy", ["healthy", "healthy"], { total: 2, stale: 0, neverSeen: 0 }],
    ["all never_seen", ["never_seen", "never_seen"], { total: 2, stale: 0, neverSeen: 2 }],
    ["healthy + stale", ["healthy", "stale", "healthy"], { total: 3, stale: 1, neverSeen: 0 }],
    [
      "healthy + stale + never_seen + disabled (disabled not counted)",
      ["healthy", "stale", "never_seen", "disabled", "stale"],
      { total: 4, stale: 2, neverSeen: 1 },
    ],
  ] as const)("%s -> %o", (_label, verdicts, expected) => {
    expect(rollupConnectorHealth(verdicts).instances).toEqual(expected);
  });

  it("instances agree with headlineCount (unhealthy = stale + neverSeen)", () => {
    const r = rollupConnectorHealth(["healthy", "stale", "never_seen", "never_seen"]);
    expect(r.headlineCount).toBe(r.instances!.stale + r.instances!.neverSeen);
  });

  it("an instance last seen exactly 5 minutes ago is healthy; 1 ms later it is stale", () => {
    const now = new Date("2026-11-23T10:00:00.000Z");
    const at = (msAgo: number): Date => new Date(now.getTime() - msAgo);
    const verdicts = [
      deriveLiveness(at(DEFAULT_STALENESS_THRESHOLD_MS), now, DEFAULT_STALENESS_THRESHOLD_MS, null),
      deriveLiveness(at(DEFAULT_STALENESS_THRESHOLD_MS + 1), now, DEFAULT_STALENESS_THRESHOLD_MS, null),
      deriveLiveness(null, now, DEFAULT_STALENESS_THRESHOLD_MS, null),
    ];
    expect(DEFAULT_STALENESS_THRESHOLD_MS).toBe(5 * 60 * 1000);
    expect(verdicts).toEqual(["healthy", "stale", "never_seen"]);
    expect(rollupConnectorHealth(verdicts).instances).toEqual({ total: 3, stale: 1, neverSeen: 1 });
  });
});
