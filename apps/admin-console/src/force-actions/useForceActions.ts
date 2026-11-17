/**
 * RT-1440 (U1): query hooks and the confirm flow of the close-without-a-count action.
 *
 * Reads are scope-keyed by the active tenant (`["force-actions", ...]`), never reused across a
 * tenant switch. The preview is a snapshot: it is read fresh on open (`gcTime: 0`), and again
 * after a 409 `preview_stale`. The write carries the preview's fingerprint and ONE
 * Idempotency-Key per attempt (`KeyedAttempt`): an unclear answer (425, 5xx, no answer) is retried
 * with the same key and body, a terminal answer starts a new action. The server's verdict is the
 * only verdict: this layer holds no rule of its own.
 */
import {
  type ConsoleForceCloseRequest,
  type ForceClosePreview,
  type OpenShiftList,
  consoleForceCloseShift,
  consoleGetForceClosePreview,
  consoleListOpenShifts,
} from "@/lib/force-action-queries";
import { NO_ANSWER, type Read, useReadScope, useServerRead } from "@/lib/server-read";
import { KeyedAttempt, errorRequestIdOf } from "@/lib/write-outcome";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { commitReady } from "./forceCloseLogic";
import { type ForceCloseOutcome, classifyForceCloseOutcome } from "./forceCloseOutcomes";

/** Every open shift of one store with the server's verdict (D6). */
export function useOpenShifts(storeId: string | undefined): Read<OpenShiftList> {
  const { tenantId, role } = useReadScope();
  return useServerRead({
    queryKey: ["force-actions", "open-shifts", tenantId, role, storeId],
    enabled: tenantId !== null && storeId !== undefined,
    fetcher: () => consoleListOpenShifts(storeId as string),
  });
}

/** What force-closing one shift would change now. Read fresh on every open. */
export function useForceClosePreview(shiftId: string): Read<ForceClosePreview> {
  const { tenantId, role } = useReadScope();
  return useServerRead({
    queryKey: ["force-actions", "preview", tenantId, role, shiftId],
    enabled: tenantId !== null,
    fetcher: () => consoleGetForceClosePreview(shiftId),
    fresh: true,
  });
}

export interface ForceCloseFlow {
  reason: string;
  acknowledged: boolean;
  setReason: (reason: string) => void;
  setAcknowledged: (acknowledged: boolean) => void;
  pending: boolean;
  /** The last answer, or null before the first attempt. */
  outcome: ForceCloseOutcome | null;
  /** The request id of the last refusal, as a support handle. */
  requestId: string | undefined;
  /** Every input the contract needs is present, whatever is in flight (the button's own enabled state). */
  ready: boolean;
  /** `ready` and nothing in flight. */
  canCommit: boolean;
  commit: () => Promise<void>;
  /** Resend the unclear attempt exactly as it was (same body, same key): the server replays a recorded close. */
  retry: () => Promise<void>;
  /** An attempt is held for a resend (an unclear answer, or a 429 that did not say the close was recorded). */
  canRetry: boolean;
}

/** The confirm step: input state, the keyed write and the reaction to each answer. */
export function useForceCloseFlow(
  shiftId: string,
  preview: Read<ForceClosePreview>,
): ForceCloseFlow {
  const qc = useQueryClient();
  const attempt = useRef(new KeyedAttempt());
  const inFlight = useRef(false);
  /** The attempt whose answer was unclear (or rate-limited): resent as it was, whatever the preview says now. */
  const held = useRef<{ body: ConsoleForceCloseRequest; key: string } | null>(null);
  const [reason, setReasonState] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const [outcome, setOutcome] = useState<ForceCloseOutcome | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>();

  const fingerprint = preview.data?.previewFingerprint;
  const eligible = preview.data?.shift.verdict.eligible === true;
  // Once the close is recorded, nothing more can be sent from this dialog.
  const finished = outcome?.kind === "closed" || outcome?.kind === "settled";
  const fetching = preview.isFetching;
  const ready =
    !finished && commitReady({ eligible, reason, acknowledged, pending: false, fetching });

  const clearAnswer = useCallback(() => {
    setOutcome((o) => (o?.kind === "rejected" || o?.kind === "retryable" ? null : o));
  }, []);

  const setReason = useCallback(
    (next: string) => {
      setReasonState(next);
      clearAnswer();
    },
    [clearAnswer],
  );

  const setAcknowledgedAndClear = useCallback(
    (next: boolean) => {
      setAcknowledged(next);
      clearAnswer();
    },
    [clearAnswer],
  );

  /** Send one attempt and react to the answer. */
  const send = useCallback(
    async (body: ConsoleForceCloseRequest, key: string) => {
      inFlight.current = true;
      setPending(true);
      setOutcome(null);
      try {
        const res = await consoleForceCloseShift(shiftId, body, key).catch(() => NO_ANSWER);
        const next = classifyForceCloseOutcome(res);
        // An unclear answer (425, 5xx, no answer) and a 429 keep the attempt: a retry is the same action.
        const keep = next.kind === "retryable" || res.status === 429;
        if (keep) held.current = { body, key };
        else {
          held.current = null;
          attempt.current.settle();
        }
        setCanRetry(keep);
        setRequestId(errorRequestIdOf(res.error));
        setOutcome(next);
        if (next.kind === "stale") {
          setAcknowledged(false);
          preview.refetch();
        }
        if (next.kind === "closed" || next.kind === "settled") {
          await qc.invalidateQueries({ queryKey: ["force-actions"] });
          await qc.invalidateQueries({ queryKey: ["devices"] });
        }
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [preview, qc, shiftId],
  );

  const commit = useCallback(async () => {
    // A new action must be what the form would send now.
    if (inFlight.current || fingerprint === undefined || !ready) return;
    const body = { forcedReason: reason.trim(), previewFingerprint: fingerprint };
    const key = attempt.current.keyFor(`${shiftId}|${body.forcedReason}|${fingerprint}`);
    await send(body, key);
  }, [fingerprint, ready, reason, send, shiftId]);

  const retry = useCallback(async () => {
    // Recovery of an unclear close does not depend on today's verdict: the server answers a recorded
    // close with a replay (the natural key is the shift and the reason), whatever the preview says now.
    if (inFlight.current || held.current === null) return;
    await send(held.current.body, held.current.key);
  }, [send]);

  return {
    reason,
    acknowledged,
    setReason,
    setAcknowledged: setAcknowledgedAndClear,
    pending,
    outcome,
    requestId,
    ready,
    canCommit: ready && !pending,
    commit,
    retry,
    canRetry,
  };
}
