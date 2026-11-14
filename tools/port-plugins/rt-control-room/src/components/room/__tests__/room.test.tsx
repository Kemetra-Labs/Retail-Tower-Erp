import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBoard } from "../../../model/board";
import type { Board } from "../../../model/types";
import { LangProvider } from "../../../i18n/LangContext";
import type { Lang } from "../../../i18n/strings";
import type { BoardEvent } from "../../../state/diff";
import { fixture, NOW } from "../../../state/__tests__/testkit";
import { ControlRoom, type ControlRoomProps } from "../ControlRoom";

const FAKE = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"] as const;

function boardOf(opts: { sentryRead?: boolean; mutate?: (b: Board) => void; noIssues?: boolean } = {}): Board {
  const snap = fixture();
  if (opts.noIssues) snap.sentryIssues = [];
  const board = buildBoard(snap, { now: NOW, demo: false, alarmRead: { sentry: opts.sentryRead ?? true } });
  opts.mutate?.(board);
  return board;
}

function props(over: Partial<ControlRoomProps> = {}): ControlRoomProps {
  return {
    board: boardOf(),
    events: [],
    replayQueue: [],
    // Paused unless a test is about motion: a still board.
    paused: true,
    replaying: false,
    onReplayDone: vi.fn(),
    onSelect: vi.fn(),
    selection: null,
    ...over,
  };
}

function mount(over: Partial<ControlRoomProps> = {}, lang: Lang = "en") {
  const p = props(over);
  const view = render(
    <LangProvider initial={lang}>
      <ControlRoom {...p} />
    </LangProvider>,
  );
  const again = (next: Partial<ControlRoomProps>) => {
    Object.assign(p, next);
    view.rerender(
      <LangProvider initial={lang}>
        <ControlRoom {...p} />
      </LangProvider>,
    );
  };
  return { ...view, p, again };
}

const q = (c: ParentNode, s: string) => Array.from(c.querySelectorAll(s));
const text = (c: ParentNode, s: string) => c.querySelector(s)?.textContent ?? "";

const event = (n: number, over: Partial<BoardEvent> = {}): BoardEvent => ({
  id: `ev${n}`,
  at: new Date(2026, 10, 13, 9, n).toISOString(),
  kind: "merge",
  station: "pos",
  text: { en: `change ${n}`, ar: `تغيير ${n}` },
  replay: true,
  ...over,
});

beforeEach(() => {
  document.documentElement.lang = "en";
  document.documentElement.dir = "ltr";
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the drawn board", () => {
  it("draws 5 stations, 4 cables, 3 hosts and 5 alarm pins (3 on c3, 1 inside the connector, 1 on admin)", () => {
    const { container } = mount();
    expect(q(container, '[data-focus^="station:"]')).toHaveLength(5);
    expect(q(container, "path.cable[data-cable]")).toHaveLength(4);
    expect(q(container, '[data-focus^="host:"]')).toHaveLength(3);
    const pins = q(container, ".pin");
    expect(pins).toHaveLength(5);
    const at = (k: string) => pins.filter((p) => p.getAttribute("data-at") === k).length;
    expect([at("c3"), at("c4"), at("conn"), at("admin")]).toEqual([3, 0, 1, 1]);
  });

  it("draws c3 (Postings) as a fault and the other cables as live, with their fault counts", () => {
    const { container } = mount();
    const cls = (id: string) => container.querySelector(`path.cable[data-cable="${id}"]`)?.getAttribute("class") ?? "";
    expect(cls("c3")).toContain("fault");
    for (const id of ["c1", "c2", "c4"]) {
      expect(cls(id)).toContain("live");
      expect(cls(id)).not.toContain("fault");
    }
    expect(text(container, '[data-cable-tag="c3"]')).toContain("3 faults");
    expect(text(container, '[data-cable-tag="c1"]')).toContain("no faults");
  });

  it("reads HLT 7/7 on Backend-Core", () => {
    const { container } = mount();
    const core = container.querySelector('[data-focus="station:core"]') as Element;
    expect(text(core, '[data-lamp="datadog"]')).toContain("HLT 7/7");
  });

  it("draws the Datadog lamp of a never-read monitor collection amber and reads 'not read', not 'no health check'", () => {
    const snap = fixture();
    snap.monitors = [];
    const board = buildBoard(snap, { now: NOW, demo: false, unread: ["monitors"] });
    const { container } = mount({ board });
    const lamp = container.querySelector('[data-focus="station:core"] [data-lamp="datadog"]') as Element;
    expect(lamp.getAttribute("class")).toContain("unk");
    expect(lamp.querySelector("title")?.textContent).toBe("Health checks: not read");
    expect(container.querySelector("[data-unknown-icon]")).toBeNull();
  });

  it("makes every station, pin and server a focusable button", () => {
    const { container } = mount();
    const all = q(container, '[data-focus^="station:"], [data-focus^="pin:"], [data-focus^="host:"]');
    expect(all).toHaveLength(13);
    for (const el of all) {
      expect(el.getAttribute("role")).toBe("button");
      expect(el.getAttribute("tabindex")).toBe("0");
    }
  });

  it("draws the protection path neutral, never as a fault or a live cable", () => {
    const { container } = mount();
    const rules = q(container, "path.cable.rule");
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r.getAttribute("class")).not.toMatch(/fault|live/);
    expect(container.textContent).toContain("No direct cable to ERPNext");
  });

  it("shows each source's sync state, amber with a question mark when stale or unknown", () => {
    const { container } = mount({
      board: boardOf({
        mutate: (b) => {
          b.sources.github = { ...b.sources.github, state: "stale" };
          b.sources.jira = { ...b.sources.jira, state: "unknown", lastSync: null, lastChange: null };
        },
      }),
    });
    const state = (id: string) => container.querySelector(`[data-source="${id}"]`)?.getAttribute("data-state");
    expect([state("sentry"), state("datadog"), state("github"), state("jira")]).toEqual(["fresh", "fresh", "stale", "unknown"]);
    expect(text(container, '[data-source="jira"]')).toContain("Not known");
    expect(text(container, '[data-source="github"]')).toContain("Stale");
    expect(container.querySelector('[data-source="github"]')?.getAttribute("class")).toContain("stale");
    expect(text(container, '[data-source="sentry"]')).toMatch(/Last change/);
  });

  it("shows each server with its check counts", () => {
    const board = boardOf();
    const { container } = mount({ board });
    for (const h of board.hosts) {
      const el = container.querySelector(`[data-focus="host:${h.id}"]`) as Element;
      expect(el.getAttribute("data-checks")).toBe(`${h.checks.ok}/${h.checks.total}`);
      expect(el.textContent).toContain(h.id);
    }
  });
});

describe("unknown and unread are never green or zero", () => {
  it("draws no health check as amber with a question mark", () => {
    const { container } = mount();
    const iconOn = (id: string) => container.querySelector(`[data-focus="station:${id}"] [data-unknown-icon]`) !== null;
    expect([iconOn("admin"), iconOn("conn"), iconOn("core"), iconOn("pos")]).toEqual([true, true, false, false]);
    const hlt = container.querySelector('[data-focus="station:admin"] [data-lamp="datadog"]') as Element;
    expect(hlt.getAttribute("class")).toContain("unk");
    expect(text(container, '[data-focus="station:admin"]')).toContain("none");
    // Not needed is muted, not unknown.
    const pos = container.querySelector('[data-focus="station:pos"] [data-lamp="datadog"]') as Element;
    expect(pos.getAttribute("class")).not.toContain("unk");
  });

  it("reads 'not read' on every station and cable when the Sentry read failed, and keeps the cached alarms", () => {
    const { container } = mount({ board: boardOf({ sentryRead: false }) });
    const stations = q(container, '[data-focus^="station:"]').filter((s) => s.getAttribute("data-focus") !== "station:erp");
    for (const s of stations) {
      const alarms = s.querySelector("text.sv");
      expect(alarms?.textContent, s.getAttribute("data-focus") ?? "").toBe("not read");
    }
    // The fixture's retained issues keep their pins and c3 keeps 3 faults.
    expect(q(container, ".pin")).toHaveLength(5);
    expect(text(container, '[data-cable-tag="c3"]')).toContain("3 faults");
    for (const id of ["c1", "c2", "c4"]) {
      const tag = text(container, `[data-cable-tag="${id}"]`);
      expect(tag, id).toContain("not read");
      expect(tag, id).not.toContain("no faults");
    }
    expect(container.querySelector('[data-cable-tag="c1"] [data-state="not-read"]')?.getAttribute("fill")).toBe("var(--color-stale)");
  });

  it("with nothing cached and the read failed, no cable says 'no faults'", () => {
    const { container } = mount({ board: boardOf({ sentryRead: false, noIssues: true }) });
    expect(q(container, ".pin")).toHaveLength(0);
    for (const id of ["c1", "c2", "c3", "c4"]) {
      const tag = text(container, `[data-cable-tag="${id}"]`);
      expect(tag, id).toContain("not read");
      expect(tag, id).not.toContain("no faults");
    }
    expect(container.textContent).not.toMatch(/\b0 faults/);
  });

  it("says 'not read' in Arabic too", () => {
    const { container } = mount({ board: boardOf({ sentryRead: false, noIssues: true }) }, "ar");
    expect(text(container, '[data-cable-tag="c1"]')).toContain("مش مقروء");
  });

  it("shows a missing figure as 'no data', never 0", () => {
    const { container } = mount({
      board: boardOf({
        mutate: (b) => {
          const core = b.stations.find((s) => s.id === "core")!;
          core.readings = { ...core.readings, tasks: null, ci7d: null };
        },
      }),
    });
    const core = text(container, '[data-focus="station:core"]');
    expect(core.match(/no data/g)?.length).toBe(2);
  });
});

describe("pins and selection", () => {
  it("draws no pin for an unlocated alarm, and plays nothing for a station-less event", async () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const board = boardOf({
      mutate: (b) => {
        b.alarms.push({ id: "u1", kind: "monitor", source: "Datadog", station: null, at: "unlocated", title: "CPU high", message: "m", since: null, link: null });
      },
    });
    const orphan = event(1, { kind: "monitor", station: null, alarmId: "u1" });
    const { container, p } = mount({ board, paused: false, replaying: true, replayQueue: [orphan], events: [orphan] });
    expect(q(container, ".pin")).toHaveLength(5);
    expect(container.querySelector('[data-focus="pin:u1"]')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(raf).not.toHaveBeenCalled();
    // Skipped, not played: the replay still ends.
    expect(p.onReplayDone).toHaveBeenCalledTimes(1);
  });

  it("opens the detail with Enter (by key) and click (by mouse) on a pin, a station and a server", () => {
    const { container, p } = mount();
    const onSelect = p.onSelect as ReturnType<typeof vi.fn>;
    const pin = container.querySelector('[data-focus="pin:sentry-10001"]') as Element;
    fireEvent.keyDown(pin, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith({ type: "alarm", id: "sentry-10001" }, true);
    fireEvent.click(pin);
    expect(onSelect).toHaveBeenLastCalledWith({ type: "alarm", id: "sentry-10001" }, false);
    fireEvent.keyDown(container.querySelector('[data-focus="station:core"]') as Element, { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith({ type: "station", id: "core" }, true);
    fireEvent.keyDown(container.querySelector('[data-focus="host:lab-01"]') as Element, { key: " " });
    expect(onSelect).toHaveBeenLastCalledWith({ type: "host", id: "lab-01" }, true);
  });

  it("dims what is unrelated to a selected alarm and marks its pin", () => {
    const { container } = mount({ selection: { type: "alarm", id: "sentry-10001" } });
    const cls = (id: string) => container.querySelector(`path.cable[data-cable="${id}"]`)?.getAttribute("class") ?? "";
    expect(cls("c3")).not.toContain("dim");
    expect(cls("c1")).toContain("dim");
    // The failing hop (Backend-Core) stays lit with the reporting Connector.
    expect(container.querySelector('[data-focus="station:core"]')?.getAttribute("class")).not.toContain("dim");
    expect(container.querySelector('[data-focus="station:erp"]')?.getAttribute("class")).toContain("dim");
    expect(container.querySelector('[data-focus="pin:sentry-10001"]')?.getAttribute("class")).toContain("on");
    expect(container.querySelector('[data-focus="station:pos"]')?.getAttribute("class")).toContain("dim");
    expect(container.querySelector('[data-focus="station:conn"]')?.getAttribute("class")).not.toContain("dim");
  });

  it("treats a selection whose alarm is gone as no selection, without throwing", () => {
    expect(() => mount({ selection: { type: "alarm", id: "example-latency" } })).not.toThrow();
    cleanup();
    const { container } = mount({ selection: { type: "host", id: "lab-99" } });
    expect(q(container, ".dim")).toHaveLength(0);
  });

  it("survives a language switch and the example alarm being turned off while it is open", () => {
    const demoBoard = buildBoard(fixture(), { now: NOW, demo: true });
    const view = mount({ board: demoBoard, selection: { type: "alarm", id: "example-latency" } });
    expect(view.container.querySelector('[data-focus="pin:example-latency"]')).not.toBeNull();
    expect(() => view.again({ board: boardOf() })).not.toThrow();
    expect(view.container.querySelector('[data-focus="pin:example-latency"]')).toBeNull();
    cleanup();
    expect(() => mount({ board: demoBoard, selection: { type: "alarm", id: "example-latency" } }, "ar")).not.toThrow();
  });
});

describe("risers", () => {
  it("run at 180 / activity seconds, and no dots without activity", () => {
    const board = boardOf({ mutate: (b) => { b.stations.find((s) => s.id === "admin")!.activity7d = 0; } });
    const { container } = mount({ board });
    for (const s of board.stations) {
      const el = container.querySelector(`[data-riser-current="${s.id}"]`) as SVGElement | null;
      if (s.id === "erp" || s.id === "admin") {
        expect(el, s.id).toBeNull();
        continue;
      }
      expect(el?.style.animationDuration, s.id).toBe(`${(180 / s.activity7d).toFixed(2)}s`);
    }
    // POS: 50 runs plus its merges this week.
    const pos = board.stations.find((s) => s.id === "pos")!;
    expect(pos.activity7d).toBeGreaterThan(0);
  });
});

describe("Arabic", () => {
  it("keeps the diagram left to right and sets Arabic text right to left with a mirrored anchor", () => {
    const { container } = mount({}, "ar");
    expect(container.querySelector("svg.grid")).not.toBeNull();
    const title = q(container, "text").find((t) => t.textContent === "غرفة التحكم: Port بيقرا من")!;
    expect(title.getAttribute("direction")).toBe("rtl");
    expect(title.getAttribute("text-anchor")).toBe("end");
    const latin = q(container, "text").find((t) => t.textContent === "POS")!;
    expect(latin.getAttribute("direction")).toBeNull();
  });
});

describe("motion", () => {
  const settle = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const fxDots = (c: ParentNode) => q(c, "[data-fx-layer] circle");
  const added = (c: ParentNode) => {
    const seen = { n: 0 };
    new MutationObserver((records) => {
      for (const r of records) seen.n += r.addedNodes.length;
    }).observe(c.querySelector("[data-fx-layer]") as Node, { childList: true });
    return seen;
  };

  it("requests no animation frame while paused, and holds the replay", async () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const queue = [event(1), event(2)];
    const { p } = mount({ paused: true, replaying: true, replayQueue: queue, events: queue });
    await settle(20_000);
    expect(raf).not.toHaveBeenCalled();
    expect(p.onReplayDone).not.toHaveBeenCalled();
  });

  it("under reduced motion nothing animates and the replay ends at once", async () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const queue = [event(1), event(2)];
    const { p } = mount({ paused: false, reducedMotion: true, replaying: true, replayQueue: queue, events: queue });
    await settle(20_000);
    expect(raf).not.toHaveBeenCalled();
    expect(p.onReplayDone).toHaveBeenCalledTimes(1);
  });

  it("plays at most the newest 12 replayed events once, then calls onReplayDone once", async () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const queue = Array.from({ length: 15 }, (_, i) => event(i + 1));
    const { container, p } = mount({ paused: false, replaying: true, replayQueue: queue, events: queue });
    const dots = added(container);
    await settle(60_000);
    expect(dots.n).toBe(12);
    expect(p.onReplayDone).toHaveBeenCalledTimes(1);
    await settle(60_000);
    expect(dots.n).toBe(12);
    expect(p.onReplayDone).toHaveBeenCalledTimes(1);
  });

  it("Pause mid-flight removes the dot and never dims ERPNext; Resume continues with the next event", async () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const refused = event(1, { kind: "alarm", station: "conn", alarmId: "sentry-10003" });
    const next = event(2);
    const queue = [refused, next];
    const { container, p, again } = mount({ paused: false, replaying: true, replayQueue: queue, events: queue });
    await settle(1_000);
    expect(fxDots(container).length).toBe(1);
    again({ paused: true });
    expect(fxDots(container)).toHaveLength(0);
    await settle(8_000);
    expect(container.querySelector('[data-fx-station="erp"]')?.classList.contains("down")).toBe(false);
    expect(fxDots(container)).toHaveLength(0);
    expect(p.onReplayDone).not.toHaveBeenCalled();
    again({ paused: false });
    await settle(500);
    expect(fxDots(container).length).toBe(1);
    await settle(5_000);
    // The cancelled event is not played again: only the merge came down.
    expect(container.querySelector('[data-fx-station="erp"]')?.classList.contains("down")).toBe(false);
    expect(p.onReplayDone).toHaveBeenCalledTimes(1);
  });

  it("animates a real change that arrives between polls once, not what was there at the start", async () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    const old = event(1, { replay: false });
    const { container, again } = mount({ paused: false, events: [old] });
    const dots = added(container);
    await settle(5_000);
    expect(dots.n).toBe(0);
    const fresh = event(2, { replay: false, station: "core", kind: "deploy" });
    again({ events: [fresh, old] });
    await settle(5_000);
    expect(dots.n).toBe(1);
    again({ events: [fresh, old] });
    await settle(5_000);
    expect(dots.n).toBe(1);
  });
});
