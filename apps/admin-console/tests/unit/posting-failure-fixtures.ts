/** RT-1072 shared test data: `erpPostingFailure` payloads (RT-977 §6) and `repairPosting` answers. */
import { detail } from "./sale-fixtures";

export const WORK_ITEM = "0190f000-0000-7000-8000-0000000009a1";
export const REVERSAL_ITEM = "0190f000-0000-7000-8000-0000000009a2";
export const REQUEST_ID = "22222222-3333-4444-8555-666666666666";
export const REASON = "Item ITM-001 has no stock in warehouse Stores - NS";

export function failureDetail(over: Record<string, unknown> = {}) {
  return {
    rejectionCategory: "validation",
    deadLetteredAt: "2026-10-07T11:00:00Z",
    reason: REASON,
    reconciliationDocumentRef: null,
    repair: { workItemRef: WORK_ITEM },
    ...over,
  };
}

/** A sale detail whose sale posting failed, with the given `erpPostingFailure` (omit for absent). */
export function failedDetail(failure?: unknown, erp: Record<string, unknown> = {}) {
  return detail({
    erpPosting: {
      sale: "failed",
      saleDocumentRef: null,
      reversal: null,
      reversalDocumentRef: null,
      ...erp,
    },
    ...(failure === undefined ? {} : { erpPostingFailure: failure }),
  });
}

export function full(sale: unknown = failureDetail(), reversal: unknown = null) {
  return { disclosure: "full", sale, reversal };
}

export function categoryOnly(sale: unknown = failureDetail(), reversal: unknown = null) {
  return { disclosure: "category_only", sale, reversal };
}

export function recorded(over: Record<string, unknown> = {}) {
  return {
    targetKind: "posting",
    targetRef: WORK_ITEM,
    repairKind: "re_post",
    outcome: "eligible_again",
    resolvedDocumentRef: null,
    recordedAt: "2026-10-07T12:00:00Z",
    ...over,
  };
}

export const answered = (status: number, data: unknown) => ({ status, data });

export const refused = (status: number, code = "x", retryAfter?: number) => ({
  status,
  error: { error: { code, message: "x", request_id: REQUEST_ID } },
  retryAfter,
});
