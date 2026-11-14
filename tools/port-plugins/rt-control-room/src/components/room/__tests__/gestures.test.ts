import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlarmKind, CableId, StationId } from "../../../model/types";
import { playBusEvent, playGesture, type GestureRefs } from "../gestures";
import { cx, layoutRoom, layoutStations } from "../geometry";
import { MotionRunner, GAP_MS, REPLAY_CAP, type Player } from "../motion";
import { pointAt } from "../path";
import type { BoardEvent } from "../../../state/diff";

const NS = "http://www.w3.org/2000/svg";
const layout = layoutRoom();
const FAKE = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance", "requestAnimationFrame", "cancelAnimationFrame"] as const;

type Rig = { refs: (station: StationId, cable: CableId | null) => GestureRefs; fx: Element; root: Element };

function rig(): Rig {
  const root = document.createElementNS(NS, "svg");
  const fx = document.createElementNS(NS, "g");
  const wraps = new Map<string, Element>();
  const make = (key: string): Element => {
    const g = document.createElementNS(NS, "g");
    wraps.set(key, g);
    root.appendChild(g);
    return g;
  };
  (Object.keys(layout.stations) as StationId[]).forEach((id) => make(`s:${id}`));
  layout.cables.forEach((c) => {
    make(`c:${c.id}`);
    make(`g:${c.id}`);
  });
  root.appendChild(fx);
  document.body.replaceChildren(root);
  return {
    fx,
    root,
    refs: (station, cable) => ({
      layout,
      fx,
      station,
      cable,
      wrap: (id) => wraps.get(`s:${id}`) ?? null,
      cableWrap: (id) => wraps.get(`c:${id}`) ?? null,
      gate: (id) => wraps.get(`g:${id}`) ?? null,
    }),
  };
}

const step = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("geometry", () => {
  it("places the five stations on tier columns without overlap", () => {
    const s = layout.stations;
    expect(s.pos.x).toBe(30);
    expect(s.core.x).toBe(400);
    expect(s.conn.x).toBe(760);
    expect(s.erp.x).toBe(1118);
    expect(s.pos.y + s.pos.h).toBeLessThan(s.admin.y);
    expect(layout.hosts.map((h) => h.x)).toEqual([300, 550, 1005]);
  });

  it("places a fifth station of an existing tier from data, without overlap", () => {
    const placed = layoutStations([
      { id: "a", tier: "front" },
      { id: "b", tier: "front" },
      { id: "c", tier: "front" },
      { id: "d", tier: "core" },
    ]);
    const front = [placed.a, placed.b, placed.c].sort((p, q) => p.y - q.y);
    expect(front[0].y + front[0].h).toBeLessThan(front[1].y);
    expect(front[1].y + front[1].h).toBeLessThan(front[2].y);
    expect(front[0].x).toBe(front[2].x);
    expect(placed.d.x).toBe(400);
  });

  it("evaluates points on paths without SVG geometry", () => {
    const c4 = layout.cables.find((c) => c.id === "c4")!;
    expect(pointAt(c4.curve, 0).x).toBe(layout.stations.conn.x + layout.stations.conn.w);
    expect(pointAt(c4.curve, 1).x).toBe(layout.stations.erp.x);
    const riser = layout.risers.find((r) => r.station === "core")!;
    expect(pointAt(riser.curve, 1).x).toBe(cx(layout.stations.core));
  });
});

describe("gestures", () => {
  it("never changes a class or opacity faster than every 500 ms, for every kind", async () => {
    const kinds: AlarmKind[] = ["refused", "down", "timeout", "reset", "bug", "latency", "nodata", "monitor"];
    for (const kind of kinds) {
      const r = rig();
      const marks: number[] = [];
      const observer = new MutationObserver((records) => {
        for (const rec of records) if (rec.type === "attributes") marks.push(Date.now());
      });
      observer.observe(r.root, { attributes: true, attributeFilter: ["class", "opacity"], subtree: true });
      const end = vi.fn();
      playGesture(kind, r.refs("conn", "c4"), { paused: false, reducedMotion: false, onEnd: end });
      for (let t = 0; t < 8000; t += 50) await step(50);
      observer.disconnect();
      expect(end, kind).toHaveBeenCalledWith(true);
      // The class-toggling kinds really were observed (the check is not vacuous).
      expect(marks.length, `${kind} class changes`).toBe({ refused: 2, down: 2, reset: 2 }[kind as string] ?? 0);
      marks.sort((a, b) => a - b);
      for (let i = 1; i < marks.length; i += 1) expect(marks[i] - marks[i - 1], kind).toBeGreaterThanOrEqual(500);
      expect(r.fx.childNodes.length, `${kind} leaves nothing in the fx layer`).toBe(0);
    }
  });

  it("fades the timeout dot with one class, not per-frame opacity", async () => {
    const r = rig();
    playGesture("timeout", r.refs("conn", "c4"), { paused: false, reducedMotion: false });
    await step(400);
    const dot = r.fx.querySelector("circle");
    expect(dot?.getAttribute("class")).toContain("fading");
    expect(dot?.hasAttribute("opacity")).toBe(false);
  });

  it("requests no animation frame when paused, reduced, or with no station", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const r = rig();
    const end = vi.fn();
    playGesture("down", r.refs("conn", "c4"), { paused: true, reducedMotion: false, onEnd: end });
    playGesture("down", r.refs("conn", "c4"), { paused: false, reducedMotion: true, onEnd: end });
    playBusEvent("github", "red", { ...r.refs("pos", null), station: undefined as unknown as StationId }, { paused: false, reducedMotion: false, onEnd: end });
    expect(raf).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(3);
    expect(end).toHaveBeenCalledWith(false);
    expect(r.fx.childNodes.length).toBe(0);
  });

  it("cancelled mid-flight: the dot goes, and ERPNext never dims", async () => {
    const r = rig();
    const end = vi.fn();
    const erp = r.root.querySelector("g") as Element;
    const wrap = r.refs("conn", "c4").wrap("erp") as Element;
    const h = playGesture("down", r.refs("conn", "c4"), { paused: false, reducedMotion: false, onEnd: end });
    await step(700);
    expect(r.fx.querySelector("circle")).not.toBeNull();
    h.cancel();
    expect(r.fx.querySelector("circle")).toBeNull();
    await step(6000);
    expect(wrap.classList.contains("down")).toBe(false);
    expect(end).not.toHaveBeenCalled();
    expect(erp).toBeTruthy();
  });

  it("cancelled while ERPNext is dimmed: it comes back at once", async () => {
    const r = rig();
    const wrap = r.refs("conn", "c4").wrap("erp") as Element;
    const h = playGesture("down", r.refs("conn", "c4"), { paused: false, reducedMotion: false });
    await step(1500);
    expect(wrap.classList.contains("down")).toBe(true);
    h.cancel();
    expect(wrap.classList.contains("down")).toBe(false);
  });

  it("a 502 on the Postings cable c3 dims Backend-Core (the failing hop), never the Connector or ERPNext", async () => {
    const r = rig();
    const refs = r.refs("conn", "c3");
    playGesture("down", refs, { paused: false, reducedMotion: false });
    await step(1500);
    expect(refs.wrap("core")?.classList.contains("down")).toBe(true);
    expect(refs.wrap("conn")?.classList.contains("down")).toBe(false);
    expect(refs.wrap("erp")?.classList.contains("down")).toBe(false);
  });

  it("puts each cable's refused gate at the route owner's end: Backend-Core for c3, the far end otherwise", () => {
    const gate = (id: string) => layout.cables.find((c) => c.id === id)!.gate.x;
    const core = layout.stations.core;
    expect(gate("c3")).toBe(core.x + core.w + 18);
    expect(gate("c4")).toBe(layout.stations.erp.x - 18);
    expect(gate("c1")).toBe(core.x - 18);
  });

  it("the c3 dot travels from the Connector toward Backend-Core (the request's direction)", async () => {
    const r = rig();
    playGesture("down", r.refs("conn", "c3"), { paused: false, reducedMotion: false });
    await step(100);
    const dot = r.fx.querySelector("circle") as Element;
    const conn = layout.stations.conn;
    // It starts at the Connector's end of the cable, not at Backend-Core's.
    expect(Number(dot.getAttribute("cx"))).toBeGreaterThan(conn.x - 60);
  });

  it("flashes the station itself when a cable kind has no cable", async () => {
    const r = rig();
    const end = vi.fn();
    playGesture("reset", r.refs("conn", null), { paused: false, reducedMotion: false, onEnd: end });
    await step(300);
    expect(r.fx.querySelector("rect")).not.toBeNull();
    await step(4000);
    expect(end).toHaveBeenCalledWith(true);
  });
});

describe("MotionRunner", () => {
  const ev = (n: number): BoardEvent => ({
    id: `e${n}`,
    at: new Date(2026, 10, 13, 10, n).toISOString(),
    kind: "merge",
    station: "pos",
    text: { en: `e${n}`, ar: `e${n}` },
  });

  function runner() {
    const played: string[] = [];
    const ends = new Map<string, () => void>();
    const player: Player = (item, end) => {
      played.push(item.event.id);
      ends.set(item.event.id, end);
      return { cancel: () => ends.delete(item.event.id) };
    };
    const done = vi.fn();
    return { r: new MotionRunner(player, done), played, ends, done };
  }
  const finish = async (ends: Map<string, () => void>, id: string) => {
    ends.get(id)?.();
    await step(GAP_MS + 10);
  };

  it("plays only the newest 12 of a longer replay, oldest first, and ends once", async () => {
    const { r, played, ends, done } = runner();
    r.setStill(false);
    r.startReplay(Array.from({ length: 15 }, (_, i) => ev(i + 1)));
    await step(400);
    for (let i = 0; i < REPLAY_CAP; i += 1) await finish(ends, played[i]);
    expect(played).toEqual(Array.from({ length: REPLAY_CAP }, (_, i) => `e${i + 4}`));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("skips an item that cannot play without a pause and still ends the replay", async () => {
    const done = vi.fn();
    const r = new MotionRunner(() => null, done);
    r.setStill(false);
    r.startReplay([ev(1), ev(2)]);
    await step(400);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("an empty replay ends at once", () => {
    const { r, done } = runner();
    r.startReplay([]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("pause consumes the event in flight and resume continues with the next", async () => {
    const { r, played, ends, done } = runner();
    r.setStill(false);
    r.startReplay([ev(1), ev(2), ev(3)]);
    await step(400);
    expect(played).toEqual(["e1"]);
    r.setStill(true);
    await step(5000);
    expect(played).toEqual(["e1"]);
    expect(done).not.toHaveBeenCalled();
    r.setStill(false);
    await step(400);
    expect(played).toEqual(["e1", "e2"]);
    await finish(ends, "e2");
    await finish(ends, "e3");
    expect(played).toEqual(["e1", "e2", "e3"]);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("a cancelled last event still ends the replay", async () => {
    const { r, done } = runner();
    r.setStill(false);
    r.startReplay([ev(1)]);
    await step(400);
    r.setStill(true);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
