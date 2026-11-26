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
import { canUseRedistribution, dedupeById, nextCursor } from "./redistributionLogic";
import {
  type RedistributionOutcome,
  UNCERTAIN,
  classifyRedistributionResult,
} from "./redistributionOutcomes";

/** The active tenant, and whether this user may use proposals there (role and all-store access). */
export function useRedistributionScope(): {
  tenantId: string | null;
  allowed: boolean;
} {
  const { context } = useActiveContextValue();
  const tenantId = context?.active_tenant?.id ?? null;
  const own = context?.memberships?.find((m) => m.tenant_id === tenantId);
  const access = storeAccessOf(context, own as ScopeMembership | undefined);
  return {
    tenantId,
    allowed: canUseRedistribution(roleCodeOf(context), access),
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
    if (outcome.kind === "ok") {
      const proposal = proposalIn(outcome.data);
      if (proposal) qc.setQueryData(keys.detail(tenantId, proposal.id), proposal);
      void qc.invalidateQueries({ queryKey: [...keys.all(tenantId), "list"] });
    } else if (outcome.refresh && proposalId) {
      void qc.invalidateQueries({ queryKey: keys.detail(tenantId, proposalId) });
      void qc.invalidateQueries({ queryKey: [...keys.all(tenantId), "list"] });
    }
    return outcome;
  }

  return {
    compute: (storeIds) => {
      const body = storeIds && storeIds.length > 0 ? { storeIds } : {};
      return run<ComputeAnswer>("compute", JSON.stringify(body), undefined, (key) =>
        createRedistributionProposal(body, key),
      );
    },
    review: (proposalId, decisions) =>
      run(`review:${proposalId}`, JSON.stringify(decisions), proposalId, (key) =>
        reviewRedistributionProposal(proposalId, decisions, key),
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
