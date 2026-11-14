import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortBridge } from "../../bridge/usePortBridge";
import type { SentryIssue, StationId } from "../../model/types";
import { BASE_URL, NOW, createFakePort, fixture, observers, type FakePort } from "./testkit";

const bridge = vi.hoisted(() => ({ value: undefined as unknown as PortBridge }));
vi.mock("../../bridge/usePortBridge", () => ({ usePortBridge: () => bridge.value }));
const tokenRequest = vi.hoisted(() => ({ requestPortToken: vi.fn() }));
vi.mock("../../bridge/requestToken", () => tokenRequest);

import { useBoard } from "../useBoard";

const READY: PortBridge = {
  token: "tok-secret",
  baseUrl: BASE_URL,
  applyThemeCss: () => {},
  trusted: true,
  status: "ready",
};
const WAITING: PortBridge = { ...READY, token: null, baseUrl: null, trusted: false, status: "waiting" };

const iso = (ms: number): string => new Date(ms).toISOString();
const DAYS_14 = 14 * 86_400_000;

let port: FakePort;

function mount() {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useBoard(), { wrapper });
}

/**
 * Let promises and queued timers (fetch stand-in, React Query and React
 * scheduling) run. Something is scheduled one millisecond out, so a zero-time
 * advance is not enough; the cost is 1 ms of fake time per settle.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
  }
}
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

const stationAlarms = (board: NonNullable<ReturnType<typeof useBoard>["board"]>) =>
  Object.fromEntries(board.stations.map((s) => [s.id, s.readings.alarms])) as Record<StationId, unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  bridge.value = READY;
  tokenRequest.requestPortToken.mockClear();
  port = createFakePort();
  port.install();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "hidden");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useBoard polling", () => {
  it("issues the window queries once on first load, with the exact bodies", async () => {
    const { result } = mount();
    await settle();

    expect(result.current.status).toBe("ready");
    expect(port.calls).toHaveLength(9);
    expect(port.gets).toEqual(["/v1/integration"]);
    const start = iso(port.calls[0].at);
    const from = iso(port.calls[0].at - DAYS_14);
    for (const call of port.calls) expect(Object.keys(call.body).sort()).toEqual(["limit", "query"]);

    const between = (property: string) => ({
      property,
      operator: "between",
      value: { from, to: start },
    });
    const only = (bp: Parameters<FakePort["callsFor"]>[0]) => {
      expect(port.callsFor(bp)).toHaveLength(1);
      return port.callsFor(bp)[0].query;
    };
    const all = (bp: string) => ({ combinator: "and", rules: [{ property: "$blueprint", operator: "=", value: bp }] });
    expect(only("service")).toEqual(all("service"));
    expect(only("workload")).toEqual(all("workload"));
    expect(only("datadogHost")).toEqual(all("datadogHost"));
    expect(only("sentryIssue")).toEqual({
      combinator: "and",
      rules: [{ property: "status", operator: "=", value: "unresolved" }],
    });
    expect(only("datadogMonitor")).toEqual(all("datadogMonitor"));
    expect(only("githubPullRequest")).toEqual({ combinator: "and", rules: [between("mergedAt")] });
    expect(only("githubWorkflowRun")).toEqual({ combinator: "and", rules: [between("createdAt")] });
    expect(only("deployment")).toEqual({ combinator: "and", rules: [between("createdAt")] });
    expect(only("jiraIssue")).toEqual({
      combinator: "and",
      rules: [
        { property: "service", operator: "isNotEmpty" },
        {
          combinator: "or",
          rules: [{ property: "status", operator: "notIn", value: ["Done"] }, between("resolutionDate")],
        },
      ],
    });
  });

  it("polls only deltas after 60 s and makes the 5th poll full", async () => {
    mount();
    await settle();
    const t0 = iso(port.calls[0].at);
    port.calls.length = 0;

    const hasDelta = (bp: Parameters<FakePort["callsFor"]>[0]) =>
      port.callsFor(bp)[0].query.rules.some((r) => "property" in r && r.property === "$updatedAt");

    await tick(60_000);
    expect(port.calls).toHaveLength(9);
    const t1 = iso(port.calls[0].at);
    const updated = { property: "$updatedAt", operator: "between", value: { from: t0, to: t1 } };
    for (const bp of ["sentryIssue", "datadogMonitor", "githubPullRequest", "githubWorkflowRun", "deployment", "jiraIssue"] as const) {
      expect(hasDelta(bp), bp).toBe(true);
    }
    expect(port.callsFor("sentryIssue")[0].query.rules).toContainEqual(updated);
    expect(port.callsFor("githubPullRequest")[0].query.rules).toContainEqual(updated);
    // The small blueprints are re-read in full every poll.
    for (const bp of ["service", "workload", "datadogHost"] as const) expect(hasDelta(bp), bp).toBe(false);

    const expected = { 3: true, 4: true, 5: false, 6: true } as const;
    for (const number of [3, 4, 5, 6] as const) {
      port.calls.length = 0;
      await tick(60_000);
      expect(port.callsFor("sentryIssue"), `poll ${number}`).toHaveLength(1);
      expect(hasDelta("sentryIssue"), `poll ${number} sentry`).toBe(expected[number]);
      expect(hasDelta("datadogMonitor"), `poll ${number} monitors`).toBe(expected[number]);
    }
  });

  it("stops polling while the document is hidden and resumes when visible", async () => {
    mount();
    await settle();
    setHidden(true);
    port.calls.length = 0;
    await tick(180_000);
    expect(port.calls).toHaveLength(0);
    setHidden(false);
    await settle();
    expect(port.calls).toHaveLength(9);
  });

  it("stops polling while the tile is off-screen and resumes when it is back", async () => {
    mount();
    await settle();
    expect(observers().length).toBeGreaterThan(0);
    act(() => observers().forEach((o) => o.fire(false)));
    port.calls.length = 0;
    await tick(180_000);
    expect(port.calls).toHaveLength(0);
    act(() => observers().forEach((o) => o.fire(true)));
    await settle();
    expect(port.calls).toHaveLength(9);
  });

  it("does not fetch until the token arrives, then fetches without changing hooks", async () => {
    bridge.value = WAITING;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, rerender } = mount();
    await settle();
    expect(result.current.status).toBe("loading");
    expect(port.fetchFn).not.toHaveBeenCalled();

    bridge.value = READY;
    expect(() => rerender()).not.toThrow();
    await settle();
    expect(result.current.status).toBe("ready");
    expect(port.fetchFn).toHaveBeenCalled();
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/hook/i);
    errors.mockRestore();
  });
});

describe("useBoard failures", () => {
  it("keeps the last board and turns stale when a poll fails", async () => {
    const { result } = mount();
    await settle();
    const before = result.current.board!;
    expect(before.alarms).toHaveLength(5);

    port.failAll(500);
    await tick(60_000);
    expect(result.current.status).toBe("stale");
    expect(result.current.error).toBe("Port could not be read (HTTP 500)");
    expect(result.current.board!.alarms).toHaveLength(5);
    expect(result.current.board!.stations.map((s) => s.readings.ci7d)).toEqual(before.stations.map((s) => s.readings.ci7d));

    port.healAll();
    await tick(60_000);
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
  });

  it("keeps the time of the last good sync while stale, then moves on when a poll is good again", async () => {
    const { result } = mount();
    await settle();
    expect(result.current.asOf).toBe(NOW.getTime());

    port.failAll(500);
    await tick(60_000);
    expect(result.current.status).toBe("stale");
    expect(result.current.asOf).toBe(NOW.getTime());

    port.healAll();
    await tick(60_000);
    expect(result.current.status).toBe("ready");
    expect(result.current.asOf).toBe(NOW.getTime() + 120_000);
  });

  it("has no sync time when no poll ever read everything", async () => {
    port.fail("sentryIssue", 500);
    const { result } = mount();
    await settle();
    expect(result.current.board).not.toBeNull();
    expect(result.current.status).toBe("stale");
    expect(result.current.asOf).toBeNull();
  });

  it("dates the lab update by the newest lab deployment's createdAt, not its resync time", async () => {
    const snap = fixture();
    const newest = snap.deployments.map((d) => d.createdAt).sort().reverse()[0];
    port.set("deployment", [
      ...snap.deployments,
      { ...snap.deployments[0], identifier: "elsewhere", properties: { environment: "prod" }, createdAt: "2026-11-13T12:29:00Z" },
    ]);
    const { result } = mount();
    await settle();
    expect(result.current.labUpdatedAt).toBe(newest);
    expect(result.current.labUpdatedAt).not.toBe("2026-11-13T11:00:00Z");
  });

  it("asks the host for a token exactly once on a 401 and keeps the last good board", async () => {
    const { result } = mount();
    await settle();
    port.failAll(401);
    await tick(60_000);
    expect(tokenRequest.requestPortToken).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("stale");
    expect(result.current.board!.alarms).toHaveLength(5);
    expect(result.current.error).toBe("Port could not be read (HTTP 401)");
    expect(result.current.error).not.toContain("tok-secret");
  });

  it("is an error, with no board, when nothing could be read at all", async () => {
    port.failAll(500);
    const { result } = mount();
    await settle();
    expect(result.current.board).toBeNull();
    expect(result.current.status).toBe("error");
  });
});

describe("useBoard Sentry read status (criterion 7)", () => {
  it("(a) a failed first Sentry read still builds the board, every station reads not-read", async () => {
    port.fail("sentryIssue", 500);
    const { result } = mount();
    await settle();
    const board = result.current.board!;
    expect(board).not.toBeNull();
    expect(result.current.status).toBe("stale");
    expect(result.current.failed).toEqual(["sentryIssues"]);
    expect(stationAlarms(board)).toEqual({
      pos: "not-read",
      admin: "not-read",
      core: "not-read",
      conn: "not-read",
      erp: "not-read",
    });
    expect(board.alarms).toHaveLength(0);
  });

  it("(a2) a later delta read after a failed first read is a full read and restores counts", async () => {
    port.fail("sentryIssue", 500);
    const { result } = mount();
    await settle();
    port.heal("sentryIssue");
    await tick(60_000);
    // The first read is a full one (never a delta over an empty cache): it carries no $updatedAt rule.
    const sentryCalls = port.callsFor("sentryIssue");
    const rules = sentryCalls[sentryCalls.length - 1].query.rules;
    expect(rules.some((r) => "property" in r && r.property === "$updatedAt")).toBe(false);
    expect(result.current.board!.alarms).toHaveLength(5);
    expect(stationAlarms(result.current.board!).conn).toBe(4);
  });

  it("(b) a failed Sentry poll keeps all 5 alarms, reads not-read and goes stale", async () => {
    const { result } = mount();
    await settle();
    expect(stationAlarms(result.current.board!)).toMatchObject({ conn: 4, admin: 1, core: 0, pos: 0 });

    port.fail("sentryIssue", 500);
    await tick(60_000);
    const board = result.current.board!;
    expect(result.current.status).toBe("stale");
    expect(board.alarms).toHaveLength(5);
    for (const value of Object.values(stationAlarms(board))) expect(value).toBe("not-read");
  });

  it("(c) the next successful poll restores numeric counts", async () => {
    const { result } = mount();
    await settle();
    port.fail("sentryIssue", 500);
    await tick(60_000);
    port.heal("sentryIssue");
    port.set("sentryIssue", []);
    await tick(60_000);
    const board = result.current.board!;
    expect(result.current.status).toBe("ready");
    expect(board.alarms).toHaveLength(5);
    expect(stationAlarms(board)).toEqual({ pos: 0, admin: 1, core: 0, conn: 4, erp: 0 });
  });
});

describe("useBoard events", () => {
  it("replays entities changed in the last 24 h once, in time order, and ends on onReplayDone", async () => {
    const { result } = mount();
    await settle();
    const { events, replayQueue } = result.current;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.replay === true)).toBe(true);
    const cutoff = NOW.getTime() - 86_400_000;
    expect(events.every((e) => Date.parse(e.at) > cutoff)).toBe(true);
    const times = events.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const queued = replayQueue.map((e) => Date.parse(e.at));
    expect(queued).toEqual([...queued].sort((a, b) => a - b));
    expect(events.filter((e) => e.kind === "alarm")).toHaveLength(5);

    expect(result.current.replaying).toBe(true);
    act(() => result.current.onReplayDone());
    expect(result.current.replaying).toBe(false);

    await tick(60_000);
    expect(result.current.replaying).toBe(false);
    expect(result.current.events.filter((e) => e.replay !== true)).toHaveLength(0);
  });

  it("does not replay when nothing changed in the last 24 h", async () => {
    vi.setSystemTime(new Date("2026-12-31T12:00:00Z"));
    const { result } = mount();
    await settle();
    expect(result.current.events).toEqual([]);
    expect(result.current.replaying).toBe(false);
  });

  it("emits one alarm event for a new Sentry issue between polls", async () => {
    const { result } = mount();
    await settle();
    act(() => result.current.onReplayDone());
    const issue: SentryIssue = {
      identifier: "sentry-20001",
      title: "TypeError: cannot read properties of undefined",
      properties: { status: "unresolved", link: "https://sentry.io/organizations/example-org/issues/20001/" },
      relations: { workload: "retail-tower-backend-api-staging" },
      createdAt: iso(NOW.getTime() + 30_000),
      updatedAt: iso(NOW.getTime() + 30_000),
    };
    port.set("sentryIssue", [issue]);
    await tick(60_000);
    port.set("sentryIssue", [issue]);
    await tick(60_000);

    const live = result.current.events.filter((e) => e.replay !== true);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ kind: "alarm", station: "core", alarmId: "sentry-20001" });
    expect(live[0].text.en).toContain(issue.title);
    expect(result.current.board!.alarms).toHaveLength(6);
    expect(result.current.events[0].alarmId).toBe("sentry-20001");
  });

  it("emits one monitor event, with no station, for an unlocated monitor entering Alert", async () => {
    const { result } = mount();
    await settle();
    const monitor = {
      identifier: "datadog-monitor-990001",
      title: "Disk usage is high on host {{host.name}}",
      properties: { overallState: "Alert", link: "https://app.datadoghq.eu/monitors/990001", tags: ["env:lab"] },
      relations: { service: null },
      createdAt: "2026-10-20T08:00:00Z",
      updatedAt: iso(NOW.getTime() + 30_000),
    };
    port.set("datadogMonitor", [monitor]);
    await tick(60_000);
    port.set("datadogMonitor", [monitor]);
    await tick(60_000);

    const live = result.current.events.filter((e) => e.replay !== true);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ kind: "monitor", station: null, alarmId: "datadog-monitor-990001" });
    expect(live[0].host).toBeUndefined();
    expect(result.current.board!.alarms.some((a) => a.id === "datadog-monitor-990001" && a.at === "unlocated")).toBe(true);
  });
});

describe("hook order", () => {
  it("calls the same hooks before and after the token arrives", async () => {
    bridge.value = WAITING;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, rerender } = mount();
    const waiting = Object.keys(result.current).sort();
    bridge.value = READY;
    rerender();
    await settle();
    expect(Object.keys(result.current).sort()).toEqual(waiting);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
