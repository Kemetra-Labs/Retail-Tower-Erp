import { useActiveContextValue } from "@/context/ActiveContextProvider";
import { roleCodeOf, storeAccessOf } from "@/context/effectiveRole";
/**
 * RT-1601 redistribution reads and commands (react-query). Keys carry the active tenant, so a tenant
 * switch re-queries and never shows another tenant's proposals. Reads are not retried: the operator
 * decides.
 *
 * Commands go through `useRedistributionWrites`, one method per operation. Each is replayable under
 * its Idempotency-Key, kept through an unclear answer by `KeyedAttempt`, and returns a
 * `RedistributionOutcome` so components branch on data, not on thrown errors. An ok answer stores the
 * returned proposal and refreshes the list; an answer that says the proposal moved re-reads it.
 */
import {
  type RedistributionAcceptResult,
  type RedistributionLineDecision,
  type RedistributionNothingToMove,
  type RedistributionProposal,
  type RedistributionProposalList,
  type RedistributionProposalState,
  type RedistributionProposalSummary,
  acceptRedistributionProposal,
  createRedistributionProposal,
  getRedistributionProposal,
  listRedistributionProposals,
  rejectRedistributionProposal,
  reviewRedistributionProposal,
} from "@/lib/redistribution-queries";
import { KeyedAttempt, errorRequestIdOf } from "@/lib/write-outcome";
import type { ScopeMembership } from "@/shell/scope-stores";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import {
  canReadRedistribution,
  canUseRedistribution,
  dedupeById,
  nextCursor,
} from "./redistributionLogic";
import {
  type RedistributionOutcome,
  UNCERTAIN,
  classifyRedistributionResult,
} from "./redistributionOutcomes";

/**
 * The active tenant and this user's access there. `roleAllowed`: owner or tenant_admin (any other role
 * gets NoAccess). `allowed`: also every store in scope; a store-scoped owner or tenant_admin gets the
 * same non-disclosing "not available" view as a tenant with the feature off, and nothing is requested.
 */
export function useRedistributionScope(): {
  tenantId: string | null;
  roleAllowed: boolean;
  allowed: boolean;
} {
  const { context } = useActiveContextValue();
  const tenantId = context?.active_tenant?.id ?? null;
  const own = context?.memberships?.find((m) => m.tenant_id === tenantId);
  const access = storeAccessOf(context, own as ScopeMembership | undefined);
  const role = roleCodeOf(context);
  return {
    tenantId,
    roleAllowed: canReadRedistribution(role),
    allowed: canUseRedistribution(role, access),
  };
}

const keys = {
  all: (tenantId: string | null) => ["redistribution", tenantId] as const,
  list: (tenantId: string | null, state: string | undefined) =>
    ["redistribution", tenantId, "list", state ?? "all"] as const,
  detail: (tenantId: string | null, id: string) =>
    ["redistribution", tenantId, "detail", id] as const,
};

/** A read that failed. `notAvailable` is the non-disclosing 404: feature off, scope, or gone. */
export interface RedistributionReadError {
  kind: "session" | "notAvailable" | "generic";
  requestId?: string;
}

class ReadFailure extends Error {
  constructor(readonly detail: RedistributionReadError) {
    super("redistribution-read");
  }
}

function readError(status: number, error: unknown): ReadFailure {
  const requestId = errorRequestIdOf(error);
  if (status === 401) return new ReadFailure({ kind: "session", requestId });
  if (status === 404) return new ReadFailure({ kind: "notAvailable", requestId });
  return new ReadFailure({ kind: "generic", requestId });
}

function errorOf(error: unknown): RedistributionReadError | undefined {
  if (!error) return undefined;
  return error instanceof ReadFailure ? error.detail : { kind: "generic" };
}

export interface RedistributionListValue {
  rows: RedistributionProposalSummary[];
  hasMore: boolean;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  error?: RedistributionReadError;
  loadMore: () => void;
  retry: () => void;
}

export function useRedistributionList(
  tenantId: string | null,
  state: RedistributionProposalState | undefined,
  enabled: boolean,
): RedistributionListValue {
  const query = useInfiniteQuery({
    queryKey: keys.list(tenantId, state),
    enabled: enabled && Boolean(tenantId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const res = await listRedistributionProposals({ state, cursor: pageParam });
      if (res.status >= 400 || !res.data) throw readError(res.status, res.error);
      return res.data as RedistributionProposalList;
    },
    getNextPageParam: (last) => nextCursor(last),
    retry: false,
  });
  const pages = query.data?.pages ?? [];
  const more = Boolean(query.hasNextPage);
  return {
    error: errorOf(query.error),
    rows: dedupeById(pages.flatMap((p) => p.items)),
    hasMore: more,
    isFetchingNextPage: query.isFetchingNextPage,
    isLoading: query.isLoading && tenantId !== null,
    loadMore: () => {
      if (more && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    // A failed "Load more" retries the next page; any other failure re-reads from the start.
    retry: () => {
      if (query.isFetchNextPageError) void query.fetchNextPage();
      else void query.refetch();
    },
  };
}

export interface RedistributionValue {
  proposal: RedistributionProposal | undefined;
  isLoading: boolean;
  error?: RedistributionReadError;
  reload: () => void;
}

export function useRedistributionProposal(
  tenantId: string | null,
  proposalId: string | undefined,
  enabled: boolean,
): RedistributionValue {
  const query = useQuery({
    queryKey: keys.detail(tenantId, proposalId ?? ""),
    enabled: enabled && Boolean(tenantId) && Boolean(proposalId),
    queryFn: async () => {
      const res = await getRedistributionProposal(proposalId ?? "");
      if (res.status >= 400 || !res.data) throw readError(res.status, res.error);
      return res.data as RedistributionProposal;
    },
    retry: false,
  });
  return {
    proposal: query.data,
    isLoading: query.isLoading && Boolean(proposalId),
    error: errorOf(query.error),
    reload: () => void query.refetch(),
  };
}

// --- Commands ----------------------------------------------------------------------------------

type Answer<T> = { status: number; data?: T; error?: unknown };

type ComputeAnswer = RedistributionProposal | RedistributionNothingToMove;

export interface RedistributionWrites {
  compute: (storeIds?: string[]) => Promise<RedistributionOutcome<ComputeAnswer>>;
  review: (
    proposalId: string,
    decisions: RedistributionLineDecision[],
  ) => Promise<RedistributionOutcome<RedistributionProposal>>;
  accept: (
    proposalId: string,
    lineIds: string[],
  ) => Promise<RedistributionOutcome<RedistributionAcceptResult>>;
  reject: (
    proposalId: string,
    reason: string,
  ) => Promise<RedistributionOutcome<RedistributionProposal>>;
}

/** The proposal an ok answer carries: the body itself, or the accept result's `proposal`. */
function proposalIn(data: unknown): RedistributionProposal | undefined {
  if (!data || typeof data !== "object") return undefined;
  if ("lines" in data && "state" in data) return data as RedistributionProposal;
  if ("proposal" in data) return (data as RedistributionAcceptResult).proposal;
  return undefined;
}

export function useRedistributionWrites(tenantId: string | null): RedistributionWrites {
  const qc = useQueryClient();
  const attempts = useRef(new Map<string, KeyedAttempt>());

  async function run<T>(
    op: string,
    fingerprint: string,
    proposalId: string | undefined,
    call: (key: string) => Promise<Answer<T>>,
  ): Promise<RedistributionOutcome<T>> {
    const attempt = attempts.current.get(op) ?? new KeyedAttempt();
    attempts.current.set(op, attempt);
    let outcome: RedistributionOutcome<T>;
    try {
      outcome = classifyRedistributionResult(await call(attempt.keyFor(fingerprint)));
    } catch {
      outcome = UNCERTAIN;
    }
    if (outcome.kind === "ok" || !outcome.keepKey) attempt.settle();
    syncCache(op, outcome, proposalId);
    return outcome;
  }

  /** After an answer: store the returned proposal, or re-read what may have moved. */
  function syncCache(
    op: string,
    outcome: RedistributionOutcome<unknown>,
    proposalId: string | undefined,
  ): void {
    const list = [...keys.all(tenantId), "list"];
    if (op === "compute" && (outcome.kind === "ok" || outcome.refresh)) {
      // Every compute supersedes the tenant's open proposal: no cached detail stays current.
      void qc.invalidateQueries({ queryKey: keys.all(tenantId) });
    }
    if (outcome.kind === "ok") {
      const proposal = proposalIn(outcome.data);
      if (proposal) {
        // Show the answer at once, then re-read: an Idempotency-Key replay returns the proposal as
        // it was when the first request succeeded, which may predate a later decision.
        qc.setQueryData(keys.detail(tenantId, proposal.id), proposal);
        void qc.invalidateQueries({ queryKey: keys.detail(tenantId, proposal.id) });
      }
      void qc.invalidateQueries({ queryKey: list });
      return;
    }
    if (!outcome.refresh || !proposalId) return;
    void qc.invalidateQueries({ queryKey: keys.detail(tenantId, proposalId) });
    void qc.invalidateQueries({ queryKey: list });
  }

  return {
    compute: (storeIds) => {
      const body = storeIds && storeIds.length > 0 ? { storeIds } : {};
      return run<ComputeAnswer>("compute", JSON.stringify(body), undefined, (key) =>
        createRedistributionProposal(body, key),
      );
    },
    review: (proposalId, decisions) =>
      run(
        `review:${proposalId}:${decisions.map((d) => d.lineId).join(",")}`,
        JSON.stringify(decisions),
        proposalId,
        (key) => reviewRedistributionProposal(proposalId, decisions, key),
      ),
    accept: (proposalId, lineIds) =>
      run(`accept:${proposalId}`, JSON.stringify(lineIds), proposalId, (key) =>
        acceptRedistributionProposal(proposalId, lineIds, key),
      ),
    reject: (proposalId, reason) =>
      run(`reject:${proposalId}`, reason, proposalId, (key) =>
        rejectRedistributionProposal(proposalId, reason, key),
      ),
  };
}
