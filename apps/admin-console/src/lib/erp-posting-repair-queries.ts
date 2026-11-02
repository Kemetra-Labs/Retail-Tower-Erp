/**
 * RT-1072 (RT-977 §10 slice 2, D5) data layer: the one typed wrapper over the
 * generated `apiClient` for `repairPosting` of the Backend-Core
 * `erpnext-reconciliation/reconciliation.yaml` contract, called from the sale
 * detail's ERPNext posting-failure banner with the `workItemRef` handle that
 * `consoleGetSale.erpPostingFailure` returns.
 *
 * Boundary: Backend-Core only, never ERPNext. `x-idempotency: required`: the
 * caller owns the key. The body is `{}`: `note` is discarded server-side and is
 * a PII risk (RT-977 §5). Same `{ status, data?, error? }` shape as
 * `src/lib/sale-sync-ops-queries.ts`, plus the `Retry-After` seconds of a 429
 * and of the undeclared 425 `idempotency_in_progress` (RT-977 §2.4, §10).
 * Cookie transport is on the generated client.
 */
import { apiClient } from "@/generated/client";
import type { ErpnextReconciliationSchema } from "@/generated/schema";
import { parseRetryAfter } from "@/lib/rate-limit";

type Schemas = ErpnextReconciliationSchema.components["schemas"];

export type RecordedRepair = Schemas["RecordedRepair"];

/** Same-key request while the first is still running (not declared in the contract). */
export const IDEMPOTENCY_IN_PROGRESS_STATUS = 425;

export interface PostingRepairResult {
  status: number;
  data?: RecordedRepair;
  error?: unknown;
  /** Seconds to wait, read only for a 429 or a 425. */
  retryAfter?: number;
}

function waitsFor(response: Response): number | undefined {
  if (response.status !== 429 && response.status !== IDEMPOTENCY_IN_PROGRESS_STATUS) {
    return undefined;
  }
  return parseRetryAfter(response.headers.get("Retry-After"));
}

/**
 * POST /api/v1/catalog/erpnext-reconciliation/postings/{workItemRef}/repair.
 * Sent only from the operator's confirmation. The caller decides when the same
 * key is sent again (a transport failure, a 5xx or a 425 of that confirmation).
 */
export async function repairPosting(
  workItemRef: string,
  idempotencyKey: string,
): Promise<PostingRepairResult> {
  const { data, error, response } = await apiClient.POST(
    "/api/v1/catalog/erpnext-reconciliation/postings/{workItemRef}/repair",
    {
      params: { path: { workItemRef }, header: { "Idempotency-Key": idempotencyKey } },
      body: {},
    },
  );
  return { status: response.status, data, error, retryAfter: waitsFor(response) };
}
