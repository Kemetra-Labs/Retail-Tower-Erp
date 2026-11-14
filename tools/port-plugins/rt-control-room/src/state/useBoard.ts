import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isRealDeployment } from "../model/deployments";
import { useQuery } from "@tanstack/react-query";
import { createPortClient } from "../api/portClient";
import { usePortBridge } from "../bridge/usePortBridge";
import { requestPortToken } from "../bridge/requestToken";
import { buildBoard } from "../model/board";
import type { Board, Collection, Deployment } from "../model/types";
import type { BoardEvent } from "./diff";
import { createPollerState, runPoll, type PollerState, type PollResult } from "./poller";
import { nextPoll } from "./schedule";
import { useVisible } from "./useVisible";
import { POLL_MS } from "./blueprints";

/** No good core read for this long means the board is stale, even if no poll has failed yet. */
export const SILENT_AFTER_MS = 2 * POLL_MS;
const SILENCE_CHECK_MS = 15_000;

/** True when the last good core read is older than `SILENT_AFTER_MS` (never true before the first one). */
export function isSilent(lastGoodAt: number | null, now: number): boolean {
  return lastGoodAt !== null && now - lastGoodAt > SILENT_AFTER_MS;
}

export type BoardStatus = "loading" | "ready" | "error" | "stale";

export type UseBoard = {
  /** Null until the first read of any collection completes. Kept (stale) when a later poll fails. */
  board: Board | null;
  /** Newest first, capped. Replay events carry `replay: true`. */
  events: BoardEvent[];
  /** The 24 h replay in the order it plays (oldest first). Empty when nothing changed in 24 h. */
  replayQueue: BoardEvent[];
  status: BoardStatus;
  /** A human sentence for `stale` or `error`; never contains the token or a response body. */
  error: string | null;
  /** Collections whose latest read failed (their previous content is still shown). */
  failed: Collection[];
  /**
   * The start (ms) of the last poll that read the CORE collections (services, workloads, Sentry,
   * Datadog monitors and hosts), or null when there has been none. A stale board keeps the time
   * of its last good sync, never the time of the failed poll. One blueprint that never reads (a
   * misspelled Jira, say) keeps the board "stale" but does not hide this time.
   */
  asOf: number | null;
  /** When the newest lab deployment changed (ISO), or null when Port lists none. */
  labUpdatedAt: string | null;
  /** True from the first board until the diagram calls `onReplayDone()`; false when there is nothing to replay. */
  replaying: boolean;
  onReplayDone(): void;
};

export type UseBoardOptions = {
  /** Adds the labelled example alarm (`?demo=1`). Never real data. */
  demo?: boolean;
};

/** The collections that give the board its meaning: alarms, health and the map itself. */
const CORE: Collection[] = ["services", "workloads", "sentryIssues", "monitors", "hosts"];

const QUERY_KEY = ["rt-control-room", "board"] as const;
const MIN_DELAY_MS = 1_000;

/** Port's `deployment.environment` values that mean the test lab (it has no "lab" value; lab jobs are "Staging"). */
const LAB_ENVIRONMENTS = new Set(["staging", "lab"]);

/**
 * When the newest lab deployment happened. The entity's `updatedAt` moves on
 * every resync, so it is not used: the deployment's own `createdAt` property,
 * or else the entity's `createdAt`, is. Only Staging or lab deployments count
 * (any case); Unknown, other environments and none at all are skipped, so a
 * Port that lists only Unknown ones gives `null` ("no data").
 */
export function newestLabDeployment(deployments: readonly Deployment[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const d of deployments) {
    const env = d.properties?.environment;
    if (typeof env !== "string" || !LAB_ENVIRONMENTS.has(env.toLowerCase())) continue;
    if (!isRealDeployment(d)) continue;
    const own = d.properties.createdAt;
    const at = typeof own === "string" ? own : d.createdAt;
    const ms = Date.parse(at);
    if (!Number.isNaN(ms) && ms > bestMs) {
      best = at;
      bestMs = ms;
    }
  }
  return best;
}

function errorText(status: number | null): string {
  return status === null ? "Port could not be read" : `Port could not be read (HTTP ${status})`;
}

/**
 * The control room's data: polls Port every 60 s (full first, then deltas, every
 * fifth poll full), keeps the last good board when a poll fails, and emits
 * change events. Call it unconditionally at the top of `App`: every hook runs on
 * every render, and fetching is gated inside by `enabled`, so the token
 * arriving after first paint never changes the hook count.
 */
export function useBoard(options: UseBoardOptions = {}): UseBoard {
  const demo = options.demo ?? false;
  const { token, baseUrl, trusted } = usePortBridge();
  const visible = useVisible();
  const enabled = !!token && !!baseUrl && trusted && visible;

  // The token lives in a ref: it must never enter the query key (it would reset
  // the query and could leak) and a refreshed token is picked up by the next poll.
  const tokenRef = useRef<string | null>(token);
  tokenRef.current = token;
  const stateRef = useRef<PollerState | null>(null);
  stateRef.current ??= createPollerState();
  const poller = stateRef.current;
  const [replayDone, setReplayDone] = useState(false);

  const query = useQuery({
    queryKey: QUERY_KEY,
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    structuralSharing: false,
    refetchInterval: visible
      ? () => Math.max(MIN_DELAY_MS, nextPoll(poller, Date.now()).at - Date.now())
      : false,
    queryFn: () => {
      // Several parallel requests can answer 401 together: ask the host once per poll.
      let asked = false;
      const client = createPortClient(
        baseUrl ?? "",
        () => tokenRef.current,
        () => {
          if (asked) return;
          asked = true;
          requestPortToken();
        },
      );
      return runPoll(client, poller, new Date());
    },
  });

  const data = query.data;
  const board = useMemo(
    () =>
      data?.hasData && data.snapshot
        ? buildBoard(data.snapshot, { now: new Date(data.now), demo, alarmRead: data.alarmRead, unread: data.unread })
        : null,
    [data, demo],
  );

  // A poll that failed in the core still advances `data.now`, but its board is not "as of" that moment.
  const goodSyncRef = useRef<number | null>(null);
  if (data?.hasData && !data.failed.some((c) => CORE.includes(c))) goodSyncRef.current = data.now;

  // Re-check the clock even when no poll returns (a hung or paused poll), so a silent board turns stale.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), SILENCE_CHECK_MS);
    return () => clearInterval(id);
  }, []);
  const silent = isSilent(goodSyncRef.current, clock);

  let status: BoardStatus;
  if (!data) status = query.isError ? "error" : "loading";
  else if (!data.hasData) status = "error";
  else if (data.failed.length > 0 || query.isError || silent) status = "stale";
  else status = "ready";

  const labUpdatedAt = useMemo(() => newestLabDeployment(data?.snapshot?.deployments ?? []), [data]);

  const onReplayDone = useCallback(() => setReplayDone(true), []);
  const replayQueue = data?.replayQueue ?? [];

  return {
    board,
    events: data?.events ?? [],
    replayQueue,
    status,
    error: status === "stale" || status === "error" ? errorText(data?.errorStatus ?? null) : null,
    failed: data?.failed ?? [],
    asOf: board ? goodSyncRef.current : null,
    labUpdatedAt,
    replaying: board !== null && replayQueue.length > 0 && !replayDone,
    onReplayDone,
  };
}
