import type { AlarmKind, CableId, SourceId, StationId } from "../../model/types";
import { busRoute, type RoomLayout } from "./geometry";
import { pointAt, reversed, type Curve } from "./path";

// One gesture per alarm kind (spec section 5). Rules every gesture keeps:
//  - nothing starts when paused, under reduced motion or with no station, and no
//    animation frame is requested then;
//  - every class change inside a gesture is at least 500 ms from the next (a
//    dot only moves; fades are one class plus a CSS transition);
//  - cancel() removes the moving dot and every class it added and never runs the
//    completion effect (so a cancelled 502 never dims ERPNext).
// Gestures only touch the `fx` layer and wrapper elements React never styles.

export type Scheduler = {
  raf(cb: () => void): number;
  caf(id: number): void;
  now(): number;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
};

/** The real clock. Globals are read at call time so fake timers and spies installed later still apply. */
export const browserScheduler: Scheduler = {
  raf: (cb) => window.requestAnimationFrame(() => cb()),
  caf: (id) => window.cancelAnimationFrame(id),
  now: () => performance.now(),
  setTimeout: (cb, ms) => window.setTimeout(cb, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

export type GestureRefs = {
  layout: RoomLayout;
  /** The layer gestures draw into; React renders no children in it. */
  fx: Element | null;
  /** Wrapper element of a station (no React-owned class). */
  wrap(station: StationId): Element | null;
  cableWrap(cable: CableId): Element | null;
  gate(cable: CableId): Element | null;
  /** Where the gesture happens: the alarm's station and, when it sits on a cable, that cable. */
  station: StationId;
  cable: CableId | null;
};

export type GestureOpts = {
  paused: boolean;
  reducedMotion: boolean;
  scheduler?: Scheduler;
  /** `true` when the gesture ran to its end, `false` when it was skipped. Not called after cancel(). */
  onEnd?: (completed: boolean) => void;
};

export type Handle = { cancel(): void };
const NOOP: Handle = { cancel: () => {} };

const SOURCE_OF: Record<AlarmKind, SourceId> = {
  refused: "sentry",
  down: "sentry",
  timeout: "sentry",
  reset: "sentry",
  bug: "sentry",
  latency: "datadog",
  nodata: "datadog",
  monitor: "datadog",
};

const BAD = "var(--color-bad)";
const NS = "http://www.w3.org/2000/svg";

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Timers, frames and undo steps of one gesture, all released by cancel(). */
class Timeline {
  private dead = false;
  private timers = new Set<number>();
  private frames = new Set<number>();
  private undo: (() => void)[] = [];
  constructor(readonly sched: Scheduler) {}

  get cancelled(): boolean {
    return this.dead;
  }
  after(ms: number, fn: () => void): void {
    const id = this.sched.setTimeout(() => {
      this.timers.delete(id);
      if (!this.dead) fn();
    }, ms);
    this.timers.add(id);
  }
  /** Calls `update(k)` each frame for `ms`, then `end`. */
  animate(ms: number, update: (k: number) => void, end: () => void): void {
    const start = this.sched.now();
    const step = (): void => {
      this.frames.delete(id);
      if (this.dead) return;
      const k = Math.min(1, (this.sched.now() - start) / ms);
      update(k);
      if (k < 1) {
        id = this.sched.raf(step);
        this.frames.add(id);
      } else end();
    };
    let id = this.sched.raf(step);
    this.frames.add(id);
  }
  onCancel(fn: () => void): void {
    this.undo.push(fn);
  }
  cancel(): void {
    if (this.dead) return;
    this.dead = true;
    this.timers.forEach((t) => this.sched.clearTimeout(t));
    this.frames.forEach((f) => this.sched.caf(f));
    this.undo.forEach((fn) => fn());
    this.undo = [];
  }
}

/** Adds a class for `ms`, then removes it. Cancel removes it at once. */
function hold(tl: Timeline, el: Element | null, cls: string, ms: number, then?: () => void): void {
  if (!el) {
    then?.();
    return;
  }
  el.classList.add(cls);
  tl.onCancel(() => el.classList.remove(cls));
  tl.after(ms, () => {
    el.classList.remove(cls);
    then?.();
  });
}

type DotOpts = { color: string; dur: number; r?: number; map?: (k: number) => number; fading?: boolean };

function dot(tl: Timeline, fx: Element, curve: Curve, opts: DotOpts, end: () => void): void {
  const c = svg("circle", { r: opts.r ?? 5, fill: opts.color, class: opts.fading ? "fx-dot fading" : "fx-dot" });
  fx.appendChild(c);
  tl.onCancel(() => c.remove());
  const place = (k: number): void => {
    const p = pointAt(curve, opts.map ? opts.map(k) : k);
    c.setAttribute("cx", p.x.toFixed(1));
    c.setAttribute("cy", p.y.toFixed(1));
  };
  place(0);
  tl.animate(opts.dur, place, () => {
    c.remove();
    end();
  });
}

const join = (n: number, fn: () => void) => {
  let left = n;
  return (): void => {
    left -= 1;
    if (left === 0) fn();
  };
};

/** A small dot from a station up its riser to a source (`up`) or the other way (`down`). */
function busDot(tl: Timeline, refs: GestureRefs, source: SourceId, color: string, dir: "up" | "down", end: () => void) {
  const route = busRoute(refs.layout, refs.station, source);
  if (!route || !refs.fx) return end();
  dot(tl, refs.fx, dir === "up" ? route : reversed(route), { color, dur: dir === "up" ? 1300 : 1400, r: 4 }, end);
}

/** A flash over the station itself: the gesture of a fault with no cable to blame. */
function ring(tl: Timeline, refs: GestureRefs, end: () => void): void {
  const box = refs.layout.stations[refs.station];
  if (!refs.fx || !box) return end();
  const r = svg("rect", { x: box.x, y: box.y, width: box.w, height: box.h, rx: 10, fill: "none", stroke: BAD, "stroke-width": 3, class: "scan" });
  refs.fx.appendChild(r);
  tl.onCancel(() => r.remove());
  tl.after(900, () => {
    r.remove();
    end();
  });
}

function scanLine(tl: Timeline, refs: GestureRefs, end: () => void): void {
  const box = refs.layout.stations[refs.station];
  if (!refs.fx || !box) return end();
  const line = svg("rect", { x: box.x + 2, y: box.y, width: box.w - 4, height: 2, class: "scan" });
  refs.fx.appendChild(line);
  tl.onCancel(() => line.remove());
  tl.animate(
    700,
    (k) => line.setAttribute("y", String(box.y + k * (box.h - 2))),
    () => {
      line.remove();
      end();
    },
  );
}

const bounce = (k: number): number => (k < 0.5 ? k * 2 * 0.85 : 0.85 * (1 - (k - 0.5) * 2));
const stall = (k: number): number => Math.min(0.55, 1 - Math.pow(1 - k, 3));

function run(kind: AlarmKind, tl: Timeline, refs: GestureRefs, finish: () => void): void {
  const source = SOURCE_OF[kind];
  const up = (end: () => void) => busDot(tl, refs, source, BAD, "up", end);
  const cable = refs.cable ? refs.layout.cables.find((c) => c.id === refs.cable) : undefined;
  const fx = refs.fx as Element;

  // A cable fault travels the cable; a fault inside a station flashes the station.
  if (!cable && (kind === "refused" || kind === "timeout" || kind === "down" || kind === "reset")) {
    return ring(tl, refs, () => up(finish));
  }
  switch (kind) {
    case "refused": {
      const gate = refs.gate(cable!.id);
      tl.after(900, () => hold(tl, gate, "on", 900));
      return dot(tl, fx, cable!.curve, { color: BAD, dur: 1800, map: bounce }, () => up(finish));
    }
    case "timeout":
      return dot(tl, fx, cable!.curve, { color: BAD, dur: 2400, map: stall, fading: true }, () => up(finish));
    case "down":
      return dot(tl, fx, cable!.curve, { color: BAD, dur: 1300 }, () => {
        const done = join(2, finish);
        hold(tl, refs.wrap(cable!.to), "down", 1600, done);
        up(done);
      });
    case "reset": {
      const done = join(2, finish);
      hold(tl, refs.cableWrap(cable!.id), "gap", 1000, done);
      return up(done);
    }
    case "bug":
      return scanLine(tl, refs, () => up(finish));
    case "latency":
      return ring(tl, refs, () => up(finish));
    default:
      // nodata and monitor: the station's lamp and halo already show the state; only the signal goes up.
      return up(finish);
  }
}

/** Plays the gesture of one alarm kind. Returns a handle whose cancel() undoes it without a completion effect. */
export function playGesture(kind: AlarmKind, refs: GestureRefs, opts: GestureOpts): Handle {
  if (opts.paused || opts.reducedMotion || !refs.station || !refs.fx) {
    opts.onEnd?.(false);
    return NOOP;
  }
  const tl = new Timeline(opts.scheduler ?? browserScheduler);
  run(kind, tl, refs, () => opts.onEnd?.(true));
  return { cancel: () => tl.cancel() };
}

/** A change from a source (merge, CI, Jira, deploy): a dot comes down from the bus to the station. */
export function playBusEvent(
  source: SourceId,
  color: string,
  refs: GestureRefs,
  opts: GestureOpts,
): Handle {
  if (opts.paused || opts.reducedMotion || !refs.station || !refs.fx) {
    opts.onEnd?.(false);
    return NOOP;
  }
  const tl = new Timeline(opts.scheduler ?? browserScheduler);
  busDot(tl, refs, source, color, "down", () => opts.onEnd?.(true));
  return { cancel: () => tl.cancel() };
}
