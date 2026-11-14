import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createPortClient } from "../api/portClient";
import { usePortBridge } from "../bridge/usePortBridge";
import { requestPortToken } from "../bridge/requestToken";
import { buildBoard } from "../model/board";
import type { Board, Collection } from "../model/types";
import type { BoardEvent } from "./diff";
import { createPollerState, runPoll, type PollerState } from "./poller";
import { nextPoll } from "./schedule";
import { useVisible } from "./useVisible";

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
  /** True from the first board until the diagram calls `onReplayDone()`; false when there is nothing to replay. */
  replaying: boolean;
  onReplayDone(): void;
};

export type UseBoardOptions = {
  /** Adds the labelled example alarm (`?demo=1`). Never real data. */
  demo?: boolean;
};

const QUERY_KEY = ["rt-control-room", "board"] as const;
const MIN_DELAY_MS = 1_000;

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
        ? buildBoard(data.snapshot, { now: new Date(data.now), demo, alarmRead: data.alarmRead })
        : null,
    [data, demo],
  );

  let status: BoardStatus;
  if (!data) status = query.isError ? "error" : "loading";
  else if (!data.hasData) status = "error";
  else if (data.failed.length > 0 || query.isError) status = "stale";
  else status = "ready";

  const onReplayDone = useCallback(() => setReplayDone(true), []);
  const replayQueue = data?.replayQueue ?? [];

  return {
    board,
    events: data?.events ?? [],
    replayQueue,
    status,
    error: status === "stale" || status === "error" ? errorText(data?.errorStatus ?? null) : null,
    failed: data?.failed ?? [],
    replaying: board !== null && replayQueue.length > 0 && !replayDone,
    onReplayDone,
  };
}
