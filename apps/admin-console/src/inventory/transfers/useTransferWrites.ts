/**
 * RT-1515 (PR 2) the shipment-Transfer write hooks. One POST per submit, with
 * the Idempotency-Key held while the operator's input is unchanged: a retry
 * after no answer reuses the key and the body, so it cannot record twice; a
 * recorded write, an edit or a key conflict starts a new key.
 *
 * A recorded write invalidates the Transfer and inventory reads, so what the
 * screen shows next is the server's answer, never an optimistic edit. A request
 * with no response (or no answer within the timeout, which also aborts it) is
 * "failed": whether it was recorded is unknown, never success.
 */
import {
  type ApproveShipmentTransferCommand,
  type CancelShipmentTransferCommand,
  type CreateShipmentTransferCommand,
  type DispatchShipmentTransferCommand,
  type ShipmentTransfer,
  approveShipmentTransfer,
  cancelShipmentTransfer,
  createShipmentTransfer,
  dispatchShipmentTransfer,
} from "@/lib/inventory-queries";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { WRITE_TIMEOUT_MS, withTimeout } from "../../tracking/useTrackingWrites";
import {
  type HeldWrite,
  type WriteOutcome,
  classifyWrite,
  holdFor,
  isKeyConflict,
} from "./transferWriteLogic";

interface ApiResult {
  status: number;
  data?: unknown;
  error?: unknown;
  retryAfter?: number;
}

interface TransferWriteResult {
  outcome: WriteOutcome;
  /** The Transfer the server returned, on a recorded write. */
  transfer?: ShipmentTransfer;
}

export interface TransferWrite<C> {
  outcome: WriteOutcome | null;
  pending: boolean;
  /** `input` is what the operator chose (the key follows it); `build` makes the body. */
  submit: (input: unknown, build: () => C) => Promise<TransferWriteResult>;
  reset: () => void;
}

type Send<C> = (command: C, key: string, signal: AbortSignal) => Promise<ApiResult>;

interface Attempt<C> {
  input: unknown;
  build: () => C;
}

/** One POST under the held key. A request that gets no answer is "failed", never success. */
async function attempt<C>(
  held: React.MutableRefObject<HeldWrite<C> | null>,
  send: Send<C>,
  { input, build }: Attempt<C>,
): Promise<TransferWriteResult> {
  held.current = holdFor(held.current, input, build);
  const { key, command } = held.current;
  try {
    const res = await withTimeout((signal) => send(command, key, signal), WRITE_TIMEOUT_MS);
    return { outcome: classifyWrite(res), transfer: res.data as ShipmentTransfer };
  } catch {
    return { outcome: { kind: "failed" } };
  }
}

function useTransferWrite<C>(send: Send<C>): TransferWrite<C> {
  const qc = useQueryClient();
  const held = useRef<HeldWrite<C> | null>(null);
  const mutation = useMutation({
    mutationFn: (request: Attempt<C>) => attempt(held, send, request),
    onSuccess: ({ outcome }) => {
      // A recorded write and a key conflict both end the held key; the reads follow the server.
      if (outcome.kind === "recorded" || isKeyConflict(outcome)) held.current = null;
      if (outcome.kind === "recorded") {
        void qc.invalidateQueries({ queryKey: ["transfers"] });
        void qc.invalidateQueries({ queryKey: ["inventory"] });
      }
    },
  });
  return {
    outcome: mutation.data?.outcome ?? null,
    pending: mutation.isPending,
    submit: (input, build) => mutation.mutateAsync({ input, build }),
    reset: mutation.reset,
  };
}

const sendCreate: Send<CreateShipmentTransferCommand> = (command, key, signal) =>
  createShipmentTransfer(command, key, signal);

export function useCreateTransfer(): TransferWrite<CreateShipmentTransferCommand> {
  return useTransferWrite(sendCreate);
}

export interface TransferActionWrites {
  approve: TransferWrite<ApproveShipmentTransferCommand>;
  cancel: TransferWrite<CancelShipmentTransferCommand>;
  dispatch: TransferWrite<DispatchShipmentTransferCommand>;
  /** Any of the three is awaiting its answer: the drawer must not close on it. */
  pending: boolean;
}

/** The three actions of one Transfer, each with its own held key. */
export function useTransferActionWrites(transferId: string): TransferActionWrites {
  const approve = useTransferWrite<ApproveShipmentTransferCommand>((c, k, s) =>
    approveShipmentTransfer(transferId, c, k, s),
  );
  const cancel = useTransferWrite<CancelShipmentTransferCommand>((c, k, s) =>
    cancelShipmentTransfer(transferId, c, k, s),
  );
  const dispatch = useTransferWrite<DispatchShipmentTransferCommand>((c, k, s) =>
    dispatchShipmentTransfer(transferId, c, k, s),
  );
  return {
    approve,
    cancel,
    dispatch,
    pending: approve.pending || cancel.pending || dispatch.pending,
  };
}
