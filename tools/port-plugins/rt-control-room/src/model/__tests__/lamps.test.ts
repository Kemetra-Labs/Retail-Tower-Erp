import { describe, expect, it } from "vitest";
import raw from "./fixtures/snapshot-2026-11-13.json";
import { lampEvidence, stationLamps, type LampEvidence } from "../lamps";
import type { DatadogMonitor, Snapshot } from "../types";

const snapshot = raw as unknown as Snapshot;

const none: LampEvidence = {
  sentryProject: false,
  sentryIssues: 0,
  monitors: { ok: 0, alarming: 0, total: 0 },
  github: 0,
  jira: 0,
};

describe("stationLamps (hand-built evidence)", () => {
  it("POS Datadog is not needed, by design", () => {
    expect(stationLamps("pos", none).datadog).toEqual({ state: "na" });
  });

  it("Admin and Connector Datadog with no monitors read none, never sending", () => {
    expect(stationLamps("admin", none).datadog).toEqual({ state: "none" });
    expect(stationLamps("conn", none).datadog).toEqual({ state: "none" });
  });

  it("Core with 7 monitors all OK is sending 7/7", () => {
    const ev = { ...none, monitors: { ok: 7, alarming: 0, total: 7 } };
    expect(stationLamps("core", ev).datadog).toEqual({ state: "sending", checks: { ok: 7, total: 7 } });
  });

  it("one monitor in alert turns the lamp to alert with 6/7", () => {
    const ev = { ...none, monitors: { ok: 6, alarming: 1, total: 7 } };
    expect(stationLamps("core", ev).datadog).toEqual({ state: "alert", checks: { ok: 6, total: 7 } });
  });

  it("monitors with no OK evidence and no alarm are linked, not sending", () => {
    const ev = { ...none, monitors: { ok: 0, alarming: 0, total: 3 } };
    expect(stationLamps("core", ev).datadog).toEqual({ state: "linked", checks: { ok: 0, total: 3 } });
  });

  it("Sentry with a project and an issue is sending", () => {
    const ev = { ...none, sentryProject: true, sentryIssues: 1 };
    expect(stationLamps("admin", ev).sentry).toEqual({ state: "sending" });
  });

  it("Sentry with a project and no issue is linked, never sending", () => {
    expect(stationLamps("pos", { ...none, sentryProject: true }).sentry).toEqual({ state: "linked" });
  });

  it("Sentry with no project is none", () => {
    expect(stationLamps("pos", none).sentry).toEqual({ state: "none" });
  });

  it("GitHub and Jira are live with any linked entity, none otherwise", () => {
    const lamps = stationLamps("core", { ...none, github: 3, jira: 1 });
    expect(lamps.github).toEqual({ state: "live" });
    expect(lamps.jira).toEqual({ state: "live" });
    const empty = stationLamps("core", none);
    expect(empty.github).toEqual({ state: "none" });
    expect(empty.jira).toEqual({ state: "none" });
  });

  it("the ERPNext ledger has no lamps of its own: all not needed", () => {
    const lamps = stationLamps("erp", { ...none, github: 5, sentryProject: true });
    expect(Object.values(lamps).every((l) => l.state === "na")).toBe(true);
  });
});

describe("lampEvidence (from the 2026-11-13 snapshot)", () => {
  it("Core has 7 monitors, all OK, a Sentry project and no unresolved issue", () => {
    const ev = lampEvidence("core", snapshot);
    expect(ev.monitors).toEqual({ ok: 7, alarming: 0, total: 7 });
    expect(ev.sentryProject).toBe(true);
    expect(ev.sentryIssues).toBe(0);
    expect(ev.github).toBeGreaterThan(0);
    expect(ev.jira).toBeGreaterThan(0);
  });

  it("host monitors and monitors without a workload never count for a station", () => {
    for (const s of ["pos", "admin", "conn"] as const) {
      expect(lampEvidence(s, snapshot).monitors.total).toBe(0);
    }
  });

  it("the whole snapshot gives the expected lamp row per station", () => {
    expect(stationLamps("core", lampEvidence("core", snapshot))).toEqual({
      sentry: { state: "linked" },
      datadog: { state: "sending", checks: { ok: 7, total: 7 } },
      github: { state: "live" },
      jira: { state: "live" },
    });
    expect(stationLamps("admin", lampEvidence("admin", snapshot))).toEqual({
      sentry: { state: "sending" },
      datadog: { state: "none" },
      github: { state: "live" },
      jira: { state: "live" },
    });
    expect(stationLamps("conn", lampEvidence("conn", snapshot)).sentry).toEqual({ state: "sending" });
    expect(stationLamps("pos", lampEvidence("pos", snapshot))).toMatchObject({
      sentry: { state: "linked" },
      datadog: { state: "na" },
    });
  });

  it("a Core monitor in alert gives 6/7 and an alert lamp", () => {
    const monitors: DatadogMonitor[] = snapshot.monitors.map((m, i) =>
      i === 0 ? { ...m, properties: { ...m.properties, overallState: "Alert" } } : m,
    );
    const ev = lampEvidence("core", { ...snapshot, monitors });
    expect(stationLamps("core", ev).datadog).toEqual({ state: "alert", checks: { ok: 6, total: 7 } });
  });

  it("Warn and No Data monitors are alarming, not OK", () => {
    const monitors: DatadogMonitor[] = snapshot.monitors.map((m, i) =>
      i === 0
        ? { ...m, properties: { ...m.properties, overallState: "No Data" } }
        : i === 1
          ? { ...m, properties: { ...m.properties, overallState: "Warn" } }
          : m,
    );
    expect(lampEvidence("core", { ...snapshot, monitors }).monitors).toEqual({ ok: 5, alarming: 2, total: 7 });
  });

  it("a station whose workloads and entities are missing has no evidence", () => {
    const empty: Snapshot = {
      ...snapshot,
      services: [],
      workloads: [],
      sentryIssues: [],
      monitors: [],
      jira: [],
      prs: [],
      runs: [],
      deployments: [],
    };
    const ev = lampEvidence("core", empty);
    expect(ev).toEqual(none);
    expect(Object.values(stationLamps("core", ev)).map((l) => l.state)).toEqual(["none", "none", "none", "none"]);
  });
});
