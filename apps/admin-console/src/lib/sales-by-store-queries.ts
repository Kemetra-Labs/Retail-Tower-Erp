/**
 * RT-1054 data layer: typed wrapper over the generated `apiClient` for the one
 * read of the Backend-Core «Sales by store» report (RT-1008 contract, RT-1053
 * runtime):
 *
 *   - `consoleGetSalesByStore`: every store of the caller's scope over an
 *     inclusive range of at most 31 business days, ranked by received sales in
 *     one currency, with each store's share, average sale, best day, dense
 *     per-day figures and the previous equal-length period.
 *
 * Boundary: ONE read-only op is wrapped. Every figure is the server's; this
 * module and its callers never sum, subtract or divide a figure (AI-13).
 *
 * Error mapping: exactly the statuses the contract documents.
 *   - 400 `scope_too_large` (more than 500 stores in scope) is told apart by
 *     the envelope's `error.code`, which is a stable machine code.
 *   - 400 `validation_error` carries no field detail, so a range problem is
 *     told apart from any other bad field by checking the request that was
 *     sent, never by parsing the message.
 *   - 404 is the non-disclosing not-found: no request id, no cause.
 *   - 429 is the shared rate-limit banner's (clock fed by the middleware in
 *     `src/lib/rate-limit.ts`); this mapper adds no countdown.
 *   - 5xx is a retryable banner carrying the `request_id`.
 */
import { apiClient } from "@/generated/client";
import type { ConsoleSalesByStoreSchema } from "@/generated/schema";
import type { MessageKey } from "@/i18n";
import { type SalesSummaryRangeProblem, salesSummaryRangeProblem } from "./sales-summary-queries";

type Schemas = ConsoleSalesByStoreSchema.components["schemas"];

// --- Generated projections (no hand-typed shapes) -----------------------------

export type SalesByStore = Schemas["ConsoleSalesByStore"];
export type StoreSalesByStore = Schemas["StoreSalesByStore"];
export type StoreDay = Schemas["StoreDay"];
export type StoreFacts = Schemas["StoreFacts"];
export type MoneyFacts = Schemas["MoneyFacts"];
export type SalesByStoreQuery =
  ConsoleSalesByStoreSchema.operations["consoleGetSalesByStore"]["parameters"]["query"];
export type SalesByStoreCompare = NonNullable<SalesByStoreQuery["compare"]>;

/** The most stores the server ranks in one read; above it the read is refused. */
export const SALES_BY_STORE_MAX_STORES = 500;

// --- Typed operation wrapper --------------------------------------------------

/** GET /api/v1/sales-by-store: always every store of the caller's scope; no store filter, no paging. */
export async function consoleGetSalesByStore(query: SalesByStoreQuery) {
  const { data, error, response } = await apiClient.GET("/api/v1/sales-by-store", {
    params: { query },
  });
  return { status: response.status, data, error };
}

// --- Typed error mapping ------------------------------------------------------

/** Backend error envelope: { error: { code, message, request_id } } (generated schema Error). */
type BackendError = Schemas["Error"];

export interface SalesByStoreErrorContext {
  status: number;
  error?: BackendError;
  /** The query that was sent; lets a 400 be told apart as a range problem. */
  query?: SalesByStoreQuery;
}

export type SalesByStoreErrorRender =
  /** 400 `scope_too_large`: more stores in scope than the server ranks; nothing is truncated. */
  | { kind: "scope-too-large"; requestId?: string }
  /** 400: `to` before `from`, or a range wider than 31 days. */
  | { kind: "range"; problem: SalesSummaryRangeProblem; requestId?: string }
  /** 400 otherwise: a malformed, repeated or unknown value, or a currency that is not a code. */
  | { kind: "field"; requestId?: string }
  /** 404: non-disclosing; a role outside the report's roles gets the same answer. */
  | { kind: "not-found" }
  /** 429: the shared rate-limit banner owns the countdown. */
  | { kind: "rate-limited" }
  /** 5xx: retryable banner with the correlation id. */
  | { kind: "server"; messageKey: MessageKey; requestId?: string; retryable: true }
  /** 401 and any status the contract does not document. */
  | { kind: "generic"; messageKey: MessageKey; requestId?: string };

const COPY = {
  serverError: "errors.server",
  generic: "errors.generic",
} as const satisfies Record<string, MessageKey>;

const SCOPE_TOO_LARGE = "scope_too_large";

function mapBadRequest(
  input: SalesByStoreErrorContext,
  requestId?: string,
): SalesByStoreErrorRender {
  if (input.error?.error?.code === SCOPE_TOO_LARGE) return { kind: "scope-too-large", requestId };
  const problem = input.query ? salesSummaryRangeProblem(input.query) : null;
  return problem ? { kind: "range", problem, requestId } : { kind: "field", requestId };
}

export function mapSalesByStoreError(input: SalesByStoreErrorContext): SalesByStoreErrorRender {
  const requestId = input.error?.error?.request_id;
  if (input.status === 400) return mapBadRequest(input, requestId);
  if (input.status === 404) return { kind: "not-found" };
  if (input.status === 429) return { kind: "rate-limited" };
  if (input.status >= 500) {
    return { kind: "server", messageKey: COPY.serverError, requestId, retryable: true };
  }
  // 401 (the auth interceptor owns the session) and anything undocumented.
  return { kind: "generic", messageKey: COPY.generic, requestId };
}
