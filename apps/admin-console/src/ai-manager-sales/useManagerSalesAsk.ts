import { consoleExplainSales } from "@/lib/ai-manager-sales-queries";
import type { ManagerSalesExplainRequest } from "@/lib/ai-manager-sales-queries";
/**
 * RT-1541 hook: one submit of the Manager Sales Ask/Explain panel.
 *
 * Every submit (and every retry) is a new request with a FRESH `Idempotency-Key`
 * (`newIdempotencyKey()`): the key is the Gateway quota reservation key, so a retry after a failure
 * must not replay or collide with the earlier one. The outcome travels in the RESULT, so a
 * component branches on data, not on a thrown error; a request that threw before any status
 * (offline, aborted) is a plain `error` outcome. Nothing here logs the request or the answer.
 */
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { useMutation } from "@tanstack/react-query";
import { type ExplainOutcome, classifyExplain } from "./managerSalesLogic";

export type AskState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; outcome: ExplainOutcome };

export interface ManagerSalesAsk {
  state: AskState;
  ask: (request: ManagerSalesExplainRequest) => void;
}

async function submit(request: ManagerSalesExplainRequest): Promise<ExplainOutcome> {
  try {
    const result = await consoleExplainSales(request, newIdempotencyKey());
    return classifyExplain(result, request);
  } catch {
    return { kind: "error" };
  }
}

export function useManagerSalesAsk(): ManagerSalesAsk {
  const mutation = useMutation({ mutationFn: submit });
  let state: AskState = { status: "idle" };
  if (mutation.isPending) state = { status: "loading" };
  else if (mutation.data) state = { status: "done", outcome: mutation.data };
  return { state, ask: (request) => mutation.mutate(request) };
}
