import { rf2QueryKeys } from "@/lib/rf2-queries";
/**
 * RT-1441 (U2): the preview read and the confirm flow of the owner's store deletion.
 *
 * The preview is a snapshot: it is read fresh when the dialog opens (`gcTime: 0`), and again after
 * a 409 (`preview_stale` or a guard). The commit is two calls, one click: the password
 * re-authentication (a single-use grant, 5 minutes), then the delete, carrying the preview's
 * fingerprint, the reason and that grant, with ONE Idempotency-Key per attempt (`KeyedAttempt`).
 *
 * An unclear answer (425, 5xx, no answer) and a 429 keep the attempt: a resend is the SAME body
 * with the SAME grant and the SAME key. It never re-authenticates, because a new grant would change
 * the body (409 `idempotency_key_conflict`) and the server replays a recorded delete before it looks
 * at the grant. A terminal answer starts a new action, which re-authenticates and takes a new key.
 * The password is cleared as soon as it is sent, and the grant lives only in the held attempt.
 * The server's verdict is the only verdict: this layer holds no rule of its own.
 */
import { NO_ANSWER, type Read, useReadScope, useServerRead } from "@/lib/server-read";
import {
  type StoreDeletionPreview,
  type StoreDeletionRequest,
  consoleDeleteStore,
  consoleReauthenticate,
  previewStoreDeletion,
} from "@/lib/store-deletion-queries";
import { KeyedAttempt, errorRequestIdOf } from "@/lib/write-outcome";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { commitReady } from "./storeDeletionLogic";
import {
  type DeletionOutcome,
  classifyDeletionOutcome,
  classifyReauthOutcome,
} from "./storeDeletionOutcomes";

type Held = { body: StoreDeletionRequest; key: string };

/** What deleting one store would change now. Read fresh on every open, and only while the dialog is mounted. */
export function useStoreDeletionPreview(storeId: string): Read<StoreDeletionPreview> {
  const { tenantId, role } = useReadScope();
  return useServerRead({
    queryKey: ["store-deletion", "preview", tenantId, role, storeId],
    enabled: tenantId !== null,
    fetcher: () => previewStoreDeletion(storeId),
    fresh: true,
  });
}

export interface StoreDeletionFlow {
  reason: string;
  password: string;
  setReason: (reason: string) => void;
  setPassword: (password: string) => void;
  pending: boolean;
  /** The last answer, or null before the first attempt. */
  outcome: DeletionOutcome | null;
  /** The request id of the last refusal, as a support handle. */
  requestId: string | undefined;
  /** Every input the contract needs is present, whatever is in flight (the button's own enabled state). */
  ready: boolean;
  commit: () => Promise<void>;
  /** Resend the unclear attempt exactly as it was (same body, same grant, same key). */
  retry: () => Promise<void>;
  /** An attempt is held for a resend (an unclear answer, or a 429). */
  canRetry: boolean;
}

/** The confirm step: input state, the keyed write and the reaction to each answer. */
export function useStoreDeletionFlow(
  storeId: string,
  preview: Read<StoreDeletionPreview>,
): StoreDeletionFlow {
  const qc = useQueryClient();
  const { tenantId } = useReadScope();
  const attempt = useRef(new KeyedAttempt());
  const inFlight = useRef(false);
  /** The attempt whose answer was unclear (or rate-limited): resent as it was, grant and all. */
  const held = useRef<Held | null>(null);
  const [reason, setReasonState] = useState("");
  const [password, setPasswordState] = useState("");
  const [pending, setPending] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const [outcome, setOutcome] = useState<DeletionOutcome | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>();

  // The grant is a credential: it never outlives the dialog.
  useEffect(
    () => () => {
      held.current = null;
    },
    [],
  );

  const fingerprint = preview.data?.previewFingerprint;
  const canDelete = preview.data?.canDelete === true;
  // Once the delete is recorded, nothing more can be sent from this dialog.
  const finished = outcome?.kind === "deleted";
  const ready =
    !finished &&
    commitReady({ canDelete, reason, password, pending: false, fetching: preview.isFetching });

  const clearAnswer = useCallback(() => {
    setOutcome((o) =>
      o?.kind === "rejected" || o?.kind === "retryable" || o?.kind === "reauthRequired" ? null : o,
    );
  }, []);

  const setReason = useCallback(
    (next: string) => {
      setReasonState(next);
      clearAnswer();
    },
    [clearAnswer],
  );

  const setPassword = useCallback(
    (next: string) => {
      setPasswordState(next);
      clearAnswer();
    },
    [clearAnswer],
  );

  /** Record an answer and what it means for the held attempt. */
  const settleAnswer = useCallback(
    async (next: DeletionOutcome, res: { status: number; error?: unknown }, sent: Held) => {
      // An unclear answer (425, 5xx, no answer) and a 429 keep the attempt: a retry is the same action.
      const keep = next.kind === "retryable" || res.status === 429;
      if (keep) held.current = sent;
      else {
        held.current = null;
        attempt.current.settle();
      }
      setCanRetry(keep);
      setRequestId(errorRequestIdOf(res.error));
      setOutcome(next);
      if (next.kind === "stale") preview.refetch();
      if (next.kind === "deleted") {
        await qc.invalidateQueries({ queryKey: rf2QueryKeys.stores(tenantId) });
      }
    },
    [preview, qc, tenantId],
  );

  /** Send one attempt and react to the answer. */
  const send = useCallback(
    async (body: StoreDeletionRequest, key: string) => {
      const res = await consoleDeleteStore(storeId, body, key).catch(() => NO_ANSWER);
      await settleAnswer(classifyDeletionOutcome(res), res, { body, key });
    },
    [settleAnswer, storeId],
  );

  /** One guarded run: nothing else can be sent while it is in flight. */
  const guarded = useCallback(async (run: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setOutcome(null);
    try {
      await run();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);

  const commit = useCallback(async () => {
    // A new action must be what the form would send now.
    if (fingerprint === undefined || !ready) return;
    const sent = password;
    const trimmed = reason.trim();
    setPasswordState("");
    await guarded(async () => {
      const re = await consoleReauthenticate(storeId, sent).catch(() => NO_ANSWER);
      const grant = classifyReauthOutcome(re);
      if (grant.kind !== "granted") {
        setCanRetry(false);
        setRequestId(errorRequestIdOf(re.error));
        setOutcome(grant);
        return;
      }
      const body = { reason: trimmed, previewFingerprint: fingerprint, reauthToken: grant.token };
      const key = attempt.current.keyFor(`${storeId}|${trimmed}|${fingerprint}|${grant.token}`);
      await send(body, key);
    });
  }, [fingerprint, guarded, password, ready, reason, send, storeId]);

  const retry = useCallback(async () => {
    // Recovery of an unclear delete does not depend on today's verdict: the server answers a
    // recorded delete with a replay before it looks at the grant, the fingerprint or the cap.
    const again = held.current;
    if (again === null) return;
    await guarded(() => send(again.body, again.key));
  }, [guarded, send]);

  return {
    reason,
    password,
    setReason,
    setPassword,
    pending,
    outcome,
    requestId,
    ready,
    commit,
    retry,
    canRetry,
  };
}
