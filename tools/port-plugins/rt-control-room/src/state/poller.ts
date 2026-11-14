import type { PortClient } from "../api/portClient";
import { buildBoard } from "../model/board";
import type { Board, Collection, Snapshot } from "../model/types";
import { EVENT_LIMIT } from "./blueprints";
import { diffBoards, type BoardEvent } from "./diff";
import { diffSnapshots, replayEvents } from "./events";
import { fetchSnapshot } from "./fetchSnapshot";
import { emptySnapshot, mergeSnapshot } from "./merge";
import { nextPoll, type ScheduleState } from "./schedule";

/** Collections that are fetched as a delta once they have been read. */
const DELTA_COLLECTIONS: Collection[] = ["sentryIssues", "monitors", "jira", "prs", "runs", "deployments"];

/** Mutable bookkeeping of the polling loop. Lives in a ref; React never reads it directly. */
export type PollerState = ScheduleState & {
  snapshot: Snapshot | null;
  /** The board the previous poll built (alarm diffs). Null until a board exists. */
  board: Board | null;
  /** Start of the latest poll that read each collection successfully. Its keys are the "ever read" set. */
  lastOk: Partial<Record<Collection, string>>;
  events: BoardEvent[];
  /** The 24 h replay, oldest first, set once when the first board is built. */
  replayQueue: BoardEvent[];
};

export const createPollerState = (): PollerState => ({
  polls: 0,
  lastAt: null,
  snapshot: null,
  board: null,
  lastOk: {},
  events: [],
  replayQueue: [],
});

/** Immutable outcome of one poll, the value React Query caches. */
export type PollResult = {
  /** False until at least one collection has been read: then there is no board to show. */
  hasData: boolean;
  snapshot: Snapshot | null;
  /** Poll start, in ms. The board is built "as of" this instant. */
  now: number;
  /** false when `sentryIssues` was never read or the latest read failed. */
  alarmRead: { sentry: boolean };
  /** Collections whose latest read failed or was incomplete. */
  failed: Collection[];
  errorStatus: number | null;
  /** Newest first, capped at EVENT_LIMIT. */
  events: BoardEvent[];
  /** Replay events, oldest first (the order they play in). */
  replayQueue: BoardEvent[];
  /** Poll sequence number (1 = first load). */
  seq: number;
};

const newestFirst = (a: BoardEvent, b: BoardEvent): number => Date.parse(b.at) - Date.parse(a.at);

/** The oldest `lastOk` of the delta collections, or null when none has been read. */
function sinceOf(lastOk: PollerState["lastOk"]): string | null {
  const stamps = DELTA_COLLECTIONS.map((c) => lastOk[c]).filter((s): s is string => s !== undefined);
  return stamps.length === 0 ? null : stamps.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
}

/**
 * One poll. Reads what is scheduled, folds it into the cached snapshot, builds
 * the board and works out the events. A collection that has never been read
 * gets a full or window fetch (never a delta), so a partial first load heals.
 * `since` is the oldest successful read of any delta collection, so a failed
 * interval is covered again by the next delta (the merge is by `identifier`,
 * so the overlap is harmless). A failed read never removes anything.
 */
export async function runPoll(client: PortClient, state: PollerState, now: Date): Promise<PollResult> {
  const { full } = nextPoll(state, now.getTime());
  const neverRead = new Set(
    (["services", "workloads", "hosts", "integrations", ...DELTA_COLLECTIONS] as Collection[]).filter(
      (c) => state.lastOk[c] === undefined,
    ),
  );
  const res = await fetchSnapshot(client, sinceOf(state.lastOk), full, { now, neverRead });

  const read = (Object.keys(res.data) as (keyof Snapshot)[]).filter(
    (k): k is Collection => k !== "fetchedAt",
  );
  const baseline = new Set(read.filter((c) => neverRead.has(c)));
  for (const c of read) state.lastOk[c] = now.toISOString();
  state.polls += 1;
  state.lastAt = now.getTime();

  const everRead = Object.keys(state.lastOk).length > 0;
  const alarmRead = { sentry: state.lastOk.sentryIssues !== undefined && !res.failed.includes("sentryIssues") };
  const base = {
    alarmRead,
    failed: res.failed,
    errorStatus: res.errorStatus,
    now: now.getTime(),
    seq: state.polls,
  };
  if (!everRead) {
    return { ...base, hasData: false, snapshot: null, events: state.events, replayQueue: state.replayQueue };
  }

  const prevSnapshot = state.snapshot;
  const snapshot = mergeSnapshot(prevSnapshot ?? emptySnapshot(now.toISOString()), res.data, res.replace);
  const board = buildBoard(snapshot, { now, demo: false, alarmRead });

  let fresh: BoardEvent[];
  if (state.board === null || prevSnapshot === null) {
    state.replayQueue = replayEvents(snapshot, now).reverse();
    fresh = state.replayQueue;
  } else {
    const opts = { baseline, at: now.toISOString() };
    fresh = [...diffBoards(state.board, board, opts), ...diffSnapshots(prevSnapshot, snapshot, opts)];
  }
  const known = new Set(state.events.map((e) => e.id));
  state.events = [...fresh.filter((e) => !known.has(e.id)), ...state.events]
    .sort(newestFirst)
    .slice(0, EVENT_LIMIT);
  state.snapshot = snapshot;
  state.board = board;

  return { ...base, hasData: true, snapshot, events: state.events, replayQueue: state.replayQueue };
}
