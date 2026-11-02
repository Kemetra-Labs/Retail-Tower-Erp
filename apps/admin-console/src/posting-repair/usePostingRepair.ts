/**
 * RT-1072 (RT-977 §5, §7) — the one write of the sale detail's ERPNext
 * posting-failure banner: `repairPosting` for the handle the detail returned.
 *
 *   - Sent only from the operator's confirmation; single-flight (a second
 *     click while one is in flight sends nothing).
 *   - One Idempotency-Key per confirmation. It is reused only to retry that
 *     same confirmation after a transport failure, a 5xx, a 429 or a 425
 *     (`retry`); a new confirmation (`confirm`) mints a new one.
 *   - A 425 (same key still running, undeclared in the contract) is waited out
 *     for its `Retry-After` and sent once more with the same key; a second 425
 *     reads as "not confirmed". No other answer is retried.
 *   - After any answer, the sale detail is read again (RT-977 §7), so the banner
 *     shows the posting's current state. The outcome lives here, not in the
 *     banner side, so it stays on screen when that side is no longer failed.
 *   - The stored ERPNext reason is never sent anywhere: the body is `{}`.
 */
import {
  IDEMPOTENCY_IN_PROGRESS_STATUS,
  type PostingRepairResult,
  repairPosting,
} from "@/lib/erp-posting-repair-queries";
import { type SaleScope, saleQueryKeys } from "@/sales/useSales";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  type PostingRepairOutcome,
  type PostingSide,
  classifyPostingRepair,
  keepsPostingKey,
  newPostingKey,
} from "./postingFailureLogic";

export interface PostingRepairTarget {
  scope: SaleScope;
  saleRef: string;
}

export interface PostingRepairState {
  /** The side whose repair is in flight. */
  pending?: PostingSide;
  /** The side the last answer was for, and the answer. */
  outcome?: { side: PostingSide; result: PostingRepairOutcome };
  /** A new confirmation for this handle: a new key. */
  confirm: (side: PostingSide, workItemRef: string) => Promise<void>;
  /** Retries the last confirmation with its kept key (a not-confirmed answer only). */
  retry: () => Promise<void>;
  /** Whether `retry` would reuse a kept key. */
  canRetry: boolean;
  /** Clears the shown outcome (a new confirmation starts clean). */
  reset: () => void;
}

interface Attempt {
  side: PostingSide;
  workItemRef: string;
  key: string;
}

/** Test seam: the wait before resending a 425 (ms). */
export const postingRepairTiming = {
  wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

async function sendOnce(attempt: Attempt): Promise<PostingRepairResult> {
  try {
    return await repairPosting(attempt.workItemRef, attempt.key);
  } catch {
    // No response at all: the server may or may not have acted.
    return { status: 0 };
  }
}

/** One send, plus at most one resend of a 425 after its Retry-After. */
async function send(attempt: Attempt): Promise<PostingRepairOutcome> {
  let result = await sendOnce(attempt);
  if (result.status === IDEMPOTENCY_IN_PROGRESS_STATUS) {
    await postingRepairTiming.wait((result.retryAfter ?? 0) * 1000);
    result = await sendOnce(attempt);
  }
  return classifyPostingRepair(result);
}

export function usePostingRepair(target: PostingRepairTarget): PostingRepairState {
  const queryClient = useQueryClient();
  const kept = useRef<Attempt | undefined>(undefined);
  const busy = useRef(false);
  const [pending, setPending] = useState<PostingSide | undefined>(undefined);
  const [outcome, setOutcome] = useState<PostingRepairState["outcome"]>(undefined);
  const [canRetry, setCanRetry] = useState(false);

  const run = async (attempt: Attempt) => {
    // A ref, not state: a second click before the re-render must not send twice.
    if (busy.current) return;
    busy.current = true;
    setPending(attempt.side);
    setOutcome(undefined);
    const result = await send(attempt);
    kept.current = keepsPostingKey(result) ? attempt : undefined;
    setCanRetry(kept.current !== undefined);
    setOutcome({ side: attempt.side, result });
    setPending(undefined);
    busy.current = false;
    void queryClient.invalidateQueries({
      queryKey: saleQueryKeys.detail(target.scope, target.saleRef),
      exact: true,
    });
  };

  return {
    pending,
    outcome,
    canRetry,
    confirm: (side, workItemRef) => run({ side, workItemRef, key: newPostingKey() }),
    retry: async () => {
      if (kept.current) await run(kept.current);
    },
    reset: () => setOutcome(undefined),
  };
}
