import { describe, expect, it } from "vitest";
import { buildBoard } from "../../model/board";
import type { Snapshot } from "../../model/types";
import { fetchSnapshot } from "../fetchSnapshot";
import { emptySnapshot, mergeSnapshot } from "../merge";
import { NOW, fakeClient, fixture, httpError } from "./testkit";

const board = (snapshot: Snapshot, sentry = true) =>
  buildBoard(snapshot, { now: NOW, demo: false, alarmRead: { sentry } });
const alarmIds = (snapshot: Snapshot) => board(snapshot).alarms.map((a) => a.id).sort();

/** The fixture with two monitors in Alert, so there are Datadog alarms to clear. */
function withAlerts(): Snapshot {
  const snap = fixture();
  snap.monitors[0].properties.overallState = "Alert";
  snap.monitors[1].properties.overallState = "Alert";
  return snap;
}

describe("mergeSnapshot replace versus merge", () => {
  it("(1) a full poll with an issue missing removes its alarm", () => {
    const prev = fixture();
    const next = mergeSnapshot(prev, { sentryIssues: prev.sentryIssues.slice(1) }, ["sentryIssues"]);
    expect(next.sentryIssues).toHaveLength(4);
    expect(alarmIds(next)).not.toContain("sentry-10001");
    expect(alarmIds(next)).toHaveLength(4);
  });

  it("(2) a full poll with monitors: [] clears the monitor alarms", () => {
    const prev = withAlerts();
    expect(board(prev).alarms.filter((a) => a.source === "Datadog")).toHaveLength(2);
    const next = mergeSnapshot(prev, { monitors: [] }, ["monitors"]);
    expect(next.monitors).toEqual([]);
    expect(board(next).alarms.filter((a) => a.source === "Datadog")).toHaveLength(0);
  });

  it("(3) a delta poll with sentryIssues: [] removes nothing", () => {
    const prev = fixture();
    const next = mergeSnapshot(prev, { sentryIssues: [] }, []);
    expect(next.sentryIssues).toHaveLength(5);
    expect(alarmIds(next)).toHaveLength(5);
  });

  it("(4) a delta that updates one issue merges it by identifier and leaves the others", () => {
    const prev = fixture();
    const changed = { ...prev.sentryIssues[2], title: "HTTPError: 502 Bad Gateway for url: https://lab/api/other" };
    const next = mergeSnapshot(prev, { sentryIssues: [changed] }, []);
    expect(next.sentryIssues).toHaveLength(5);
    expect(next.sentryIssues[2].title).toBe(changed.title);
    expect(next.sentryIssues.filter((_, i) => i !== 2)).toEqual(prev.sentryIssues.filter((_, i) => i !== 2));
    expect(next.services).toBe(prev.services);
  });

  it("(5) a failed Sentry read keeps every issue while another collection still updates", async () => {
    const prev = withAlerts();
    const client = fakeClient({ sentryIssue: httpError(500), datadogMonitor: [] }, []);
    const res = await fetchSnapshot(client, null, true, { now: NOW });
    expect(res.failed).toEqual(["sentryIssues"]);
    expect(res.data.monitors).toEqual([]);
    expect("sentryIssues" in res.data).toBe(false);
    expect(res.errorStatus).toBe(500);

    const next = mergeSnapshot(prev, res.data, res.replace);
    expect(next.sentryIssues).toEqual(prev.sentryIssues);
    const b = board(next, false);
    expect(b.alarms.filter((a) => a.source === "Sentry")).toHaveLength(5);
    expect(b.alarms.filter((a) => a.source === "Datadog")).toHaveLength(0);
  });

  it("(5b) an incomplete page behaves like a failed read", async () => {
    const client = fakeClient({ sentryIssue: new Error("Port API paging did not advance") });
    const res = await fetchSnapshot(client, null, true, { now: NOW });
    expect(res.failed).toContain("sentryIssues");
    expect("sentryIssues" in res.data).toBe(false);
  });

  it("(6) a deleted service goes at the next poll; a deleted issue only at the next full poll", () => {
    const prev = fixture();
    const noPos = prev.services.filter((s) => s.identifier !== "pos");
    const afterDelta = mergeSnapshot(prev, { services: noPos, sentryIssues: prev.sentryIssues.slice(1) }, ["services"]);
    expect(afterDelta.services.some((s) => s.identifier === "pos")).toBe(false);
    expect(board(afterDelta).stations.find((s) => s.id === "pos")?.readings.tasks).toBeNull();
    expect(afterDelta.sentryIssues).toHaveLength(5);

    const afterFull = mergeSnapshot(afterDelta, { sentryIssues: prev.sentryIssues.slice(1) }, ["sentryIssues"]);
    expect(afterFull.sentryIssues).toHaveLength(4);
  });

  it("(2a) integrations turning forbidden replaces the previous list", () => {
    const prev = fixture();
    expect(Array.isArray(prev.integrations)).toBe(true);
    const next = mergeSnapshot(prev, { integrations: "forbidden" }, ["integrations"]);
    expect(next.integrations).toBe("forbidden");
    expect(board(next).sources.sentry.lastSync).toBeNull();
  });

  it("prunes windowed collections to 14 days and keeps entities without a date", () => {
    const prev = fixture();
    const old = { ...prev.prs[0], identifier: "pr-old", properties: { status: "merged", mergedAt: "2026-10-01T00:00:00Z" } };
    const next = mergeSnapshot(prev, { prs: [old], fetchedAt: NOW.toISOString() }, []);
    expect(next.prs.some((p) => p.identifier === "pr-old")).toBe(false);
    expect(next.prs.some((p) => p.properties.mergedAt === null)).toBe(true);
  });

  it("starts from an empty base that still builds a board", () => {
    const empty = emptySnapshot(NOW.toISOString());
    const b = board(empty, false);
    expect(b.alarms).toEqual([]);
    for (const s of b.stations) expect(s.readings.alarms).toBe("not-read");
  });
});

describe("fetchSnapshot", () => {
  it("stores a 403 on /v1/integration as forbidden, authoritatively", async () => {
    const res = await fetchSnapshot(fakeClient({}, httpError(403)), null, true, { now: NOW });
    expect(res.data.integrations).toBe("forbidden");
    expect(res.replace).toContain("integrations");
    expect(res.failed).toEqual([]);
  });

  it("reads the integration list from the wrapped response", async () => {
    const list = [{ installationId: "x", integrationType: "sentry" }];
    const res = await fetchSnapshot(fakeClient({}, { ok: true, integrations: list }), null, true, { now: NOW });
    expect(res.data.integrations).toEqual(list);
  });

  it("marks another integration failure as failed, not forbidden", async () => {
    const res = await fetchSnapshot(fakeClient({}, httpError(500)), null, true, { now: NOW });
    expect(res.failed).toEqual(["integrations"]);
    expect("integrations" in res.data).toBe(false);
  });

  it("replaces the alarm collections on a full fetch and merges them on a delta", async () => {
    const full = await fetchSnapshot(fakeClient({}), null, true, { now: NOW });
    expect(full.replace.sort()).toEqual(
      ["hosts", "integrations", "jira", "monitors", "prs", "sentryIssues", "services", "workloads"].sort(),
    );
    expect(full.delta).toEqual([]);

    const delta = await fetchSnapshot(fakeClient({}), "2026-11-13T12:00:00.000Z", false, { now: NOW });
    expect(delta.replace.sort()).toEqual(["hosts", "integrations", "services", "workloads"]);
    expect(delta.delta.sort()).toEqual(["deployments", "jira", "monitors", "prs", "runs", "sentryIssues"]);
  });

  it("gives a collection that was never read a full fetch, never a delta", async () => {
    const client = fakeClient({});
    const res = await fetchSnapshot(client, "2026-11-13T12:00:00.000Z", false, {
      now: NOW,
      neverRead: new Set(["sentryIssues", "prs"]),
    });
    expect(res.replace).toContain("sentryIssues");
    expect(res.delta).not.toContain("sentryIssues");
    expect(res.delta).not.toContain("prs");
    expect(res.delta).toContain("monitors");
    const sentry = client.searches.find((s) => s.blueprint === "sentryIssue")!;
    expect(sentry.query.rules).toHaveLength(1);
  });
});

describe("fetchSnapshot Jira client-side filtering", () => {
  const issue = (id: string, status: string, resolutionDate: string | null, service: unknown) => ({
    identifier: id,
    title: id,
    properties: { status, resolutionDate },
    relations: service === undefined ? {} : { service },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-11-13T00:00:00Z",
  });

  it("keeps service-linked open issues and recent Done ones; drops unlinked and old Done ones", async () => {
    const client = fakeClient({
      jiraIssue: [
        issue("OPEN-1", "In Progress", null, "pos"),
        issue("NOSVC-1", "In Progress", null, undefined),
        issue("DONE-NEW", "Done", "2026-11-10T00:00:00Z", "pos"),
        issue("DONE-OLD", "Done", "2026-10-01T00:00:00Z", "pos"),
      ],
    });
    const res = await fetchSnapshot(client, null, true, { now: NOW });
    expect((res.data.jira ?? []).map((j) => j.identifier)).toEqual(["OPEN-1", "DONE-NEW"]);
    expect(client.searches.find((s) => s.blueprint === "jiraIssue")!.query).toEqual({ combinator: "and", rules: [] });
    expect(res.replace).toContain("jira");
    expect(res.delta).not.toContain("jira");
  });

  it("a delta reads only issues updated since the last poll and merges them without removing", async () => {
    const since = "2026-11-13T12:00:00.000Z";
    const prev = fixture();
    const before = prev.jira.length;
    const client = fakeClient({ jiraIssue: [issue("NEW-1", "In Progress", null, "pos")] });
    const res = await fetchSnapshot(client, since, false, { now: NOW });
    expect(client.searches.find((s) => s.blueprint === "jiraIssue")!.query.rules).toEqual([
      { property: "$updatedAt", operator: "between", value: { from: since, to: NOW.toISOString() } },
    ]);
    expect(res.delta).toContain("jira");
    expect(res.replace).not.toContain("jira");
    expect(mergeSnapshot(prev, res.data, res.replace).jira).toHaveLength(before + 1);
  });

  it("a full poll replaces the Jira collection, and counts an open issue untouched for 60 days", async () => {
    const prev = fixture();
    const stale = issue("OLD-OPEN", "To Do", null, "pos");
    stale.updatedAt = "2026-09-14T00:00:00Z";
    const tasksOf = (snap: Snapshot) => board(snap).stations.find((s) => s.id === "pos")!.readings.tasks;
    const baseline = tasksOf({ ...prev, jira: [] });

    const res = await fetchSnapshot(fakeClient({ jiraIssue: [stale] }), "2026-11-13T12:00:00.000Z", true, { now: NOW });
    // Keep the fixture's services: the stand-in answers every other blueprint with [].
    const next = mergeSnapshot(prev, { jira: res.data.jira, fetchedAt: res.data.fetchedAt }, res.replace);
    expect(next.jira.map((j) => j.identifier)).toEqual(["OLD-OPEN"]); // replaced, not merged
    expect(tasksOf(next)).toBe((baseline ?? 0) + 1);
  });
});


describe("fetchSnapshot pull requests", () => {
  const pr = (id: string, status: string, mergedAt: string | null, service: unknown) => ({
    identifier: id,
    title: id,
    properties: { status, mergedAt },
    relations: service === undefined ? {} : { service },
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-11-13T00:00:00Z",
  });
  const posPrs = (snap: Snapshot) => board(snap).stations.find((s) => s.id === "pos")!.readings.prs;

  it("a full poll reads every PR (rules: []) and keeps service-linked open or recently merged ones", async () => {
    const client = fakeClient({
      githubPullRequest: [
        pr("OPEN-OLD", "open", null, "pos"),
        pr("OPEN-NOSVC", "open", null, undefined),
        pr("MERGED-NEW", "merged", "2026-11-10T00:00:00Z", "pos"),
        pr("MERGED-OLD", "merged", "2026-10-01T00:00:00Z", "pos"),
        pr("CLOSED", "closed", null, "pos"),
      ],
    });
    const res = await fetchSnapshot(client, null, true, { now: NOW });
    expect((res.data.prs ?? []).map((p) => p.identifier)).toEqual(["OPEN-OLD", "MERGED-NEW"]);
    expect(client.searches.find((s) => s.blueprint === "githubPullRequest")!.query).toEqual({ combinator: "and", rules: [] });
    expect(res.replace).toContain("prs");
    expect(res.delta).not.toContain("prs");
  });

  it("counts an open PR older than 14 days in the station reading after a full poll", async () => {
    const prev = { ...fixture(), prs: [] };
    const res = await fetchSnapshot(
      fakeClient({ githubPullRequest: [pr("OPEN-OLD", "open", null, "pos")] }),
      "2026-11-13T12:00:00.000Z",
      true,
      { now: NOW },
    );
    const next = mergeSnapshot(prev, { prs: res.data.prs, fetchedAt: res.data.fetchedAt }, res.replace);
    expect(posPrs(next)).toBe(1);
  });

  it("a delta reads updated PRs only and merges them: a PR that closes leaves the open count", async () => {
    const since = "2026-11-13T12:00:00.000Z";
    const prev = { ...fixture(), prs: [pr("P1", "open", null, "pos"), pr("P2", "open", null, "pos")] } as unknown as Snapshot;
    expect(posPrs(prev)).toBe(2);
    const client = fakeClient({ githubPullRequest: [pr("P1", "closed", null, "pos")] });
    const res = await fetchSnapshot(client, since, false, { now: NOW });
    expect(client.searches.find((s) => s.blueprint === "githubPullRequest")!.query.rules).toEqual([
      { property: "$updatedAt", operator: "between", value: { from: since, to: NOW.toISOString() } },
    ]);
    expect(res.delta).toContain("prs");
    expect(res.replace).not.toContain("prs");
    // Keep the fixture's services: the stand-in answers every other blueprint with [].
    expect(posPrs(mergeSnapshot(prev, { prs: res.data.prs, fetchedAt: res.data.fetchedAt }, res.replace))).toBe(1);
  });
});
