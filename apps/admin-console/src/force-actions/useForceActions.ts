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
import { useActiveContextValue } from "@/context/ActiveContextProvider";
import {
  type ForceClosePreview,
  type OpenShiftList,
  consoleForceCloseShift,
  consoleGetForceClosePreview,
  consoleListOpenShifts,
} from "@/lib/force-action-queries";
import { KeyedAttempt, errorRequestIdOf } from "@/lib/write-outcome";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { type ForceCloseOutcome, classifyForceCloseOutcome } from "./forceCloseOutcomes";
import { commitReady } from "./forceCloseLogic";

export type ReadError = { kind: "not-available" | "failed"; requestId?: string };

function readErrorOf(status: number, error: unknown): ReadError {
  const requestId = errorRequestIdOf(error);
  return status === 404 ? { kind: "not-available", requestId } : { kind: "failed", requestId };
}

function useTenantId(): string | null {
  const { context } = useActiveContextValue();
  return context?.active_tenant?.id ?? null;
}

export interface Read<T> {
  data: T | undefined;
  isLoading: boolean;
  error: ReadError | undefined;
  refetch: () => void;
}

/** Every open shift of one store with the server's verdict (D6). */
export function useOpenShifts(storeId: string | undefined): Read<OpenShiftList> {
  const tenantId = useTenantId();
  const q = useQuery<OpenShiftList, ReadError>({
    queryKey: ["force-actions", "open-shifts", tenantId, storeId],
    enabled: tenantId !== null && storeId !== undefined,
    retry: false,
    queryFn: async () => {
      const res = await consoleListOpenShifts(storeId as string);
      if (res.status === 200 && res.data) return res.data;
      throw readErrorOf(res.status, res.error);
    },
  });
  return { data: q.data, isLoading: q.isLoading, error: q.error ?? undefined, refetch: () => void q.refetch() };
}

/** What force-closing one shift would change now. Read fresh on every open. */
export function useForceClosePreview(shiftId: string): Read<ForceClosePreview> {
  const tenantId = useTenantId();
  const q = useQuery<ForceClosePreview, ReadError>({
    queryKey: ["force-actions", "preview", tenantId, shiftId],
    enabled: tenantId !== null,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const res = await consoleGetForceClosePreview(shiftId);
      if (res.status === 200 && res.data) return res.data;
      throw readErrorOf(res.status, res.error);
    },
  });
  return { data: q.data, isLoading: q.isLoading, error: q.error ?? undefined, refetch: () => void q.refetch() };
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
  canCommit: boolean;
  commit: () => Promise<void>;
}

/** The confirm step: input state, the keyed write and the reaction to each answer. */
export function useForceCloseFlow(shiftId: string, preview: Read<ForceClosePreview>): ForceCloseFlow {
  const qc = useQueryClient();
  const attempt = useRef(new KeyedAttempt());
  const inFlight = useRef(false);
  const [reason, setReasonState] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<ForceCloseOutcome | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>();

  const fingerprint = preview.data?.previewFingerprint;
  const eligible = preview.data?.shift.verdict.eligible === true;
  // Once the close is recorded, nothing more can be sent from this dialog.
  const finished = outcome?.kind === "closed" || outcome?.kind === "settled";

  const setReason = useCallback((next: string) => {
    setReasonState(next);
    setOutcome((o) => (o?.kind === "rejected" || o?.kind === "retryable" ? null : o));
  }, []);

  const commit = useCallback(async () => {
    if (inFlight.current || fingerprint === undefined) return;
    inFlight.current = true;
    setPending(true);
    setOutcome(null);
    try {
      const body = { forcedReason: reason.trim(), previewFingerprint: fingerprint };
      const key = attempt.current.keyFor(`${shiftId}|${body.forcedReason}|${fingerprint}`);
      const res = await consoleForceCloseShift(shiftId, body, key).catch(() => ({
        status: 0,
        data: undefined,
        error: undefined,
      }));
      const next = classifyForceCloseOutcome(res);
      // An unclear answer (425, 5xx, no answer) and a 429 keep the key: the retry is the same action.
      const rateLimited = res.status === 429;
      if (next.kind !== "retryable" && !rateLimited) attempt.current.settle();
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
  }, [fingerprint, preview, qc, reason, shiftId]);

  return {
    reason,
    acknowledged,
    setReason,
    setAcknowledged,
    pending,
    outcome,
    requestId,
    canCommit: !finished && commitReady({ eligible, reason, acknowledged, pending }),
    commit,
  };
}
