import { describe, expect, it } from "vitest";
import raw from "./fixtures/snapshot-2026-11-13.json";
import { buildBoard } from "../board";
import type { Board, Collection, Snapshot } from "../types";

const NOW = new Date("2026-11-13T12:30:00Z");
const fixture = (): Snapshot => structuredClone(raw) as unknown as Snapshot;
const build = (snapshot: Snapshot, unread: Collection[]): Board => buildBoard(snapshot, { now: NOW, demo: false, unread });
const reading = (b: Board, key: keyof Board["stations"][number]["readings"]) => b.stations.map((s) => s.readings[key]);
const trace = (b: Board, key: string) => b.telemetry.find((t) => t.key === key)!;

/** The fixture with a collection emptied, as `emptySnapshot` leaves one that was never read. */
const without = (...keys: Collection[]): Snapshot => {
  const snap = fixture() as unknown as Record<string, unknown>;
  for (const key of keys) snap[key] = [];
  return snap as unknown as Snapshot;
};

/** Without the three c3 alarms, whose failing hop (Backend-Core) would make the backend light a fault. */
const noPostingAlarms = (snap: Snapshot): Snapshot => ({
  ...snap,
  sentryIssues: snap.sentryIssues.filter((i) => !i.title.includes("/api/connector/v1/")),
});

describe("a collection that was never read is 'no data', never 0", () => {
  it("control: nothing unread changes nothing", () => {
    const b = build(fixture(), []);
    expect(reading(b, "tasks").slice(0, 4).every((v) => typeof v === "number")).toBe(true);
    expect(b.jira.todo).toBeGreaterThan(0);
    expect(b.telemetry.every((t) => !t.unread)).toBe(true);
    expect(b.unknowns.map((u) => u.station)).toEqual(["admin", "conn"]);
  });

  it("jira unread: tasks, the per-status counts and the done trace read no data", () => {
    const b = build(without("jira"), ["jira"]);
    expect(reading(b, "tasks")).toEqual([null, null, null, null, null]);
    expect(b.jira).toEqual({ todo: null, inProgress: null, review: null, done: null });
    expect(trace(b, "done").unread).toBe(true);
    expect(b.perStation.every((r) => r.tasks === null)).toBe(true);
    // The other collections are untouched.
    expect(trace(b, "merged").unread).toBeFalsy();
  });

  it("jira read but empty is a real zero", () => {
    const b = build(without("jira"), []);
    expect(reading(b, "tasks").slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(b.jira).toEqual({ todo: 0, inProgress: 0, review: 0, done: 0 });
    expect(trace(b, "done").unread).toBeFalsy();
  });

  it("prs unread: open PRs, merged-7d, the merge sparkline and the merged trace read no data", () => {
    const b = build(without("prs"), ["prs"]);
    expect(reading(b, "prs")).toEqual([null, null, null, null, null]);
    expect(reading(b, "merged7d")).toEqual([null, null, null, null, null]);
    for (const s of b.stations) expect(s.merged13d).toEqual([]);
    expect(trace(b, "merged").unread).toBe(true);
  });

  it("runs unread: the CI strip, pass rate and both CI traces read no data", () => {
    const b = build(without("runs"), ["runs"]);
    expect(b.ci).toEqual({ last72: [], passRate: null });
    expect(trace(b, "runs").unread).toBe(true);
    expect(trace(b, "fails").unread).toBe(true);
    expect(trace(b, "merged").unread).toBeFalsy();
  });

  it("deployments unread: the deploy count reads no data", () => {
    const b = build(without("deployments"), ["deployments"]);
    expect(reading(b, "deploys")).toEqual([null, null, null, null, null]);
  });

  it("monitors unread: no station says 'no health check'; the Datadog lamp reads not read (amber), the checks no data", () => {
    const b = build(noPostingAlarms(without("monitors")), ["monitors"]);
    expect(b.unknowns).toEqual([]);
    for (const id of ["core", "admin", "conn"] as const) {
      const s = b.stations.find((x) => x.id === id)!;
      expect(s.lamps.datadog).toMatchObject({ state: "none", unread: true });
      expect(s.readings.checks).toBeNull();
    }
    // POS never needed one.
    expect(b.stations.find((x) => x.id === "pos")!.lamps.datadog).toEqual({ state: "na" });
    expect(b.healthChecks.find((g) => g.key === "core")!.unread).toBe(true);
    expect(b.hosts.every((h) => h.unread === true)).toBe(true);
    // The backend light is unknown and says the checks were not read, not that none exist.
    const backend = b.verdict.lights.backend;
    expect(backend.tone).toBe("unknown");
    expect(backend.text.en).toMatch(/not read/i);
    expect(backend.text.en).not.toMatch(/no health check/i);
    expect(backend.text.ar).not.toBe("");
  });

  it("monitors read but empty still says 'no health check' (control)", () => {
    const b = build(noPostingAlarms(without("monitors")), []);
    expect(b.unknowns.map((u) => u.station).sort()).toEqual(["admin", "conn", "core"]);
    expect(b.verdict.lights.backend.text.en).toMatch(/no health check/i);
    expect(b.stations.find((x) => x.id === "core")!.lamps.datadog.unread).toBeUndefined();
  });

  it("a lamp that has evidence stays as it is even when a related collection is unread", () => {
    const b = build(fixture(), ["prs"]);
    const pos = b.stations.find((x) => x.id === "pos")!;
    expect(pos.lamps.github.state).toBe("live"); // runs and deployments still link it
    expect(pos.lamps.github.unread).toBeUndefined();
  });

  it("jira unread: a station with no Jira evidence has an unread Jira lamp, not 'none'", () => {
    const b = build(without("jira"), ["jira"]);
    expect(b.stations.find((x) => x.id === "pos")!.lamps.jira).toMatchObject({ unread: true });
  });

  it("Sentry behaviour is unchanged: alarmRead false still reads not-read", () => {
    const b = buildBoard(fixture(), { now: NOW, demo: false, alarmRead: { sentry: false } });
    for (const s of b.stations) expect(s.readings.alarms).toBe("not-read");
  });
});
