import type { PortClient } from "../api/portClient";
import { buildBoard } from "../model/board";
import type { Board, Collection, Snapshot } from "../model/types";
import { EVENT_LIMIT, REPLAY_MS } from "./blueprints";
import { diffBoards, type BoardEvent } from "./diff";
import { diffSnapshots, replayEvents } from "./events";
import { fetchSnapshot } from "./fetchSnapshot";
import { emptySnapshot, mergeSnapshot } from "./merge";
import { nextPoll, type ScheduleState } from "./schedule";

/** Collections that are fetched as a delta once they have been read. */
const DELTA_COLLECTIONS: Collection[] = ["sentryIssues", "monitors", "jira", "prs", "runs", "deployments"];

/** Every collection of a snapshot. */
const ALL_COLLECTIONS: Collection[] = [
  "services",
  "workloads",
  "sentryIssues",
  "monitors",
  "hosts",
  "jira",
  "prs",
  "runs",
  "deployments",
  "integrations",
];

/** Mutable bookkeeping of the polling loop. Lives in a ref; React never reads it directly. */
export type PollerState = ScheduleState & PollHealth & {
  snapshot: Snapshot | null;
  /** The board the previous poll built (alarm diffs). Null until a board exists. */
  board: Board | null;
  /** Start of the latest poll that read each collection successfully. Its keys are the "ever read" set. */
  lastOk: Partial<Record<Collection, string>>;
  events: BoardEvent[];
  /** The 24 h replay, oldest first, set once when the first board is built. */
  replayQueue: BoardEvent[];
};

/** The state fields `ScheduleState` adds for freshness and back-off: they count good polls only. */
export type PollHealth = { okPolls: number; failures: number };

export const createPollerState = (): PollerState => ({
  polls: 0,
  lastAt: null,
  okPolls: 0,
  failures: 0,
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
  /** Collections that no poll has read successfully yet: what derives from them is "no data", never 0. */
  unread: Collection[];
  /** Collections whose latest read failed or was incomplete. */
  failed: Collection[];
  /** Optional collections Port refused (403) or does not have (404): "not available" to this widget, not a failure. */
  unavailable: Collection[];
  errorStatus: number | null;
  /** Newest first, capped at EVENT_LIMIT. */
  events: BoardEvent[];
  /** Replay events, oldest first (the order they play in). */
  replayQueue: BoardEvent[];
  /** Poll sequence number (1 = first load). */
  seq: number;
};

const newestFirst = (a: BoardEvent, b: BoardEvent): number => Date.parse(b.at) - Date.parse(a.at);

/**
 * Each delta collection reads from its OWN last good read, so a collection that failed is covered
 * again by its next delta without every other collection re-reading the same interval.
 */
function sinceMap(lastOk: PollerState["lastOk"]): Partial<Record<Collection, string>> {
  const out: Partial<Record<Collection, string>> = {};
  for (const c of DELTA_COLLECTIONS) {
    const at = lastOk[c];
    if (at !== undefined) out[c] = at;
  }
  return out;
}

/**
 * A poll is good when it read at least one collection. Only good polls advance the full-poll count, so
 * a poll where Port answered nothing is retried as the same (full) poll. One collection that keeps
 * failing does NOT make every poll full or slow the alarms: it stays in `failed` and the board stays
 * stale, while the rest keep their own rhythm.
 */
const isGoodPoll = (readCount: number): boolean => readCount > 0;

/**
 * One poll. Reads what is scheduled, folds it into the cached snapshot, builds
 * the board and works out the events. A collection that has never been read
 * gets a full or window fetch (never a delta), so a partial first load heals.
 * Each delta collection has its own `since` (its last good read), so a failed
 * interval is covered again by the next delta (the merge is by `identifier`,
 * so the overlap is harmless). A failed read never removes anything. Only polls that
 * read something advance the full-poll cadence and clear the back-off.
 */
export async function runPoll(client: PortClient, state: PollerState, now: Date): Promise<PollResult> {
  const { full } = nextPoll(state, now.getTime());
  const neverRead = new Set(
    (["services", "workloads", "hosts", "integrations", ...DELTA_COLLECTIONS] as Collection[]).filter(
      (c) => state.lastOk[c] === undefined,
    ),
  );
  const res = await fetchSnapshot(client, sinceMap(state.lastOk), full, { now, neverRead });

  const read = (Object.keys(res.data) as (keyof Snapshot)[]).filter(
    (k): k is Collection => k !== "fetchedAt",
  );
  const baseline = new Set(read.filter((c) => neverRead.has(c)));
  for (const c of read) state.lastOk[c] = now.toISOString();
  // A collection Port now refuses (403) or no longer has (404) is not "read": drop it from the
  // ever-read set so what derives from it reads "no data" again, instead of freezing at old figures.
  for (const c of res.unavailable) delete state.lastOk[c];
  state.polls += 1;
  state.lastAt = now.getTime();
  if (isGoodPoll(read.length)) {
    state.okPolls += 1;
    state.failures = 0;
  } else if (res.errorStatus !== 401) {
    // Nothing could be read: Port or the network is down, so wait longer each time. A 401 is an expired
    // token the host re-sends, not an outage: it keeps the normal rhythm.
    state.failures += 1;
  }

  const everRead = Object.keys(state.lastOk).length > 0;
  const alarmRead = { sentry: state.lastOk.sentryIssues !== undefined && !res.failed.includes("sentryIssues") };
  const unread = ALL_COLLECTIONS.filter((c) => state.lastOk[c] === undefined);
  const base = {
    alarmRead,
    unread,
    failed: res.failed,
    unavailable: res.unavailable,
    errorStatus: res.errorStatus,
    now: now.getTime(),
    seq: state.polls,
  };
  if (!everRead) {
    return { ...base, hasData: false, snapshot: null, events: state.events, replayQueue: state.replayQueue };
  }

  const prevSnapshot = state.snapshot;
  const merged = mergeSnapshot(prevSnapshot ?? emptySnapshot(now.toISOString()), res.data, res.replace);
  // Its cached entities go too: nothing the widget may no longer read is shown as current.
  const snapshot = res.unavailable.length === 0 ? merged : { ...merged, ...Object.fromEntries(res.unavailable.map((c) => [c, []])) };
  const board = buildBoard(snapshot, { now, demo: false, alarmRead, unread, failed: res.failed });

  let fresh: BoardEvent[];
  if (state.board === null || prevSnapshot === null) {
    state.replayQueue = replayEvents(snapshot, now).reverse();
    fresh = state.replayQueue;
  } else {
    const opts = { baseline, at: now.toISOString() };
    fresh = [...diffBoards(state.board, board, opts), ...diffSnapshots(prevSnapshot, snapshot, opts)];
  }
  const known = new Set(state.events.map((e) => e.id));
  // Events already held for longer than the replay window are dropped as well as the oldest past the
  // cap, so a board left open for days does not carry a whole week of CI events in memory. This
  // poll's fresh events are never pruned: a Sentry issue first seen 3 days ago that regressed now is
  // stamped with its creation time, and it is still news.
  const keepFrom = now.getTime() - REPLAY_MS;
  const carried = state.events.filter((e) => !(Date.parse(e.at) < keepFrom));
  state.events = [...fresh.filter((e) => !known.has(e.id)), ...carried].sort(newestFirst).slice(0, EVENT_LIMIT);
  state.snapshot = snapshot;
  state.board = board;

  return { ...base, hasData: true, snapshot, events: state.events, replayQueue: state.replayQueue };
}
