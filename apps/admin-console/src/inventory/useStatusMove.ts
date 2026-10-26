/**
 * RT-436 mutation hook for the status-disposition action (RT-435
 * `createStatusMove`). One POST per submit, with the caller's Idempotency-Key.
 * On a recorded move the inventory reads are invalidated so the quantities on
 * screen are the server's, never an optimistic guess.
 */
import { type CreateStatusMoveCommand, createStatusMove } from "@/lib/inventory-queries";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type MoveOutcome, classifyMoveResult } from "./statusMoveLogic";

export interface StatusMoveRequest {
  command: CreateStatusMoveCommand;
  idempotencyKey: string;
}

export function useStatusMove(storeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ command, idempotencyKey }: StatusMoveRequest): Promise<MoveOutcome> =>
      classifyMoveResult(await createStatusMove(storeId, command, idempotencyKey)),
    onSuccess: (outcome) => {
      if (outcome.kind === "recorded") void qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}
