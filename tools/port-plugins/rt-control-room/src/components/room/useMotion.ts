import { useEffect, useRef, useState } from "react";
import { isCableId } from "../../model/architecture";
import type { Board } from "../../model/types";
import type { BoardEvent } from "../../state/diff";
import { playBusEvent, playGesture, type GestureRefs } from "./gestures";
import type { RoomLayout } from "./geometry";
import { MotionRunner, type PlayItem } from "./motion";

export type FxAccess = Pick<GestureRefs, "fx" | "wrap" | "cableWrap" | "gate">;

function readReduced(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * True when the system asks for reduced motion. Unlike Pause it cannot be
 * lifted from the page. `override` is for tests and hosts that know better.
 */
export function useReducedMotion(override?: boolean): boolean {
  const [system, setSystem] = useState(readReduced);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystem(query.matches);
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return override ?? system;
}

const COLOR: Partial<Record<BoardEvent["kind"], string>> = {
  merge: "var(--color-cool)",
  deploy: "var(--color-cool)",
  jira: "var(--color-cool)",
  ci: "var(--color-ok)",
};

type Args = {
  board: Board;
  events: BoardEvent[];
  replayQueue: BoardEvent[];
  replaying: boolean;
  /** Pause, reduced motion or a hidden tile: no gesture runs and none is started. */
  still: boolean;
  reducedMotion: boolean;
  layout: RoomLayout;
  fx: FxAccess;
  onReplayDone: () => void;
};

/**
 * Drives the diagram's motion: the capped 24 h replay (once, oldest first) and
 * the changes between polls (once each). Everything runs through one
 * MotionRunner, so Pause cancels the gesture in flight and Resume goes on with
 * the next event. Hooks only; the runner holds the logic.
 */
export function useMotion(args: Args): void {
  const latest = useRef(args);
  latest.current = args;
  const seen = useRef<Set<string> | null>(null);
  const replayStarted = useRef(false);

  const [runner] = useState(
    () =>
      new MotionRunner(
        (item, end) => playItem(latest.current, item, end),
        () => latest.current.onReplayDone(),
      ),
  );

  const { still, events, replayQueue, replaying, reducedMotion } = args;

  useEffect(() => {
    runner.setStill(still);
    // Cleanup cancels the gesture in flight (unmount, or a strict-mode remount).
    return () => runner.setStill(true);
  }, [runner, still]);

  useEffect(() => {
    if (seen.current === null) {
      // What is on the board when it first shows is the baseline, never a change.
      seen.current = new Set([...events, ...replayQueue].map((e) => e.id));
    } else {
      const fresh = events.filter((e) => !e.replay && !seen.current?.has(e.id));
      fresh.forEach((e) => seen.current?.add(e.id));
      // A change that arrives while the board is still is not played later.
      if (fresh.length > 0 && !latest.current.still) runner.enqueueLive(fresh.slice().reverse());
    }
    if (replaying && !replayStarted.current) {
      replayStarted.current = true;
      replayQueue.forEach((e) => seen.current?.add(e.id));
      // Reduced motion shows a still board: the replay ends at once, nothing plays.
      runner.startReplay(reducedMotion ? [] : replayQueue);
    }
  }, [runner, events, replayQueue, replaying, reducedMotion]);
}

function playItem(args: Args, item: PlayItem, end: () => void) {
  const { board, layout, fx } = args;
  const e = item.event;
  const opts = { paused: false, reducedMotion: false, onEnd: end };
  // An event with no station (an unlocated monitor) is listed, never animated.
  if (e.kind === "alarm" || e.kind === "monitor") {
    const alarm = board.alarms.find((a) => a.id === e.alarmId);
    if (!alarm || alarm.station === null) return null;
    const cable = isCableId(alarm.at) ? alarm.at : null;
    return playGesture(alarm.kind, { layout, ...fx, station: alarm.station, cable }, opts);
  }
  if (e.station === null) return null;
  const source = e.kind === "jira" ? "jira" : "github";
  return playBusEvent(source, COLOR[e.kind] ?? "var(--color-cool)", { layout, ...fx, station: e.station, cable: null }, opts);
}
