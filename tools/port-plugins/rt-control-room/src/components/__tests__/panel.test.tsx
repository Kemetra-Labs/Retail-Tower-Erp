import { useCallback, useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBoard } from "../../model/board";
import type { Board, Snapshot } from "../../model/types";
import { fixture, NOW } from "../../state/__tests__/testkit";
import type { BoardEvent } from "../../state/diff";
import { LangProvider } from "../../i18n/LangContext";
import { fmtStamp, type Lang } from "../../i18n/strings";
import { AlarmPanel } from "../AlarmPanel";
import { CiStrip } from "../CiStrip";
import { HealthChecks } from "../HealthChecks";
import { JiraRiver } from "../JiraRiver";
import { LowerPanels } from "../LowerPanels";
import { PerStation } from "../PerStation";
import type { Freshness } from "../PanelHead";
import { StatusTable } from "../StatusTable";
import { ControlRoom } from "../room/ControlRoom";
import type { Selection } from "../room/selection";
import { useSelection } from "../room/useFocusReturn";

const activeTab = () => document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');

function boardOf(mutate?: (s: Snapshot) => void, alarmRead?: { sentry: boolean }): Board {
  const snap = fixture();
  mutate?.(snap);
  return buildBoard(snap, { now: NOW, demo: false, ...(alarmRead ? { alarmRead } : {}) });
}

const noop = () => {};
const wrap = (ui: React.ReactNode, lang: Lang = "en") => render(<LangProvider initial={lang}>{ui}</LangProvider>);

let n = 0;
const event = (over: Partial<BoardEvent> = {}): BoardEvent => ({
  id: `e${++n}`,
  at: "2026-11-13T12:00:00Z",
  kind: "merge",
  station: "core",
  text: { en: "Merged: a change", ar: "تم الدمج: تعديل" },
  ...over,
});
const alarmEvent = (title: string, over: Partial<BoardEvent> = {}): BoardEvent =>
  event({ kind: "alarm", text: { en: `New error: ${title}`, ar: `خطأ جديد: ${title}` }, ...over });

const monitorEvent = (title: string, over: Partial<BoardEvent> = {}): BoardEvent =>
  event({ kind: "monitor", alarming: true, text: { en: `Monitor alert: ${title}`, ar: `تنبيه من المراقبة: ${title}` }, ...over });

/** The map, the side panel and the selection state wired as `App` wires them. */
function Live(props: {
  board: Board;
  events?: BoardEvent[];
  table?: boolean;
  fresh?: Freshness;
  paused?: boolean;
  replaying?: boolean;
  replayQueue?: BoardEvent[];
  onReplayDone?: () => void;
}) {
  const { board, events = [], fresh, paused = true, replaying = false, replayQueue = [], onReplayDone = noop } = props;
  const { selection, select } = useSelection({ fallback: activeTab });
  const [byKey, setByKey] = useState(false);
  const open = useCallback(
    (sel: Selection, k?: boolean) => {
      setByKey(k === true);
      select(sel, k);
    },
    [select],
  );
  return (
    <>
      <ControlRoom
        board={board}
        events={events}
        replayQueue={replayQueue}
        paused={paused}
        replaying={replaying}
        onReplayDone={onReplayDone}
        onSelect={open}
        selection={selection}
        table={props.table === false ? undefined : <StatusTable board={board} fresh={fresh} onSelect={open} />}
      />
      <AlarmPanel board={board} events={events} selection={selection} onSelect={open} focusOnOpen={byKey} fresh={fresh} />
    </>
  );
}

beforeEach(() => {
  document.documentElement.lang = "en";
  document.documentElement.dir = "ltr";
  // jsdom has no layout: an element counts as visible unless it sits in a hidden subtree.
  const proto = Element.prototype as unknown as { getClientRects: () => unknown[] };
  const saved = proto.getClientRects;
  proto.getClientRects = function (this: Element) {
    return this.closest("[hidden]") ? [] : [{}];
  };
  (globalThis as { __restoreRects?: () => void }).__restoreRects = () => {
    proto.getClientRects = saved;
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  (globalThis as { __restoreRects?: () => void }).__restoreRects?.();
});

const focusKeys = (root: ParentNode, prefix: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(`[data-focus^="${prefix}"]`)).map((el) => el.getAttribute("data-focus"));

describe("alarms tab", () => {
  it("lists the 5 alarms, then the 2 places with no health check, in that DOM order", () => {
    const board = boardOf();
    const { container } = wrap(<AlarmPanel board={board} events={[]} selection={null} onSelect={noop} />);
    expect(focusKeys(container, "alarm:")).toEqual([
      "alarm:sentry-10001",
      "alarm:sentry-10002",
      "alarm:sentry-10003",
      "alarm:sentry-10004",
      "alarm:sentry-10005",
    ]);
    expect(focusKeys(container, "watch:")).toEqual(["watch:admin", "watch:conn"]);
    expect(screen.getByRole("tab", { name: "Alarms (5)" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Admin Console: no health check")).toBeTruthy();
    expect(screen.getByText("ERPNext-Connector: no health check")).toBeTruthy();
    expect(screen.queryByText("Not placed on the map")).toBeNull();
  });

  it("puts an alarm Port cannot place in its own group above the no-health-check items", () => {
    const board = boardOf((s) => {
      const redis = s.monitors.find((m) => m.identifier === "datadog-monitor-900203");
      if (!redis) throw new Error("fixture changed");
      redis.title = "Redis instance down";
      redis.properties.overallState = "Alert";
    });
    const { container } = wrap(<AlarmPanel board={board} events={[]} selection={null} onSelect={noop} />);
    const heading = screen.getByRole("heading", { name: "Not placed on the map" });
    const unplaced = container.querySelector('[data-focus="alarm:datadog-monitor-900203"]') as HTMLElement;
    const lastPlaced = container.querySelector('[data-focus="alarm:sentry-10005"]') as HTMLElement;
    const firstWatch = container.querySelector('[data-focus="watch:admin"]') as HTMLElement;
    const after = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(lastPlaced, heading)).toBe(true);
    expect(after(heading, unplaced)).toBe(true);
    expect(after(unplaced, firstWatch)).toBe(true);
    expect(within(unplaced).getByText(/Not placed on the map: Port does not say which server/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Alarms (6)" })).toBeTruthy();
  });

  it("says where each alarm is: on the postings cable Connector to Backend-Core for the three route faults, inside the Connector for the reset", () => {
    const board = boardOf();
    wrap(<AlarmPanel board={board} events={[]} selection={null} onSelect={noop} />);
    expect(screen.getAllByText("On the cable Connector to Backend-Core (postings)")).toHaveLength(3);
    expect(screen.queryByText(/ERPNext refused|ERPNext is not answering/)).toBeNull();
    expect(screen.getByText("Backend-Core refused the request")).toBeTruthy();
    expect(screen.getByText("Backend-Core is not answering")).toBeTruthy();
    expect(screen.getByText("The request to Backend-Core took too long")).toBeTruthy();
    expect(screen.getAllByText("Inside ERPNext-Connector")).toHaveLength(1);
    expect(screen.getAllByText("Inside Admin Console")).toHaveLength(1);
  });

  it("still lists the alarms when the error read failed, and says they may be missing", () => {
    const board = boardOf(undefined, { sentry: false });
    const { container } = wrap(<AlarmPanel board={board} events={[]} selection={null} onSelect={noop} />);
    expect(focusKeys(container, "alarm:")).toHaveLength(5);
    expect(screen.getByText(/Error tracker not read\. Alarms may be missing\./)).toBeTruthy();
  });

  it("(E) the Alarms tab reads 'not read', never a zero count, when the error read failed with nothing cached", () => {
    const board = boardOf((s) => {
      s.sentryIssues = [];
    }, { sentry: false });
    wrap(<AlarmPanel board={board} events={[]} selection={null} onSelect={noop} />);
    expect(screen.getByRole("tab", { name: "Alarms (not read)" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Alarms (0)" })).toBeNull();
  });

  it("(E) the Alarms tab keeps the count of the cached alarms when the error read failed", () => {
    wrap(<AlarmPanel board={boardOf(undefined, { sentry: false })} events={[]} selection={null} onSelect={noop} />);
    expect(screen.getByRole("tab", { name: "Alarms (5)" })).toBeTruthy();
  });

  it("(E) the Alarms tab says 0 only for a successful read with no alarms, and reads in Arabic", () => {
    const empty = boardOf((s) => {
      s.sentryIssues = [];
    });
    const { unmount } = wrap(<AlarmPanel board={empty} events={[]} selection={null} onSelect={noop} />);
    expect(screen.getByRole("tab", { name: "Alarms (0)" })).toBeTruthy();
    unmount();
    const unread = boardOf((s) => {
      s.sentryIssues = [];
    }, { sentry: false });
    wrap(<AlarmPanel board={unread} events={[]} selection={null} onSelect={noop} />, "ar");
    expect(screen.getByRole("tab", { name: "الإنذارات (مش مقروء)" })).toBeTruthy();
  });

  it("says why it is empty, and keeps the unknown places listed", () => {
    const board = boardOf((s) => {
      s.sentryIssues = [];
    });
    const { container } = wrap(<AlarmPanel board={board} events={[]} selection={null} onSelect={noop} />);
    expect(screen.getByText(/No active alarms/)).toBeTruthy();
    expect(focusKeys(container, "watch:")).toHaveLength(2);
  });

  it("labels an example alarm", () => {
    const snap = fixture();
    const board = buildBoard(snap, { now: NOW, demo: true });
    wrap(<AlarmPanel board={board} events={[]} selection={null} onSelect={noop} />);
    expect(screen.getByText("Example, not real")).toBeTruthy();
  });
});

describe("events tab", () => {
  const events = [
    event({ id: "old", at: "2026-11-13T09:00:00Z", text: { en: "Merged: older", ar: "x" } }),
    event({
      id: "unplaced",
      at: "2026-11-13T11:00:00Z",
      kind: "monitor",
      station: null,
      alarmId: "m1",
      text: { en: "Monitor Disk usage is high: Alert", ar: "المراقب: Alert" },
    }),
    event({ id: "new", at: "2026-11-13T12:00:00Z", text: { en: "Merged: newest", ar: "y" } }),
  ];

  it("lists events newest first; one without a station carries 'Unlocated' and its original monitor title", async () => {
    const user = userEvent.setup();
    const { container } = wrap(<AlarmPanel board={boardOf()} events={events} selection={null} onSelect={noop} />);
    await user.click(screen.getByRole("tab", { name: "Events" }));
    expect(screen.getByRole("tab", { name: "Events" }).getAttribute("aria-selected")).toBe("true");
    const items = Array.from(container.querySelectorAll(".trail li"));
    expect(items.map((li) => li.querySelector(".what")?.textContent)).toEqual([
      "Merged: newest",
      "Monitor Disk usage is high: Alert",
      "Merged: older",
    ]);
    expect(within(items[1] as HTMLElement).getByText("Unlocated")).toBeTruthy();
    expect(within(items[0] as HTMLElement).queryByText("Unlocated")).toBeNull();
    // Nothing here is a replay: no "(partial)" line.
    expect(screen.queryByText(/\(partial\)/)).toBeNull();
  });

  it("says once that a replay is partial", async () => {
    const user = userEvent.setup();
    const replayed = events.map((e) => ({ ...e, replay: true }));
    wrap(<AlarmPanel board={boardOf()} events={replayed} selection={null} onSelect={noop} />);
    await user.click(screen.getByRole("tab", { name: "Events" }));
    expect(screen.getAllByText(/\(partial\)/)).toHaveLength(1);
  });

  it("says why it is empty", async () => {
    const user = userEvent.setup();
    wrap(<AlarmPanel board={boardOf()} events={[]} selection={null} onSelect={noop} />);
    await user.click(screen.getByRole("tab", { name: "Events" }));
    expect(screen.getByText(/No changes yet/)).toBeTruthy();
  });
});

describe("detail", () => {
  const show = (board: Board, selection: Selection, lang: Lang = "en") =>
    wrap(<AlarmPanel board={board} events={[]} selection={selection} onSelect={noop} />, lang);
  const sel = (id: string): Selection => ({ type: "alarm", id });

  it("shows where, kind code, source, since, the path with the failing hop, the message and the Sentry link", () => {
    const board = boardOf();
    const { container } = show(board, sel("sentry-10001"));
    const detail = container.querySelector("[data-detail]") as HTMLElement;
    expect(within(detail).getByRole("heading", { level: 2, name: "Backend-Core refused the request" })).toBeTruthy();
    const dl = detail.querySelector("dl") as HTMLElement;
    expect(dl.textContent).toContain("On the cable Connector to Backend-Core (postings)");
    expect(dl.textContent).toContain("403");
    expect(dl.textContent).toContain("Sentry");
    // 2026-11-12T18:29Z is 20:29 in Cairo.
    expect(dl.textContent).toContain("12 Nov, 20:29");
    const hops = Array.from(detail.querySelectorAll(".trace li")).map((li) => li.firstChild?.textContent);
    // The Connector calls Backend-Core: the request runs Connector -> Backend-Core, and Backend-Core fails.
    expect(hops).toEqual(["ERPNext-Connector", "Backend-Core"]);
    const failing = detail.querySelectorAll('.trace li[data-fail="true"]');
    expect(failing).toHaveLength(1);
    expect(failing[0].firstChild?.textContent).toBe("Backend-Core");
    expect(failing[0].textContent).toContain("fails here");
    const msg = detail.querySelector(".msg") as HTMLElement;
    expect(msg.getAttribute("dir")).toBe("ltr");
    expect(msg.textContent).toContain("403 Client Error: Forbidden");
    const link = within(detail).getByRole("link", { name: "Open in Sentry" });
    expect(link.getAttribute("href")).toBe("https://sentry.io/organizations/example-org/issues/10001/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("places the reset alarm inside the Connector, on the path up to the Connector", () => {
    const { container } = show(boardOf(), sel("sentry-10004"));
    const detail = container.querySelector("[data-detail]") as HTMLElement;
    expect(detail.querySelector("dl")?.textContent).toContain("Inside ERPNext-Connector");
    const hops = Array.from(detail.querySelectorAll(".trace li")).map((li) => li.firstChild?.textContent);
    expect(hops).toEqual(["POS", "Backend-Core", "ERPNext-Connector"]);
    expect(detail.querySelector('.trace li[data-fail="true"]')?.firstChild?.textContent).toBe("ERPNext-Connector");
  });

  it("shows an Admin Console alarm with its own single hop", () => {
    const { container } = show(boardOf(), sel("sentry-10005"));
    const hops = Array.from(container.querySelectorAll(".trace li")).map((li) => li.firstChild?.textContent);
    expect(hops).toEqual(["Admin Console"]);
  });

  it("renders no link for anything but https, and 'no data' for an alarm with no start time", () => {
    const board = boardOf((s) => {
      s.sentryIssues[0].properties.link = "http://sentry.io/organizations/example-org/issues/10001/";
    });
    const { container, unmount } = show(board, sel("sentry-10001"));
    expect(container.querySelector("[data-detail] a")).toBeNull();
    unmount();

    // A Datadog alarm has no `since`; its https link opens in Datadog.
    const dd = boardOf((s) => {
      const m = s.monitors.find((x) => x.identifier === "datadog-monitor-900002");
      if (!m) throw new Error("fixture changed");
      m.properties.overallState = "Alert";
    });
    const second = show(dd, sel("datadog-monitor-900002"));
    const detail = second.container.querySelector("[data-detail]") as HTMLElement;
    expect(detail.querySelector("dl")?.textContent).toContain("no data");
    expect(detail.textContent).not.toContain("Invalid Date");
    expect(within(detail).getByRole("link", { name: "Open in Datadog" }).getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("says no path is drawn for an alarm that cannot be placed", () => {
    const board = boardOf((s) => {
      const redis = s.monitors.find((m) => m.identifier === "datadog-monitor-900203");
      if (!redis) throw new Error("fixture changed");
      redis.title = "Redis instance down";
      redis.properties.overallState = "Alert";
    });
    const { container } = show(board, sel("datadog-monitor-900203"));
    expect(container.querySelector(".trace")).toBeNull();
    expect(screen.getByText("No path is drawn: the location is not known.")).toBeTruthy();
  });

  it("shows a station and a server", () => {
    const board = boardOf();
    const first = show(board, { type: "station", id: "conn" });
    const detail = first.container.querySelector("[data-detail]") as HTMLElement;
    expect(within(detail).getByRole("heading", { level: 2, name: "ERPNext-Connector" })).toBeTruthy();
    expect(detail.textContent).toContain("HLT Health checks");
    expect(detail.textContent).toContain("not linked");
    const listed = (el: HTMLElement) => within(el).queryAllByRole("button").filter((b) => b.getAttribute("data-focus")?.startsWith("alarm:"));
    // RT-1408 A: the Connector's panel lists what its card counts (1: the one inside the bridge) ...
    expect(listed(detail)).toHaveLength(1);
    expect(detail.textContent).toContain("Alarms: 1");
    first.unmount();

    // ... and Backend-Core's panel lists the 3 on the Postings cable, which the Connector reported.
    const core = show(board, { type: "station", id: "core" });
    const coreDetail = core.container.querySelector("[data-detail]") as HTMLElement;
    expect(coreDetail.textContent).toContain("Alarms: 3");
    expect(listed(coreDetail)).toHaveLength(3);
    core.unmount();

    const second = show(board, { type: "host", id: "lab-01" });
    const host = second.container.querySelector("[data-detail]") as HTMLElement;
    expect(within(host).getByRole("heading", { level: 2, name: "lab-01" })).toBeTruthy();
    expect(host.textContent).toContain("API and worker");
    expect(host.textContent).toContain("The 8 host checks watch every server at once.");
  });

  it("renders in Arabic, with the message still left to right", () => {
    const { container } = show(boardOf(), sel("sentry-10001"), "ar");
    const detail = container.querySelector("[data-detail]") as HTMLElement;
    expect(detail.textContent).toContain("Backend-Core رفض الطلب");
    expect(detail.textContent).toContain("على كابل الجسر إلى Backend-Core (قيود)");
    expect(detail.textContent).toContain(fmtStamp(new Date("2026-11-12T18:29:00Z"), "ar"));
    expect(detail.textContent).toContain("20:29");
    expect((detail.querySelector(".msg") as HTMLElement).getAttribute("dir")).toBe("ltr");
    expect(screen.getByRole("link", { name: "افتح في Sentry" })).toBeTruthy();
  });

  it("drops a selection that no longer exists, without throwing", () => {
    const onSelect = vi.fn();
    const { container } = wrap(<AlarmPanel board={boardOf()} events={[]} selection={sel("gone")} onSelect={onSelect} />);
    expect(onSelect).toHaveBeenCalledWith(null, false);
    expect(container.querySelector("[data-detail]")).toBeNull();
    expect(focusKeys(container, "alarm:")).toHaveLength(5);
  });
});

describe("keyboard and focus", () => {
  it("Enter on an alarm in the list opens its detail with the heading focused; Back returns to the list button", async () => {
    const user = userEvent.setup();
    const { container } = wrap(<Live board={boardOf()} />);
    const button = container.querySelector('button[data-focus="alarm:sentry-10002"]') as HTMLElement;
    button.focus();
    await user.keyboard("{Enter}");
    const detail = container.querySelector("[data-detail]") as HTMLElement;
    expect(document.activeElement).toBe(within(detail).getByRole("heading", { level: 2 }));
    await user.click(within(detail).getByRole("button", { name: "Back" }));
    expect(container.querySelector("[data-detail]")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("Enter on a station opens its detail at the heading; Escape returns to the station", async () => {
    const user = userEvent.setup();
    const { container } = wrap(<Live board={boardOf()} />);
    const station = container.querySelector('[data-focus="station:core"]') as HTMLElement;
    station.focus();
    await user.keyboard("{Enter}");
    const heading = within(container.querySelector("[data-detail]") as HTMLElement).getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("Backend-Core");
    expect(document.activeElement).toBe(heading);
    await user.keyboard("{Escape}");
    expect(container.querySelector("[data-detail]")).toBeNull();
    expect(document.activeElement).toBe(station);
  });

  it("Back from a pin's detail while the Events tab is active returns to the pin", async () => {
    const user = userEvent.setup();
    const { container } = wrap(<Live board={boardOf()} />);
    await user.click(screen.getByRole("tab", { name: "Events" }));
    const pin = container.querySelector('[data-focus="pin:sentry-10003"]') as HTMLElement;
    pin.focus();
    await user.keyboard("{Enter}");
    expect(container.querySelector("[data-detail]")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(document.activeElement).toBe(pin);
    // The Events tab kept its place while the detail was open.
    expect(screen.getByRole("tab", { name: "Events" }).getAttribute("aria-selected")).toBe("true");
  });

  it("opening an alarm from inside a station detail keeps the first opener", async () => {
    const user = userEvent.setup();
    const { container } = wrap(<Live board={boardOf()} />);
    const station = container.querySelector('[data-focus="station:conn"]') as HTMLElement;
    station.focus();
    await user.keyboard("{Enter}");
    const inside = container.querySelector('[data-detail] [data-focus="alarm:sentry-10004"]') as HTMLElement;
    await user.click(inside);
    expect(within(container.querySelector("[data-detail]") as HTMLElement).getByRole("heading", { level: 2, name: "The connection was cut" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(station);
  });
});

describe("the quiet status region", () => {
  const board = boardOf();
  const setup = () => {
    vi.useFakeTimers();
    const view = (events: BoardEvent[]) => (
      <LangProvider>
        <AlarmPanel board={board} events={events} selection={null} onSelect={noop} />
      </LangProvider>
    );
    const utils = render(view([]));
    const text = () => screen.getByRole("status").textContent;
    const feed = (events: BoardEvent[]) => act(() => utils.rerender(view(events)));
    const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
    return { text, feed, wait };
  };

  it("announces two alarms 5 s apart as one update, and the second after 15 s", () => {
    const { text, feed, wait } = setup();
    const a = alarmEvent("First failure");
    const b = alarmEvent("Second failure");
    expect(text()).toBe("");
    feed([a]);
    expect(text()).toBe("New error: First failure");
    wait(5_000);
    feed([b, a]);
    expect(text()).toBe("New error: First failure");
    wait(9_999);
    expect(text()).toBe("New error: First failure");
    wait(1);
    expect(text()).toBe("New error: Second failure");
  });

  it("never announces a merge, CI run, Jira change or deployment, nor a replayed alarm", () => {
    const { text, feed, wait } = setup();
    const noise = (["merge", "ci", "jira", "deploy"] as const).map((kind) => event({ kind, text: { en: `noise ${kind}`, ar: "x" } }));
    feed(noise);
    wait(30_000);
    expect(text()).toBe("");
    feed([alarmEvent("Replayed", { replay: true }), ...noise]);
    wait(30_000);
    expect(text()).toBe("");
  });

  it("reads a burst as one update with the count, and never reads what was on screen at mount", () => {
    vi.useFakeTimers();
    const old = alarmEvent("Already there");
    const view = (events: BoardEvent[]) => (
      <LangProvider>
        <AlarmPanel board={board} events={events} selection={null} onSelect={noop} />
      </LangProvider>
    );
    const utils = render(view([old]));
    expect(screen.getByRole("status").textContent).toBe("");
    const first = alarmEvent("One");
    act(() => utils.rerender(view([first, old])));
    const x = alarmEvent("Two");
    const y = alarmEvent("Three");
    act(() => utils.rerender(view([y, x, first, old])));
    act(() => void vi.advanceTimersByTime(15_000));
    expect(screen.getByRole("status").textContent).toBe("2 new alarms. Latest: New error: Three");
  });

  it("announces a new Datadog alarm, and not a monitor that went back to OK, a replay or one present at mount", () => {
    const { text, feed, wait } = setup();
    feed([monitorEvent("Disk full", { replay: true })]);
    wait(30_000);
    expect(text()).toBe("");
    const back = monitorEvent("Disk full", { alarming: false, text: { en: "Monitor Disk full: OK", ar: "x" } });
    feed([back]);
    wait(30_000);
    expect(text()).toBe("");
    const up = monitorEvent("Queue stuck");
    feed([up, back]);
    expect(text()).toBe("Monitor alert: Queue stuck");
  });

  it("reads a Datadog alarm and a Sentry alarm in one burst as one update with the count", () => {
    const { text, feed, wait } = setup();
    const first = alarmEvent("One");
    feed([first]);
    const sentry = alarmEvent("Two");
    const datadog = monitorEvent("Three");
    feed([datadog, sentry, first]);
    wait(15_000);
    expect(text()).toBe("2 new alarms. Latest: Monitor alert: Three");
  });

  it("does not announce a Datadog alarm already on screen at mount", () => {
    vi.useFakeTimers();
    const old = monitorEvent("Already there");
    render(
      <LangProvider>
        <AlarmPanel board={board} events={[old]} selection={null} onSelect={noop} />
      </LangProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("is the only status region of the panel and is removed with it (no timer left)", () => {
    const { text, feed } = setup();
    feed([alarmEvent("Boom")]);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
    expect(text).toBeTypeOf("function");
  });
});

describe("table view of the map", () => {
  class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    constructor(private readonly cb: (entries: { contentRect: { width: number } }[]) => void) {
      FakeResizeObserver.instances.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    fire(width: number) {
      this.cb([{ contentRect: { width } }]);
    }
  }
  const width = (w: number) => act(() => FakeResizeObserver.instances.forEach((o) => o.fire(w)));

  beforeEach(() => {
    FakeResizeObserver.instances = [];
  });

  it("lists every station with state, alarms, health checks and the four links; unknown is amber", () => {
    const board = boardOf();
    const { container } = wrap(<StatusTable board={board} />);
    const row = (id: string) => container.querySelector(`[data-station-row="${id}"]`) as HTMLElement;
    expect(container.querySelectorAll("[data-station-row]")).toHaveLength(5);
    const cells = (id: string) => Array.from(row(id).querySelectorAll("th, td")).map((c) => c.textContent);

    expect(cells("pos").slice(0, 4)).toEqual(["POS", "No errors reported", "0", "-"]);
    // RT-1408 A: the 3 alarms on the postings cable fail on Backend-Core's route, so its row says so.
    expect(cells("core").slice(0, 4)).toEqual(["Backend-Core", "Fault", "3", "7/7"]);
    expect(cells("conn")[1]).toBe("Fault");
    expect(cells("conn")[2]).toBe("1");
    expect(cells("admin")[2]).toBe("1");
    expect(cells("admin")[1]).toBe("Fault");
    expect(cells("erp").slice(0, 4)).toEqual(["ERPNext", "External ledger, not monitored here", "-", "-"]);
    expect(row("core").querySelectorAll(".links li")).toHaveLength(4);
    expect(row("core").textContent).toContain("HLT sending");

    // No health check at all: amber, "none", never healthy.
    expect(row("admin").querySelector("td:nth-child(4)")?.className).toContain("unk");
    expect(row("admin").querySelector("td:nth-child(4)")?.textContent).toBe("none");
    expect(row("erp").querySelector("td")?.className).toContain("unk");
  });

  it("reads 'not read', never 0 or 'no faults', when the error read failed", () => {
    const board = boardOf(undefined, { sentry: false });
    const { container } = wrap(<StatusTable board={board} />);
    const core = container.querySelector('[data-station-row="core"]') as HTMLElement;
    expect(core.textContent).toContain("Not read");
    expect(core.textContent).not.toContain("No faults");
    expect(core.querySelector("td:nth-child(3)")?.textContent).toBe("not read");
    expect(core.querySelector("td:nth-child(3)")?.className).toContain("unk");
  });

  it("replaces the diagram on a narrow tile, and the toggle reaches it at any width", async () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { container } = wrap(<Live board={boardOf()} />);
    const toggle = screen.getByRole("button", { name: "Table view" });
    const diagram = () => container.querySelector(".diagram") as HTMLElement;
    expect(container.querySelector("[data-status-table]")).toBeNull();
    expect(diagram().hidden).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    width(800);
    expect(container.querySelector("[data-status-table]")).not.toBeNull();
    expect(diagram().hidden).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    width(1200);
    expect(container.querySelector("[data-status-table]")).toBeNull();
    // At any width, the toggle shows it; clicking again returns the diagram.
    fireEvent.click(toggle);
    expect(container.querySelector("[data-status-table]")).not.toBeNull();
    fireEvent.click(toggle);
    expect(container.querySelector("[data-status-table]")).toBeNull();
    expect(diagram().hidden).toBe(false);
  });

  it("opens a station from the table, and never counts a table row as a station on the map", async () => {
    const user = userEvent.setup();
    const { container } = wrap(<Live board={boardOf()} />);
    expect(container.querySelectorAll('[data-focus^="station:"]')).toHaveLength(5);
    await user.click(screen.getByRole("button", { name: "Table view" }));
    expect(container.querySelectorAll('[data-focus^="station:"]')).toHaveLength(5);
    const row = container.querySelector('[data-focus="row:conn"]') as HTMLElement;
    row.focus();
    await user.keyboard("{Enter}");
    expect(within(container.querySelector("[data-detail]") as HTMLElement).getByRole("heading", { level: 2, name: "ERPNext-Connector" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(row);
  });

  it("(G) a detail that vanishes while focus is on its heading hands focus back, never to the page body", async () => {
    const user = userEvent.setup();
    const { container, rerender } = wrap(<Live board={boardOf()} />);
    const pin = container.querySelector('[data-focus="pin:sentry-10001"]') as HTMLElement;
    pin.focus();
    await user.keyboard("{Enter}");
    const heading = container.querySelector("[data-detail] h2") as HTMLElement;
    expect(document.activeElement).toBe(heading);

    // A poll resolves the alarm: its detail, its pin and its list row all go.
    const gone = boardOf((s) => {
      s.sentryIssues = s.sentryIssues.filter((i) => i.identifier !== "sentry-10001");
    });
    rerender(
      <LangProvider initial="en">
        <Live board={gone} />
      </LangProvider>,
    );
    expect(container.querySelector("[data-detail]")).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute("role")).toBe("tab");
  });

  it("(G) a vanished detail does not steal focus the viewer had already moved elsewhere", async () => {
    const user = userEvent.setup();
    const { container, rerender } = wrap(<Live board={boardOf()} />);
    (container.querySelector('[data-focus="pin:sentry-10001"]') as HTMLElement).focus();
    await user.keyboard("{Enter}");
    const other = container.querySelector('[data-focus="station:core"]') as HTMLElement;
    other.focus();
    const gone = boardOf((s) => {
      s.sentryIssues = s.sentryIssues.filter((i) => i.identifier !== "sentry-10001");
    });
    rerender(
      <LangProvider initial="en">
        <Live board={gone} />
      </LangProvider>,
    );
    expect(container.querySelector("[data-detail]")).toBeNull();
    expect(document.activeElement).toBe(other);
  });

  it("(I) the ERPNext row shows the alarm count of the ledger, not a dash, and a dash only when none", () => {
    const withAlarm = boardOf((s) => {
      s.monitors.push({
        identifier: "m-lab03",
        title: "Disk usage high on lab-03",
        properties: { overallState: "Alert", link: null, tags: ["host:lab-03"] },
        relations: { service: null },
        createdAt: "2026-10-20T08:00:00Z",
        updatedAt: "2026-11-13T12:00:00Z",
      });
    });
    expect(withAlarm.stations.find((x) => x.id === "erp")!.readings.alarms).toBe(1);
    const { container, unmount } = wrap(<StatusTable board={withAlarm} />);
    const cells = (id: string) =>
      Array.from((container.querySelector(`[data-station-row="${id}"]`) as HTMLElement).querySelectorAll("td")).map((c) => c.textContent);
    expect(cells("erp")[0]).toBe("Fault");
    expect(cells("erp")[1]).toBe("1");
    unmount();
    const quiet = wrap(<StatusTable board={boardOf()} />);
    const row = quiet.container.querySelector('[data-station-row="erp"]') as HTMLElement;
    expect(row.querySelectorAll("td")[1].textContent).toBe("-");
  });

  it("does not leave the 'Replaying' state stuck while the table is shown", async () => {
    const onReplayDone = vi.fn();
    const queued = alarmEvent("Replayed", { replay: true, alarmId: "sentry-10005", station: "admin" });
    const { container } = wrap(
      <Live board={boardOf()} replaying replayQueue={[queued]} paused onReplayDone={onReplayDone} />,
    );
    // Paused: the replay waits for Resume, so it has not finished.
    expect(onReplayDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Table view" }));
    expect(container.querySelector("[data-status-table]")).not.toBeNull();
    expect(onReplayDone).toHaveBeenCalled();
  });
});

describe("lower panels", () => {
  it("per station: a missing figure is 'no data', never 0 and never 'not read'", () => {
    const board = boardOf((s) => {
      s.services = s.services.filter((x) => x.identifier !== "admin-console");
    }, { sentry: false });
    const { container } = wrap(<PerStation board={board} />);
    const admin = container.querySelector('[data-row="admin"]') as HTMLElement;
    const cells = Array.from(admin.querySelectorAll("td")).map((c) => c.textContent);
    expect(cells).toEqual(["no data", "no data", "no data", "no data"]);
    expect(container.textContent).not.toContain("not read");
    const core = Array.from((container.querySelector('[data-row="core"]') as HTMLElement).querySelectorAll("td")).map((c) => c.textContent);
    expect(core.every((c) => /^\d+$/.test(c ?? ""))).toBe(true);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(4);
  });

  it("jira: the four statuses from the board, or 'no data' when nothing was read", () => {
    const board = boardOf();
    const { container, unmount } = wrap(<JiraRiver board={board} />);
    const col = (k: string) => container.querySelector(`[data-status="${k}"] .n`)?.textContent;
    expect([col("todo"), col("inProgress"), col("review"), col("done")]).toEqual(
      [board.jira.todo, board.jira.inProgress, board.jira.review, board.jira.done].map(String),
    );
    unmount();
    const empty = boardOf((s) => {
      s.jira = [];
    });
    const second = wrap(<JiraRiver board={empty} />);
    expect(Array.from(second.container.querySelectorAll(".col .n")).map((x) => x.textContent)).toEqual(["no data", "no data", "no data", "no data"]);
  });

  it("CI: the last 72 runs as a strip with the pass rate, 'no data' without a finished run", () => {
    const board = boardOf();
    const { container, unmount } = wrap(<CiStrip board={board} />);
    expect(container.querySelectorAll(".strip .cell")).toHaveLength(board.ci.last72.length);
    expect(container.querySelector(".reading")?.textContent).toBe(`${board.ci.passRate}%`);
    expect(container.textContent).toContain(`The last ${board.ci.last72.length} runs, oldest on the left.`);
    expect(container.textContent).toContain(`of the last ${board.ci.last72.length} runs passed`);
    expect(container.querySelectorAll(".cell.f")).toHaveLength(board.ci.last72.filter((c) => c === "f").length);
    unmount();
    const none = boardOf((s) => {
      s.runs = [];
    });
    const second = wrap(<CiStrip board={none} />);
    expect(second.container.querySelector(".reading")?.textContent).toBe("no data");
    expect(second.container.querySelector(".strip")).toBeNull();
  });

  it("health checks: grouped by what they watch; a group with none is amber, the example alarm turns Backend-Core red", () => {
    const board = boardOf();
    const { container, unmount } = wrap(<HealthChecks board={board} />);
    const chip = (g: string) => container.querySelector(`[data-group="${g}"] .chip`) as HTMLElement;
    expect(chip("core").textContent).toBe("7/7");
    expect(chip("servers").textContent).toBe("8/8");
    expect(chip("databases").textContent).toBe("3/3");
    expect(chip("admin").textContent).toBe("none");
    expect(chip("admin").className).toContain("stale");
    expect(chip("conn").className).toContain("stale");
    expect(chip("pos").textContent).toBe("not needed");
    expect(container.textContent).toContain("18 checks in Port, grouped by what they watch.");
    expect(container.textContent).toContain("Servers (each of 3)");
    unmount();
    const demo = buildBoard(fixture(), { now: NOW, demo: true });
    const second = wrap(<HealthChecks board={demo} />);
    const core = second.container.querySelector('[data-group="core"] .chip') as HTMLElement;
    expect(core.textContent).toBe("6/7");
    expect(core.className).toContain("bad");
  });

  it("never-read monitors read 'not read' in the health panel, the status table and the station lamps, never 'none'", () => {
    const snap = fixture();
    snap.monitors = [];
    snap.sentryIssues = []; // no alarm anywhere: the state cell then shows the unread checks, not "Fault"
    const board = buildBoard(snap, { now: NOW, demo: false, unread: ["monitors"] });
    const { container } = wrap(
      <>
        <HealthChecks board={board} />
        <StatusTable board={board} />
      </>,
    );
    const chip = (g: string) => container.querySelector(`[data-group="${g}"] .chip`) as HTMLElement;
    expect(chip("core").textContent).toBe("not read");
    expect(chip("admin").textContent).toBe("not read");
    expect(chip("pos").textContent).toBe("not needed");
    const row = (id: string) => container.querySelector(`[data-station-row="${id}"]`) as HTMLElement;
    expect(row("core").textContent).not.toMatch(/none/);
    expect(row("core").querySelectorAll("td")[2].textContent).toBe("not read");
    expect(row("core").querySelectorAll("td")[0].textContent).toBe("Not read");
    expect(row("admin").querySelector(".unk")).not.toBeNull();
  });

  it("never-read Jira reads 'no data' in the river and the CI strip stays real", () => {
    const snap = fixture();
    snap.jira = [];
    const board = buildBoard(snap, { now: NOW, demo: false, unread: ["jira"] });
    const { container } = wrap(<JiraRiver board={board} />);
    expect(Array.from(container.querySelectorAll(".col .n")).map((x) => x.textContent)).toEqual(["no data", "no data", "no data", "no data"]);
  });

  it("LowerPanels is one wrapper around the four panels", () => {
    const { container } = wrap(<LowerPanels board={boardOf()} />);
    expect(container.querySelectorAll("[data-lower-panels] > section")).toHaveLength(4);
  });
});

describe("a stale board", () => {
  const fresh: Freshness = { stale: true, asOf: new Date("2026-11-13T12:30:00Z") };

  it("every panel keeps its last good figures and shows the amber chip with the last sync time", () => {
    const board = boardOf();
    const { container } = wrap(
      <>
        <AlarmPanel board={board} events={[]} selection={null} onSelect={noop} fresh={fresh} />
        <StatusTable board={board} fresh={fresh} />
        <LowerPanels board={board} fresh={fresh} />
      </>,
    );
    // Sync at 12:30 UTC is 14:30 in Cairo.
    const stale = Array.from(container.querySelectorAll(".chip.stale")).filter((c) => c.textContent === "Stale, last sync 14:30");
    expect(stale).toHaveLength(1 + 1 + 4);
    expect(screen.getByText("Alarms may be missing.")).toBeTruthy();
    // Values are still there; a failed read cleared nothing.
    expect(focusKeys(container, "alarm:")).toHaveLength(5);
    expect(container.querySelector('[data-group="core"] .chip')?.textContent).toBe("7/7");
    expect(container.querySelector('[data-row="core"]')).not.toBeNull();
  });

  it("names the old panels, and does not say alarms may be missing, when only CI or Jira failed", () => {
    const board = boardOf();
    wrap(<AlarmPanel board={board} events={[]} selection={null} onSelect={noop} fresh={{ ...fresh, failed: ["runs"] }} />);
    expect(screen.queryByText("Alarms may be missing.")).toBeNull();
    expect(screen.getByText("Older data in: Code history.")).toBeTruthy();
  });

  it("keeps the alarms-may-be-missing note when the monitors failed", () => {
    wrap(<AlarmPanel board={boardOf()} events={[]} selection={null} onSelect={noop} fresh={{ ...fresh, failed: ["monitors"] }} />);
    expect(screen.getByText("Alarms may be missing.")).toBeTruthy();
  });

  it("shows no chip while the board is fresh", () => {
    const { container } = wrap(<LowerPanels board={boardOf()} fresh={{ stale: false, asOf: NOW }} />);
    expect(container.querySelector(".phead .chip.stale")).toBeNull();
  });

  it("falls back to a plain 'Stale' when no sync time is known", () => {
    const { container } = wrap(<HealthChecks board={boardOf()} fresh={{ stale: true, asOf: null }} />);
    expect(container.querySelector(".phead .chip.stale")?.textContent).toBe("Stale");
  });
});
