import { describe, expect, it } from "vitest";
import type { PortClient, PortQuery, SearchOptions } from "../../api/portClient";
import { stationLamps, lampEvidence } from "../../model/lamps";
import { buildBoard } from "../../model/board";
import { MAX_BACKOFF_MS, POLL_MS } from "../blueprints";
import { createPollerState, runPoll } from "../poller";
import { delayAfter, nextPoll } from "../schedule";
import { BLUEPRINT_KEY, NOW, fixture, httpError } from "./testkit";

/** A client over the fixture that records every search, and fails a blueprint on demand (per poll). */
function client(failing: () => Partial<Record<string, number>> = () => ({})) {
  const snap = fixture();
  const calls: { blueprint: string; query: PortQuery; opts?: SearchOptions }[] = [];
  const c: PortClient = {
    async search<T>(blueprint: string, query: PortQuery, opts?: SearchOptions): Promise<T[]> {
      calls.push({ blueprint, query, opts });
      const status = failing()[blueprint];
      if (status) throw httpError(status);
      return snap[BLUEPRINT_KEY[blueprint as keyof typeof BLUEPRINT_KEY]] as unknown as T[];
    },
    async get<T>(): Promise<T> {
      const status = failing().integration;
      if (status) throw httpError(status);
      return snap.integrations as unknown as T;
    },
  };
  return { c, calls, snap };
}

/** Port answers nothing at all: every search and the integration read fail. */
const DOWN = { ...Object.fromEntries(Object.keys(BLUEPRINT_KEY).map((k) => [k, 503])), integration: 503 };
const at = (ms: number) => new Date(NOW.getTime() + ms);
const sinceOf = (q: PortQuery): string | undefined => {
  const r = q.rules.find((x) => "property" in x && x.property === "$updatedAt");
  return r && "value" in r ? (r.value as { from: string }).from : undefined;
};

describe("back-off after failures (RT-1408 C)", () => {
  it("doubles the wait per failed poll and stops at 5 minutes", () => {
    expect([0, 1, 2, 3, 4, 9].map(delayAfter)).toEqual([POLL_MS, 2 * POLL_MS, 4 * POLL_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect(nextPoll({ polls: 3, lastAt: 1_000, failures: 2 }, 5_000).at).toBe(1_000 + 4 * POLL_MS);
    expect(nextPoll({ polls: 3, lastAt: 1_000, failures: 0 }, 5_000).at).toBe(1_000 + POLL_MS);
  });

  it("a total outage raises the failure count, and a poll that reads something clears it", async () => {
    let down = true;
    const { c } = client(() => (down ? DOWN : {}));
    const state = createPollerState();
    await runPoll(c, state, at(0));
    await runPoll(c, state, at(120_000));
    expect(state.failures).toBe(2);
    expect(state.okPolls).toBe(0);
    down = false;
    await runPoll(c, state, at(360_000));
    expect(state.failures).toBe(0);
    expect(state.okPolls).toBe(1);
  });

  it("one core collection that keeps failing does not slow the alarms or make every poll full", async () => {
    const { c } = client(() => ({ datadogHost: 500 }));
    const state = createPollerState();
    for (let n = 0; n < 4; n += 1) await runPoll(c, state, at(n * POLL_MS));
    expect(state.failures).toBe(0);
    expect(state.okPolls).toBe(4);
    expect(nextPoll(state, 0).at).toBe(NOW.getTime() + 4 * POLL_MS);
    expect(nextPoll(state, 0).full).toBe(true); // number 5, the normal full poll, not a stuck "first" one
  });

  it("a 401 keeps the normal rhythm: the host re-sends the token, it is not an outage", async () => {
    const { c } = client(() => ({ ...DOWN, integration: 401, ...Object.fromEntries(Object.keys(BLUEPRINT_KEY).map((k) => [k, 401])) }));
    const state = createPollerState();
    await runPoll(c, state, at(0));
    expect(state.failures).toBe(0);
    expect(nextPoll(state, 0).at).toBe(NOW.getTime() + POLL_MS);
  });

  it("a failed Jira read alone (not core) does not back the board off", async () => {
    const { c } = client(() => ({ jiraIssue: 500 }));
    const state = createPollerState();
    await runPoll(c, state, at(0));
    expect(state.failures).toBe(0);
  });
});

describe("only good polls count for freshness and cadence (RT-1408 C)", () => {
  it("a poll where Port answers nothing does not advance the full-poll count, so it is retried as the same poll", async () => {
    const { c } = client();
    const state = createPollerState();
    for (let n = 0; n < 3; n += 1) await runPoll(c, state, at(n * POLL_MS));
    expect(state.okPolls).toBe(3);
    await runPoll(client(() => DOWN).c, state, at(3 * POLL_MS));
    expect(state.polls).toBe(4);
    expect(state.okPolls).toBe(3);
    expect(nextPoll(state, 0).full).toBe(false); // still number 4: a delta
    await runPoll(c, state, at(7 * POLL_MS));
    expect(nextPoll(state, 0).full).toBe(true); // number 5
  });
});

describe("a separate since per collection (RT-1408 C)", () => {
  it("a collection that failed is read again from its own last good read, the others from the previous poll", async () => {
    let failJira = false;
    const { c, calls } = client(() => (failJira ? { jiraIssue: 500 } : {}));
    const state = createPollerState();
    await runPoll(c, state, at(0)); // everything read at t0
    failJira = true;
    await runPoll(c, state, at(60_000)); // jira fails; the rest read at t1
    failJira = false;
    calls.length = 0;
    await runPoll(c, state, at(120_000));
    const since = (blueprint: string) => {
      const call = calls.find((x) => x.blueprint === blueprint);
      return call ? sinceOf(call.query) : undefined;
    };
    expect(since("jiraIssue")).toBe(at(0).toISOString());
    expect(since("githubPullRequest")).toBe(at(60_000).toISOString());
    expect(since("sentryIssue")).toBe(at(60_000).toISOString());
  });
});

describe("a 403 or 404 on a non-core blueprint reads not available (RT-1408 C)", () => {
  it("is neither a failure nor stale, and its readings stay at no data", async () => {
    const { c } = client(() => ({ jiraIssue: 403, githubWorkflowRun: 404 }));
    const res = await runPoll(c, createPollerState(), at(0));
    expect(res.unavailable.sort()).toEqual(["jira", "runs"]);
    expect(res.failed).toEqual([]);
    expect(res.unread).toEqual(expect.arrayContaining(["jira", "runs"]));
    const board = buildBoard(res.snapshot!, { now: at(0), demo: false, alarmRead: res.alarmRead, unread: res.unread });
    const core = board.stations.find((s) => s.id === "core")!;
    expect(core.readings.tasks).toBeNull();
  });

  it("a 403 on a core blueprint is still a failure, and a 500 on a non-core one too", async () => {
    const { c } = client(() => ({ datadogMonitor: 403, jiraIssue: 500 }));
    const res = await runPoll(c, createPollerState(), at(0));
    expect(res.failed.sort()).toEqual(["jira", "monitors"]);
    expect(res.unavailable).toEqual([]);
  });
});

describe("lamps reflect a failed read (RT-1408 C)", () => {
  it("a lamp whose collection failed just now reads not read, even when it had evidence", () => {
    const snap = fixture();
    const evidence = lampEvidence("core", snap);
    const healthy = stationLamps("core", evidence, new Set(), new Set());
    expect(healthy.datadog.unread).toBeUndefined();
    const failed = stationLamps("core", evidence, new Set(), new Set(["monitors"]));
    expect(failed.datadog.unread).toBe(true);
    expect(failed.datadog.state).toBe(healthy.datadog.state); // the last known state is kept, flagged
    expect(failed.sentry.unread).toBeUndefined(); // other sources are untouched
  });

  it("buildBoard passes the failed collections to the lamps; POS's na health lamp stays na", () => {
    const board = buildBoard(fixture(), { now: NOW, demo: false, failed: ["monitors", "jira"] });
    const core = board.stations.find((s) => s.id === "core")!;
    expect(core.lamps.datadog.unread).toBe(true);
    expect(core.lamps.jira.unread).toBe(true);
    expect(board.stations.find((s) => s.id === "pos")!.lamps.datadog).toEqual({ state: "na" });
  });
});

describe("old events leave memory (RT-1408 C)", () => {
  it("drops events older than the 24 h replay window as well as those past the cap", async () => {
    const { c } = client();
    const state = createPollerState();
    await runPoll(c, state, at(0));
    const old = { id: "old", at: at(-25 * 3_600_000).toISOString() } as never;
    const recent = { id: "recent", at: at(-3_600_000).toISOString() } as never;
    state.events = [recent, old];
    await runPoll(c, state, at(POLL_MS));
    expect(state.events.map((e) => e.id)).toContain("recent");
    expect(state.events.map((e) => e.id)).not.toContain("old");
  });
});

describe("no include narrowing (RT-1408 C)", () => {
  it("no read sends `include`: Port would then return only properties, without identifier or relations", async () => {
    const { c, calls } = client();
    await runPoll(c, createPollerState(), at(0));
    expect(calls.length).toBeGreaterThanOrEqual(9);
    for (const call of calls) expect(call.opts?.include).toBeUndefined();
  });
});

describe("a fresh alarm event is never pruned (RT-1408 C)", () => {
  it("a Sentry issue first seen 3 days ago that shows up now still produces its event", async () => {
    const { c, snap } = client();
    const state = createPollerState();
    await runPoll(c, state, at(0));
    const old = { ...snap.sentryIssues[0], identifier: "sentry-regressed", title: "ConnectionError: refused", createdAt: at(-3 * 86_400_000).toISOString() };
    snap.sentryIssues = [...snap.sentryIssues, old];
    await runPoll(c, state, at(POLL_MS));
    const event = state.events.find((e) => e.alarmId === "sentry-regressed");
    expect(event).toBeDefined();
    expect(event?.at).toBe(old.createdAt);
  });
});

describe("a collection that becomes unavailable stops looking read (RT-1408 C)", () => {
  it("read once, then 403: it is unread again, its cached entities are gone and its figures read no data", async () => {
    let deny = false;
    const { c } = client(() => (deny ? { githubWorkflowRun: 403 } : {}));
    const state = createPollerState();
    const first = await runPoll(c, state, at(0));
    expect(first.unread).not.toContain("runs");
    const before = buildBoard(first.snapshot!, { now: at(0), demo: false, unread: first.unread });
    expect(before.ci.last72.length).toBeGreaterThan(0);
    deny = true;
    const second = await runPoll(c, state, at(POLL_MS));
    expect(second.unavailable).toEqual(["runs"]);
    expect(second.unread).toContain("runs");
    expect(second.snapshot!.runs).toEqual([]);
    const after = buildBoard(second.snapshot!, { now: at(POLL_MS), demo: false, unread: second.unread });
    expect(after.ci.passRate).toBeNull();
  });
});
