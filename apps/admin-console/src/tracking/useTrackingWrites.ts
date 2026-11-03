/**
 * RT-455 the governed tracking commands as one hook per form. One POST per
 * submit. The Idempotency-Key is held while the command is unchanged, so a
 * retry after no answer cannot record it twice; a recorded command, an edit or
 * a key conflict starts a new key. A recorded command invalidates the tracking
 * and inventory reads, so what the screen shows next is the server's answer,
 * never an optimistic edit. A thrown request (no response) is "failed": the
 * outcome is unknown, never success.
 */
import {
  type CorrectExpiryCommand,
  type CreateInventoryRecallCommand,
  type PlaceQualityHoldCommand,
  type ReleaseTrackingHoldCommand,
  correctTrackingIdentityExpiry,
  createInventoryRecall,
  placeQualityHold,
  releaseTrackingHold,
} from "@/lib/tracking-queries";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import {
  type KeyedCommand,
  type WriteOutcome,
  classifyWrite,
  isKeyConflict,
  keyFor,
} from "./writeLogic";

/**
 * How long a command may stay unanswered before the screen calls the outcome
 * unknown («لم يصل أي رد»), unlocks its drawer and offers a retry with the same
 * key (or, for release, the same idempotent release). A late answer is ignored.
 */
export const WRITE_TIMEOUT_MS = 30_000;

class WriteTimedOut extends Error {}

function withTimeout<T>(request: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WriteTimedOut()), ms);
  });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

interface ApiResult {
  status: number;
  data?: unknown;
  error?: unknown;
  retryAfter?: number;
}

export interface GovernedWrite<C> {
  outcome: WriteOutcome | null;
  pending: boolean;
  /** Sends the command; resolves to the outcome it also stores. */
  submit: (command: C) => Promise<WriteOutcome>;
  reset: () => void;
}

function useGovernedWrite<C>(
  send: (command: C, key: string) => Promise<ApiResult>,
): GovernedWrite<C> {
  const qc = useQueryClient();
  const held = useRef<KeyedCommand | null>(null);
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);
  const [pending, setPending] = useState(false);
  const submit = useCallback(
    async (command: C): Promise<WriteOutcome> => {
      held.current = keyFor(held.current, command);
      setPending(true);
      setOutcome(null);
      let result: WriteOutcome;
      try {
        result = classifyWrite(
          await withTimeout(send(command, held.current.key), WRITE_TIMEOUT_MS),
        );
      } catch {
        result = { kind: "failed" };
      }
      setPending(false);
      setOutcome(result);
      if (result.kind === "recorded") {
        held.current = null;
        void qc.invalidateQueries({ queryKey: ["tracking"] });
        void qc.invalidateQueries({ queryKey: ["inventory"] });
      } else if (isKeyConflict(result)) {
        held.current = null;
      }
      return result;
    },
    [qc, send],
  );
  const reset = useCallback(() => setOutcome(null), []);
  return { outcome, pending, submit, reset };
}

const sendHold = (command: PlaceQualityHoldCommand, key: string) => placeQualityHold(command, key);
const sendRecall = (command: CreateInventoryRecallCommand, key: string) =>
  createInventoryRecall(command, key);

export function usePlaceHold(): GovernedWrite<PlaceQualityHoldCommand> {
  return useGovernedWrite(sendHold);
}

export function useCreateRecall(): GovernedWrite<CreateInventoryRecallCommand> {
  return useGovernedWrite(sendRecall);
}

/** Release takes no key: releasing a released hold answers the recorded release. */
export function useReleaseHold(holdId: string): GovernedWrite<ReleaseTrackingHoldCommand> {
  const send = useCallback(
    (command: ReleaseTrackingHoldCommand) => releaseTrackingHold(holdId, command),
    [holdId],
  );
  return useGovernedWrite(send);
}

export function useCorrectExpiry(identityId: string): GovernedWrite<CorrectExpiryCommand> {
  const send = useCallback(
    (command: CorrectExpiryCommand, key: string) =>
      correctTrackingIdentityExpiry(identityId, command, key),
    [identityId],
  );
  return useGovernedWrite(send);
}
