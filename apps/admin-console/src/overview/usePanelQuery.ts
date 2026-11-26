import { type LoadFailure, NETWORK_FAILURE, loadFailureOf } from "@/lib/error-recovery";
/**
 * RT-559 one panel's read (spec 009 §6.2–§6.4). Every Overview panel reads
 * through an existing typed wrapper and lands in exactly one state:
 *
 *   - `loading`: its read is in flight (or waiting on what it needs first);
 *   - `hidden`: the session may not read it (role pre-skip, or a 403/404), so
 *     it is omitted, never shown as empty or zero;
 *   - `error`: the read failed or answered something malformed; the panel shows
 *     an inline notice with its own retry, never a zero;
 *   - `ready`: backend truth, as returned.
 *
 * The owning screens' hooks are not reused here: they map 403/404 to different
 * kinds (and some to a generic error), while the Overview must omit on both.
 * Keys sit under `["overview", …]` and carry the tenant, active store and role,
 * so a scope or authority change never reuses another scope's answer (RT-1076).
 */
import { useQuery } from "@tanstack/react-query";
import { isRefusal } from "./overviewLogic";

export type PanelState<T> =
  | { status: "loading" }
  | { status: "hidden" }
  | { status: "error"; requestId?: string; failure: LoadFailure; retry: () => void }
  | { status: "ready"; data: T };

/** What one read proved; `undefined` data from `select` means malformed. */
export type PanelRead<T> =
  | { kind: "ready"; data: T }
  | { kind: "hidden" }
  | { kind: "error"; requestId?: string; failure: LoadFailure };

export interface ApiResult {
  status: number;
  data?: unknown;
  error?: unknown;
}

export interface OverviewScope {
  tenantId: string | null;
  activeStoreId: string | null;
  /** The role decides what the server returns, so a cached answer must not cross a role change. */
  role: string | null;
}

export const OVERVIEW_KEY = ["overview"] as const;

export function overviewKey(panel: string, scope: OverviewScope): readonly unknown[] {
  return [...OVERVIEW_KEY, panel, scope.tenantId, scope.activeStoreId, scope.role];
}

/** A refusal, a failure, or the selected payload (a malformed one is a failure). */
export function readResult<T>(
  res: ApiResult,
  select: (data: unknown) => T | undefined,
): PanelRead<T> {
  if (res.status >= 400) {
    if (isRefusal(res.status)) return { kind: "hidden" };
    const failure = loadFailureOf(res);
    return { kind: "error", requestId: failure.requestId, failure };
  }
  const data = select(res.data);
  // A malformed answer is the server's failure; asking again can fetch a good one.
  return data === undefined
    ? { kind: "error", failure: { cause: "server", retryable: true } }
    : { kind: "ready", data };
}

/** A page body's item list, or undefined when the body has none. */
export function itemsOf(data: unknown): unknown[] | undefined {
  const items = (data as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? items : undefined;
}

export type PanelGate = "run" | "wait" | "skip";

export interface PanelQuery<T> {
  key: readonly unknown[];
  /** `skip`: known refused for this role; `wait`: needs something first. */
  gate: PanelGate;
  read: () => Promise<PanelRead<T>>;
}

const LOADING = { status: "loading" } as const;
const HIDDEN = { status: "hidden" } as const;

/** A settled read as a panel state. */
function settledState<T>(result: PanelRead<T>, retry: () => void): PanelState<T> {
  if (result.kind === "ready") return { status: "ready", data: result.data };
  if (result.kind === "hidden") return HIDDEN;
  return { status: "error", requestId: result.requestId, failure: result.failure, retry };
}

interface QuerySnapshot<T> {
  data?: PanelRead<T>;
  isError: boolean;
  isFetching: boolean;
}

/** A retry in flight reads as loading again, not as the old failure. */
function isRetrying<T>(query: QuerySnapshot<T>): boolean {
  return query.isFetching && (query.isError || query.data?.kind === "error");
}

export function usePanelQuery<T>({ key, gate, read }: PanelQuery<T>): PanelState<T> {
  const query = useQuery<PanelRead<T>>({
    queryKey: key,
    enabled: gate === "run",
    queryFn: read,
    retry: false,
  });
  if (gate === "skip") return HIDDEN;
  if (gate === "wait" || isRetrying(query)) return LOADING;
  const retry = () => void query.refetch();
  if (query.isError) return { status: "error", failure: NETWORK_FAILURE, retry };
  return query.data ? settledState(query.data, retry) : LOADING;
}
