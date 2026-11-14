import { describe, expect, it } from "vitest";
import { buildBoard } from "../../model/board";
import type { Board, Snapshot } from "../../model/types";
import { diffBoards } from "../diff";
import { diffSnapshots, replayEvents } from "../events";
import { NOW, fixture } from "./testkit";

const AT = "2026-11-13T12:31:00.000Z";
const board = (snapshot: Snapshot): Board => buildBoard(snapshot, { now: NOW, demo: false });

function withSentry(snap: Snapshot, id: string, title: string, workload: string | null): Snapshot {
  snap.sentryIssues.push({
    identifier: id,
    title,
    properties: { status: "unresolved", link: null },
    relations: { workload },
    createdAt: "2026-11-13T12:30:30Z",
    updatedAt: "2026-11-13T12:30:30Z",
  });
  return snap;
}

function withMonitor(snap: Snapshot, id: string, title: string, workload: string | null, tags: string[] = []): Snapshot {
  snap.monitors.push({
    identifier: id,
    title,
    properties: { overallState: "Alert", link: null, tags },
    relations: { service: workload },
    createdAt: "2026-10-20T08:00:00Z",
    updatedAt: "2026-11-13T12:30:30Z",
  });
  return snap;
}

describe("diffBoards", () => {
  const before = board(fixture());

  it("has nothing to compare with no previous board", () => {
    expect(diffBoards(null, before, { at: AT })).toEqual([]);
  });

  it("emits one alarm event for a new Sentry issue and none for known ones", () => {
    const next = board(withSentry(fixture(), "sentry-1", "TypeError: boom", "retail-tower-backend-api-staging"));
    const events = diffBoards(before, next, { at: AT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "alarm", station: "core", alarmId: "sentry-1", at: "2026-11-13T12:30:30Z" });
    expect(events[0].replay).toBeUndefined();
    expect(diffBoards(next, next, { at: AT })).toEqual([]);
  });

  it("emits a monitor event, never an alarm event, for a Datadog monitor entering Alert", () => {
    const next = board(withMonitor(fixture(), "m-1", "backend queue stuck", "retail-tower-backend-api-staging"));
    const events = diffBoards(before, next, { at: AT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "monitor", station: "core", alarmId: "m-1", at: AT });
  });

  it("keeps an unlocated monitor with station null and no host", () => {
    const next = board(withMonitor(fixture(), "m-2", "Disk usage is high on host {{host.name}}", null, ["env:lab"]));
    const [event] = diffBoards(before, next, { at: AT });
    expect(event).toMatchObject({ kind: "monitor", station: null, alarmId: "m-2" });
    expect(event.host).toBeUndefined();
  });

  it("puts a monitor that names a lab server on that host and its station", () => {
    const next = board(withMonitor(fixture(), "m-3", "lab-03 Redis instance down", null));
    const [event] = diffBoards(before, next, { at: AT });
    expect(event).toMatchObject({ station: "erp", host: "lab-03" });
  });

  it("treats a collection read for the first time as a baseline", () => {
    const next = board(withSentry(fixture(), "sentry-1", "TypeError: boom", "retail-tower-backend-api-staging"));
    expect(diffBoards(before, next, { at: AT, baseline: new Set(["sentryIssues"]) })).toEqual([]);
  });

  it("ignores the labelled example alarm", () => {
    const demo = buildBoard(fixture(), { now: NOW, demo: true });
    expect(diffBoards(before, demo, { at: AT })).toEqual([]);
  });
});

describe("diffSnapshots", () => {
  it("reports a merged PR, a concluded CI run, a Jira status change and a deployment", () => {
    const prev = fixture();
    const next = fixture();
    next.prs[0].properties.mergedAt = "2026-11-13T12:30:10Z";
    next.runs.push({
      ...next.runs[0],
      identifier: "run-new",
      title: "CI run new",
      properties: { conclusion: "failure", createdAt: "2026-11-13T12:30:20Z" },
    });
    const jira = next.jira[0];
    jira.properties.status = "Done";
    jira.updatedAt = "2026-11-13T12:30:40Z";
    next.deployments.push({ ...next.deployments[0], identifier: "deploy-new", createdAt: "2026-11-13T12:30:50Z" });

    const events = diffSnapshots(prev, next, { at: AT });
    expect(events.map((e) => e.kind).sort()).toEqual(["ci", "deploy", "jira", "merge"]);
    expect(events.find((e) => e.kind === "jira")?.text.en).toBe(`${jira.identifier} is now Done`);
    expect(events.find((e) => e.kind === "ci")?.text.en).toContain("failure");
    for (const e of events) expect(e.text.ar.length).toBeGreaterThan(0);
  });

  it("raises nothing for collections read for the first time", () => {
    const next = fixture();
    next.deployments.push({ ...next.deployments[0], identifier: "deploy-new", createdAt: "2026-11-13T12:30:50Z" });
    const events = diffSnapshots(fixture(), next, { baseline: new Set(["deployments"]) });
    expect(events).toEqual([]);
  });
});

describe("replayEvents", () => {
  it("covers only the last 24 h, newest first, all flagged replay", () => {
    const events = replayEvents(fixture(), NOW);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.replay === true)).toBe(true);
    const cutoff = NOW.getTime() - 86_400_000;
    expect(events.every((e) => Date.parse(e.at) > cutoff && Date.parse(e.at) <= NOW.getTime())).toBe(true);
    const times = events.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(["alarm", "merge", "ci", "jira", "deploy", "monitor"]));
  });

  it("is a reconstruction: a resolved Sentry issue is not there to replay", () => {
    const snap = fixture();
    snap.sentryIssues[0].properties.status = "resolved";
    const alarms = replayEvents(snap, NOW).filter((e) => e.kind === "alarm");
    expect(alarms).toHaveLength(4);
  });

  it("keeps an unlocated monitor with station null", () => {
    const snap = withMonitor(fixture(), "m-9", "Memory usage is high on host {{host.name}}", null, ["env:lab"]);
    snap.monitors[snap.monitors.length - 1].updatedAt = "2026-11-13T12:00:00Z";
    const event = replayEvents(snap, NOW).find((e) => e.alarmId === "m-9");
    expect(event).toMatchObject({ kind: "monitor", station: null });
  });
});
