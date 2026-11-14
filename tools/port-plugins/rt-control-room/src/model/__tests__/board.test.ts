import { describe, expect, it } from "vitest";
import raw from "./fixtures/snapshot-2026-11-13.json";
import { buildBoard, type BoardOptions } from "../board";
import type { Board, Snapshot, StationId } from "../types";

// The fixture's own fetchedAt. Any later instant makes the sources stale (6 h).
const NOW = new Date("2026-11-13T12:30:00Z");
const ARABIC = /[؀-ۿ]/;

/** A fresh copy per test: the imported JSON module object is shared. */
const fixture = (): Snapshot => structuredClone(raw) as unknown as Snapshot;
/** The fixture without the three Connector issues on Backend-Core routes (the c3 alarms). */
const withoutPostingAlarms = (snap: Snapshot): Snapshot => ({
  ...snap,
  sentryIssues: snap.sentryIssues.filter((i) => !i.title.includes("/api/connector/v1/")),
});
const opts = (over: Partial<BoardOptions> = {}): BoardOptions => ({ now: NOW, demo: false, ...over });
const station = (b: Board, id: StationId) => b.stations.find((s) => s.id === id)!;
const lightTexts = (b: Board) => [
  b.verdict.lights.cashier.text,
  b.verdict.lights.backend.text,
  b.verdict.lights.accounts.text,
  b.verdict.sentence,
];

describe("buildBoard on the 2026-11-13 snapshot", () => {
  const board = buildBoard(fixture(), opts());

  it("finds the 5 alarms: 3 on the postings cable (Backend-Core routes), 1 inside the Connector, 1 inside Admin Console", () => {
    expect(board.alarms).toHaveLength(5);
    expect(board.alarms.filter((a) => a.at === "c3")).toHaveLength(3);
    expect(board.alarms.filter((a) => a.at === "c4")).toHaveLength(0);
    expect(board.alarms.filter((a) => a.at === "conn")).toHaveLength(1);
    expect(board.alarms.filter((a) => a.at === "admin")).toHaveLength(1);
    const reset = board.alarms.find((a) => a.title.includes("ConnectionResetError"));
    expect(reset?.at).toBe("conn");
    expect(board.alarms.some((a) => a.example)).toBe(false);
  });

  it("names Admin and Connector as unknown, because they have no health check", () => {
    expect(board.unknowns).toEqual([
      { station: "admin", reason: "no-health-check" },
      { station: "conn", reason: "no-health-check" },
    ]);
  });

  it("draws c3 (Postings) as a fault with 3 faults and the other cables live", () => {
    const c = Object.fromEntries(board.cables.map((x) => [x.id, x]));
    expect(c.c3).toMatchObject({ state: "fault", faults: 3, from: "core", to: "conn" });
    for (const id of ["c1", "c2", "c4"]) expect(c[id]).toMatchObject({ state: "live", faults: 0 });
    expect(c.c3.carries).toEqual({ en: "Postings", ar: "قيود" });
  });

  it("gives the three lights", () => {
    const { lights } = board.verdict;
    // The failing hop of the three c3 alarms is Backend-Core: they are Backend's, not the accounts side's.
    expect(lights.backend.tone).toBe("fault");
    expect(lights.backend.text.en).toBe("3 alarms open");
    expect(lights.accounts.tone).toBe("fault");
    expect(lights.accounts.text.en).toBe("1 alarm open");
    expect(lights.cashier.tone).toBe("neutral");
    expect(lights.cashier.text.en).toBe("No errors reported");
    expect(board.verdict.sentence.en).toContain("3 alarms");
    expect(board.verdict.sentence.en).not.toContain("4 ");
  });

  it("has Arabic for every verdict text", () => {
    for (const text of lightTexts(board)) expect(text.ar).toMatch(ARABIC);
  });

  it("reads the stations from Port", () => {
    expect(board.stations.map((s) => s.id)).toEqual(["pos", "admin", "core", "conn", "erp"]);
    expect(station(board, "pos").readings).toEqual({
      alarms: 0,
      checks: "na",
      ci7d: 92,
      tasks: 43,
      prs: 8,
      merged7d: 5,
      deploys: 0,
      ciFails7d: 4,
    });
    expect(station(board, "core").readings).toMatchObject({
      alarms: 0,
      checks: { ok: 7, total: 7 },
      ci7d: 98,
      tasks: 10,
      prs: 21,
      merged7d: 18,
      deploys: 2,
      ciFails7d: 1,
    });
    expect(station(board, "admin").readings).toMatchObject({ alarms: 1, checks: null, ci7d: 95, tasks: 21 });
    expect(station(board, "conn").readings).toMatchObject({ alarms: 4, checks: null, ci7d: 97, prs: 62 });
    expect(station(board, "erp").readings).toMatchObject({
      alarms: 0,
      checks: "na",
      ci7d: null,
      tasks: null,
      prs: null,
    });
  });

  it("keeps 13 completed days of merges per station and a 7-day activity figure", () => {
    for (const s of board.stations.filter((x) => x.id !== "erp")) expect(s.merged13d).toHaveLength(13);
    expect(station(board, "core").activity7d).toBe(50 + 18);
    expect(station(board, "erp").merged13d).toEqual([]);
    expect(station(board, "erp").activity7d).toBe(0);
  });

  it("carries the link lamps", () => {
    expect(station(board, "core").lamps.datadog).toEqual({ state: "sending", checks: { ok: 7, total: 7 } });
    expect(station(board, "pos").lamps.datadog).toEqual({ state: "na" });
    expect(station(board, "conn").lamps.sentry.state).toBe("sending");
  });

  it("marks every source fresh at the fixture's own time", () => {
    for (const id of ["sentry", "datadog", "github", "jira"] as const) {
      expect(board.sources[id].state).toBe("fresh");
      expect(board.sources[id].id).toBe(id);
    }
    expect(board.sources.github.lastSync).toBe("2026-11-13T12:25:00Z");
    expect(board.sources.sentry.lastChange).toBe("2026-11-12T18:29:00Z");
  });

  it("builds four traces over the 13 completed days, today excluded", () => {
    expect(board.telemetry.map((t) => t.key)).toEqual(["merged", "runs", "fails", "done"]);
    for (const t of board.telemetry) expect(t.series).toHaveLength(13);
    const by = Object.fromEntries(board.telemetry.map((t) => [t.key, t]));
    expect(by.merged.yesterday).toBe(6);
    expect(by.runs.yesterday).toBe(39);
    expect(by.fails.yesterday).toBe(2);
    expect(by.fails.band).toEqual([0, 2]);
    expect(by.done.series).toEqual([1, 4, 3, 1, 2, 1, 3, 1, 3, 4, 5, 3, 0]);
  });

  it("counts Jira by status, per station, and lists the three lab hosts only", () => {
    expect(board.jira).toEqual({ todo: 22, inProgress: 34, review: 26, done: 33 });
    expect(board.perStation).toEqual([
      { station: "pos", tasks: 43, prs: 8, runs: 50, failed: 4 },
      { station: "admin", tasks: 21, prs: 7, runs: 60, failed: 3 },
      { station: "core", tasks: 10, prs: 21, runs: 50, failed: 1 },
      { station: "conn", tasks: 8, prs: 62, runs: 65, failed: 2 },
    ]);
    expect(board.hosts).toEqual([
      { id: "lab-01", station: "core", up: true, checks: { ok: 8, total: 8 } },
      { id: "lab-02", station: "core", up: true, checks: { ok: 9, total: 9 } },
      { id: "lab-03", station: "erp", up: true, checks: { ok: 10, total: 10 } },
    ]);
  });

  it("shows the last 72 CI runs oldest first and a pass rate", () => {
    expect(board.ci.last72).toHaveLength(72);
    expect(board.ci.last72.filter((c) => c === "f")).toHaveLength(3);
    expect(board.ci.last72.filter((c) => c === "c")).toHaveLength(2);
    expect(board.ci.last72.filter((c) => c === "k")).toHaveLength(1);
    // 66 passed of 69 that passed or failed.
    expect(board.ci.passRate).toBe(95.7);
  });

  it("does not mutate the snapshot", () => {
    const snap = fixture();
    buildBoard(snap, opts({ demo: true }));
    expect(snap).toEqual(fixture());
  });
});

describe("buildBoard missing and degraded data", () => {
  it("removing Core's monitors makes the backend light unknown, never neutral", () => {
    const snap = withoutPostingAlarms(fixture());
    snap.monitors = snap.monitors.filter((m) => m.relations.service === null);
    const b = buildBoard(snap, opts());
    expect(b.verdict.lights.backend.tone).toBe("unknown");
    expect(station(b, "core").readings.checks).toBeNull();
    expect(b.unknowns.map((u) => u.station)).toEqual(["admin", "core", "conn"]);
  });

  it("a missing service entity still draws the station with no data and no crash", () => {
    const snap = fixture();
    snap.services = snap.services.filter((s) => s.identifier !== "pos");
    const b = buildBoard(snap, opts());
    expect(b.stations).toHaveLength(5);
    expect(station(b, "pos").readings).toEqual({
      alarms: 0,
      // POS has no Datadog by design: "not needed" stays true whatever Port returns.
      checks: "na",
      ci7d: null,
      tasks: null,
      prs: null,
      merged7d: null,
      deploys: null,
      ciFails7d: null,
    });
    expect(station(b, "pos").merged13d).toEqual([]);
    expect(b.perStation[0]).toEqual({ station: "pos", tasks: null, prs: null, runs: null, failed: null });
    expect(station(b, "core").readings.ci7d).toBe(98);
  });

  it("a service with no failed-run count reads no data for the pass rate, never 100%", () => {
    const snap = fixture();
    const core = snap.services.find((s) => s.identifier === "backend-core")!;
    delete core.properties.github_failed_workflow_runs_7d;
    const b = buildBoard(snap, opts());
    expect(station(b, "core").readings.ci7d).toBeNull();
    expect(station(b, "core").readings.ciFails7d).toBeNull();
    expect(station(b, "admin").readings.ci7d).toBe(95);
  });

  it("an entirely empty snapshot builds a board of unknowns", () => {
    const empty: Snapshot = {
      services: [],
      workloads: [],
      sentryIssues: [],
      monitors: [],
      hosts: [],
      jira: [],
      prs: [],
      runs: [],
      deployments: [],
      integrations: [],
      fetchedAt: "2026-11-13T12:30:00Z",
    };
    const b = buildBoard(empty, opts());
    expect(b.alarms).toEqual([]);
    expect(b.stations).toHaveLength(5);
    expect(b.verdict.lights.backend.tone).toBe("unknown");
    expect(b.verdict.lights.cashier.tone).toBe("unknown");
    expect(b.verdict.lights.accounts.tone).toBe("unknown");
    expect(Object.values(b.sources).every((s) => s.state === "unknown")).toBe(true);
    expect(b.ci).toEqual({ last72: [], passRate: null });
    expect(b.hosts.map((h) => h.up)).toEqual([null, null, null]);
  });

  it("a forbidden integration read falls back to the newest change only", () => {
    const snap = fixture();
    snap.integrations = "forbidden";
    const b = buildBoard(snap, opts());
    expect(b.sources.github.lastSync).toBeNull();
    expect(b.sources.github.state).toBe("fresh");
    // Newest Sentry change is 2026-11-12T18:29Z, 18 h before NOW.
    expect(b.sources.sentry).toMatchObject({ state: "stale", lastSync: null });
    expect(b.verdict.lights.cashier.tone).toBe("unknown");
  });

  it("a source with no entities and no sync is unknown", () => {
    const snap = fixture();
    snap.jira = [];
    snap.integrations = (snap.integrations as { integrationType: string }[]).filter(
      (i) => i.integrationType !== "jira",
    ) as Snapshot["integrations"];
    expect(buildBoard(snap, opts()).sources.jira.state).toBe("unknown");
  });

  it("takes the newest sync when a source has several integrations", () => {
    const snap = fixture();
    (snap.integrations as Exclude<Snapshot["integrations"], "forbidden">).push({
      installationId: "second-jira",
      integrationType: "jira",
      resyncState: { lastResyncEnd: "2026-11-13T12:00:00Z", status: "completed" },
    });
    expect(buildBoard(snap, opts()).sources.jira.lastSync).toBe("2026-11-13T12:00:00Z");
  });
});

describe("buildBoard example and unlocated alarms", () => {
  it("demo adds the example latency alarm flagged example", () => {
    const b = buildBoard(withoutPostingAlarms(fixture()), opts({ demo: true }));
    expect(b.alarms).toHaveLength(3);
    const example = b.alarms.filter((a) => a.example);
    expect(example).toHaveLength(1);
    expect(example[0]).toMatchObject({ kind: "latency", source: "Datadog", station: "core", at: "core" });
    expect(b.verdict.lights.backend.tone).toBe("fault");
    expect(b.verdict.lights.backend.text.en).toBe("Slow responses (example)");
    expect(station(b, "core").readings.alarms).toBe(1);
    expect(station(b, "core").lamps.datadog).toEqual({ state: "alert", checks: { ok: 6, total: 7 } });
    expect(b.cables.find((c) => c.id === "c3")?.faults).toBe(0);
  });

  it("an untagged host-pack monitor in Alert is counted, never pinned, and weakens the lights", () => {
    const snap = withoutPostingAlarms(fixture());
    const pack = snap.monitors.find((m) => m.identifier === "datadog-monitor-900101")!;
    pack.properties.overallState = "Alert";
    const b = buildBoard(snap, opts());
    expect(b.alarms).toHaveLength(3);
    const lost = b.alarms.find((a) => a.id === "datadog-monitor-900101")!;
    expect(lost).toMatchObject({ at: "unlocated", station: null });
    for (const s of b.stations) expect(s.readings.alarms).toBe(s.id === "admin" ? 1 : s.id === "conn" ? 1 : 0);
    expect(b.cables.find((c) => c.id === "c3")?.faults).toBe(0);
    expect(b.verdict.lights.backend.tone).toBe("unknown");
    expect(b.verdict.lights.backend.text.en).toBe("Not sure: 1 alarm not placed");
    expect(b.verdict.lights.accounts.tone).toBe("fault");
    expect(b.verdict.sentence.en).toContain("1 alarm could not be placed on the map.");
    expect(b.verdict.sentence.ar).toMatch(ARABIC);
  });
});

describe("buildBoard when the Sentry alarm read failed (criterion 7)", () => {
  const failed = { alarmRead: { sentry: false } };

  it("(a) with nothing in the cache every station reads not-read, never 0 or none reported", () => {
    const snap = fixture();
    snap.sentryIssues = [];
    const b = buildBoard(snap, opts(failed));
    for (const s of b.stations) expect(s.readings.alarms).toBe("not-read");
    expect(b.stations).toHaveLength(5);
    expect(b.verdict.lights.cashier.tone).toBe("unknown");
    expect(b.verdict.lights.accounts.tone).toBe("unknown");
    expect(b.verdict.lights.backend.tone).toBe("unknown");
    for (const text of lightTexts(b)) {
      expect(text.en).not.toMatch(/no errors|no faults/i);
      expect(text.ar).not.toContain("مفيش أخطاء");
      expect(text.ar).not.toContain("مفيش أعطال");
    }
    expect(b.verdict.sentence.en).toContain("The error tracker could not be read");
    // A cable has no not-read state: with nothing cached it carries 0 known faults.
    expect(b.cables.find((c) => c.id === "c3")?.faults).toBe(0);
  });

  it("(b) with the retained issues all 5 alarms stay and c3 still has 3 faults", () => {
    const b = buildBoard(fixture(), opts(failed));
    expect(b.alarms).toHaveLength(5);
    expect(b.cables.find((c) => c.id === "c3")).toMatchObject({ state: "fault", faults: 3 });
    for (const s of b.stations) expect(s.readings.alarms).toBe("not-read");
    expect(b.verdict.lights.accounts.tone).toBe("fault");
    expect(b.verdict.lights.cashier.tone).toBe("unknown");
    expect(b.verdict.lights.cashier.text.en).not.toMatch(/No errors reported/);
    expect(b.verdict.lights.backend.tone).toBe("fault");
    expect(b.verdict.sentence.en).toContain("3 alarms");
    expect(b.verdict.sentence.en).toContain("The error tracker could not be read");
  });

  it("(c) a successful read restores the numeric counts, and so does leaving the option out", () => {
    for (const o of [opts({ alarmRead: { sentry: true } }), opts()]) {
      const b = buildBoard(fixture(), o);
      expect(station(b, "conn").readings.alarms).toBe(4);
      expect(station(b, "pos").readings.alarms).toBe(0);
      expect(b.verdict.lights.cashier.text.en).toBe("No errors reported");
    }
  });
});

describe("Board.alarmRead", () => {
  it("exposes whether the Sentry read succeeded, so cables can say 'not read' instead of 'no faults'", () => {
    expect(buildBoard(fixture(), opts()).alarmRead).toEqual({ sentry: true });
    expect(buildBoard(fixture(), opts({ alarmRead: { sentry: true } })).alarmRead).toEqual({ sentry: true });
    const failed = buildBoard(fixture(), opts({ alarmRead: { sentry: false } }));
    expect(failed.alarmRead).toEqual({ sentry: false });
    // The retained issues still count: the failed read changes the label, not the fault count.
    expect(failed.cables.find((c) => c.id === "c3")?.faults).toBe(3);
  });
});
