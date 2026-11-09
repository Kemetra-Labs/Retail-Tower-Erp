/**
 * RT-1304 hook for the Download POS page. One explicit activation = one resolver call
 * (D-1): nothing here runs on mount, focus, StrictMode, reconnect or a route revisit,
 * and nothing runs for a role the page does not serve or in a support session (O-2).
 *
 * Not a query: a mutation-style call with no retry and no cache, because every eligible
 * call issues a new link and writes an audit row. A per-tenant in-flight guard drops a second
 * activation before React re-renders the button as busy.
 *
 * The presigned link never enters React state. `mapOutcome` returns it beside the
 * display state, it goes straight to `handOffDownload`, and only the display state is
 * kept. A result belongs to one tenant: switching tenant returns to idle and drops a
 * late answer.
 */
import { consolePilotGetLatestPosRelease } from "@/lib/pilot-release-queries";
import { useEffect, useRef, useState } from "react";
import { canReadDevices } from "./deviceLogic";
import { type DownloadState, mapNetworkFailure, mapOutcome } from "./downloadPosLogic";
import { handOffDownload } from "./handOffDownload";

export interface DownloadPosScope {
  tenantId: string | null;
  role: string | null;
}

export interface DownloadPosController {
  /** The page's state; a finished 429 window reads as idle. */
  state: DownloadState;
  /** The 429 window still running, in whole seconds (0 when none). */
  secondsLeft: number;
  /** False for a role outside the device roles, a support session, or no tenant. */
  allowed: boolean;
  activate: () => Promise<void>;
}

const IDLE: DownloadState = { kind: "idle" };
const BUSY: DownloadState = { kind: "busy" };

function useWindowTick(until: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (until <= Date.now()) return undefined;
    const bump = () => setTick((n) => n + 1);
    const id = setInterval(bump, 1000);
    const stop = setTimeout(bump, until - Date.now() + 50);
    return () => {
      clearInterval(id);
      clearTimeout(stop);
    };
  }, [until]);
}

async function resolve(): Promise<ReturnType<typeof mapOutcome>> {
  try {
    return mapOutcome(await consolePilotGetLatestPosRelease());
  } catch {
    return mapNetworkFailure();
  }
}

/**
 * Hands an issued link to the browser and returns the state to show. The link is already
 * issued and audited, so it is handed off even if the user has left the page; the frame
 * outlives the page, so leaving does not cancel a download.
 */
function settle(outcome: ReturnType<typeof mapOutcome>): DownloadState {
  if (!outcome.url) return outcome.state;
  try {
    handOffDownload(outcome.url);
    return outcome.state;
  } catch {
    return { kind: "not-started" };
  }
}

export function useDownloadPos(scope: DownloadPosScope, inSession: boolean): DownloadPosController {
  const [state, setState] = useState<DownloadState>(IDLE);
  const [until, setUntil] = useState(0);
  // Single flight per tenant: the generation that has a call in flight, or null. A tenant
  // switch bumps the generation, so the new tenant's first click is never swallowed by an
  // old tenant's call that has not settled yet.
  const inFlight = useRef<number | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const allowed = !inSession && Boolean(scope.tenantId) && canReadDevices(scope.role);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A result belongs to one tenant: a switch returns to idle and drops a late answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tenant id is the trigger
  useEffect(() => {
    generation.current += 1;
    setState(IDLE);
    setUntil(0);
  }, [scope.tenantId]);

  useWindowTick(until);

  const activate = async (): Promise<void> => {
    if (!allowed) return;
    const started = generation.current;
    if (inFlight.current === started) return;
    inFlight.current = started;
    try {
      setState(BUSY);
      const outcome = await resolve();
      // A late answer for another tenant is dropped, link and all.
      if (generation.current !== started) return;
      const next = settle(outcome);
      if (!mounted.current) return;
      if (next.kind === "rate-limited") setUntil(Date.now() + next.seconds * 1000);
      setState(next);
    } finally {
      if (inFlight.current === started) inFlight.current = null;
    }
  };

  const secondsLeft = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  const waited = state.kind === "rate-limited" && secondsLeft === 0;
  return { state: waited ? IDLE : state, secondsLeft, allowed, activate };
}
