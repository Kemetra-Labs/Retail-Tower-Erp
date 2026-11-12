/**
 * RT-1338 offer reads and writes (react-query). Keys carry the active tenant, so a tenant switch
 * re-queries and never shows another tenant's offers. Reads are not retried: the operator decides.
 *
 * Reads: the list (keyset, newest first, state filter), one offer, its immutable versions. A
 * store_manager's reads are filtered to their own stores by the server; nothing here assumes the
 * lists it gets are complete.
 *
 * Writes go through `useOfferWrites`: one hook, one method per operation. Each write is replayable
 * under its Idempotency-Key, kept through an unclear answer by `KeyedAttempt`. A write returns an
 * `OfferOutcome`, so components branch on data, not on thrown errors; a request that never completed
 * is the uncertain outcome. A good or stale answer refreshes the offer and the lists.
 */
import {
  type Offer,
  type OfferDefinition,
  type OfferListQuery,
  type OfferPage,
  type OfferPreview,
  type OfferSimulationRequest,
  type OfferSummary,
  type OfferVersion,
  consoleArchiveOffer,
  consoleCreateOfferDraft,
  consoleEndOffer,
  consoleGetOffer,
  consoleListOfferVersions,
  consoleListOffers,
  consolePauseOffer,
  consolePreviewOffer,
  consolePublishOffer,
  consoleResumeOffer,
  consoleUpdateOfferDraft,
} from "@/lib/offer-queries";
import { KeyedAttempt, errorRequestIdOf } from "@/lib/write-outcome";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { dedupeById, nextOfferCursor } from "./offerLogic";
import { type OfferOutcome, UNCERTAIN, classifyOfferResult } from "./offerOutcomes";

export interface OfferFilters {
  state?: OfferListQuery["state"];
}

const offerQueryKeys = {
  all: (tenantId: string | null) => ["offers", tenantId] as const,
  list: (tenantId: string | null, filters: OfferFilters) =>
    ["offers", tenantId, "list", filters] as const,
  detail: (tenantId: string | null, offerId: string) =>
    ["offers", tenantId, "detail", offerId] as const,
  versions: (tenantId: string | null, offerId: string) =>
    ["offers", tenantId, "versions", offerId] as const,
};

export type OfferReadError = {
  kind: "session" | "forbidden" | "notFound" | "generic";
  requestId?: string;
};

class OfferReadFailure extends Error {
  constructor(readonly detail: OfferReadError) {
    super("offer-read");
  }
}

function readError(status: number, error: unknown): OfferReadFailure {
  const requestId = errorRequestIdOf(error);
  if (status === 401) return new OfferReadFailure({ kind: "session", requestId });
  if (status === 403) return new OfferReadFailure({ kind: "forbidden", requestId });
  if (status === 404) return new OfferReadFailure({ kind: "notFound", requestId });
  return new OfferReadFailure({ kind: "generic", requestId });
}

function errorOf(error: unknown): OfferReadError | undefined {
  if (!error) return undefined;
  return error instanceof OfferReadFailure ? error.detail : { kind: "generic" };
}

export interface OfferListValue {
  rows: OfferSummary[];
  hasMore: boolean;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  error?: OfferReadError;
  loadMore: () => void;
}

const FIRST_PAGE: string | undefined = undefined;

async function readOfferPage(
  filters: OfferFilters,
  cursor: string | undefined,
): Promise<OfferPage> {
  const res = await consoleListOffers({ ...filters, cursor });
  if (res.status >= 400 || !res.data) throw readError(res.status, res.error);
  return res.data as OfferPage;
}

export function useOfferList(
  tenantId: string | null,
  filters: OfferFilters,
  enabled: boolean,
): OfferListValue {
  const query = useInfiniteQuery({
    queryKey: offerQueryKeys.list(tenantId, filters),
    enabled: enabled && Boolean(tenantId),
    initialPageParam: FIRST_PAGE,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      readOfferPage(filters, pageParam),
    getNextPageParam: (last) => nextOfferCursor(last),
    retry: false,
  });
  const loadMore = (): void => {
    if (!query.isFetchingNextPage && query.hasNextPage) void query.fetchNextPage();
  };
  return {
    rows: dedupeById(query.data?.pages.flatMap((page) => page.items) ?? []),
    hasMore: Boolean(query.hasNextPage),
    isLoading: query.isLoading && Boolean(tenantId),
    isFetchingNextPage: query.isFetchingNextPage,
    error: errorOf(query.error),
    loadMore,
  };
}

export interface OfferValue {
  offer: Offer | undefined;
  isLoading: boolean;
  error?: OfferReadError;
  reload: () => Promise<Offer | undefined>;
}

export function useOffer(tenantId: string | null, offerId: string | undefined): OfferValue {
  const query = useQuery({
    queryKey: offerQueryKeys.detail(tenantId, offerId ?? ""),
    enabled: Boolean(tenantId) && Boolean(offerId),
    queryFn: async () => {
      const res = await consoleGetOffer(offerId ?? "");
      if (res.status >= 400 || !res.data) throw readError(res.status, res.error);
      return res.data as Offer;
    },
    retry: false,
  });
  return {
    offer: query.data,
    isLoading: query.isLoading && Boolean(offerId),
    error: errorOf(query.error),
    reload: async () => (await query.refetch()).data,
  };
}

export function useOfferVersions(tenantId: string | null, offerId: string | undefined) {
  const query = useQuery({
    queryKey: offerQueryKeys.versions(tenantId, offerId ?? ""),
    enabled: Boolean(tenantId) && Boolean(offerId),
    queryFn: async () => {
      const res = await consoleListOfferVersions(offerId ?? "");
      if (res.status >= 400 || !res.data) throw readError(res.status, res.error);
      return res.data.items as OfferVersion[];
    },
    retry: false,
  });
  return { versions: query.data ?? [], isLoading: query.isLoading, failed: query.isError };
}

// --- Writes -----------------------------------------------------------------------------------

type Call<T> = (key: string) => Promise<{ status: number; data?: T; error?: unknown }>;

export interface OfferWrites {
  /** Create the offer with its first draft. */
  create: (definition: OfferDefinition) => Promise<OfferOutcome<Offer>>;
  /** Replace the draft; `expectedDraftRevision` is null to start the next draft of a published offer. */
  saveDraft: (
    offerId: string,
    expectedDraftRevision: number | null,
    definition: OfferDefinition,
  ) => Promise<OfferOutcome<Offer>>;
  /** Validate and preview the SAVED draft; writes nothing. */
  preview: (
    offerId: string,
    expectedDraftRevision: number,
    simulation?: OfferSimulationRequest,
  ) => Promise<OfferOutcome<OfferPreview>>;
  publish: (offerId: string, expectedDraftRevision: number) => Promise<OfferOutcome<Offer>>;
  pause: (
    offerId: string,
    body: { reason: string; storeIds?: string[] },
  ) => Promise<OfferOutcome<Offer>>;
  resume: (offerId: string, body: { storeIds?: string[] }) => Promise<OfferOutcome<Offer>>;
  end: (offerId: string) => Promise<OfferOutcome<Offer>>;
  archive: (offerId: string) => Promise<OfferOutcome<Offer>>;
}

export function useOfferWrites(tenantId: string | null): OfferWrites {
  const qc = useQueryClient();
  const attempts = useRef(new Map<string, KeyedAttempt>());

  function refresh(offerId?: string): void {
    void qc.invalidateQueries({ queryKey: offerQueryKeys.all(tenantId) });
    if (offerId) {
      void qc.invalidateQueries({ queryKey: offerQueryKeys.detail(tenantId, offerId) });
    }
  }

  async function run(
    op: string,
    fingerprint: string,
    offerId: string | undefined,
    call: Call<Offer>,
  ): Promise<OfferOutcome<Offer>> {
    const attempt = attempts.current.get(op) ?? new KeyedAttempt();
    attempts.current.set(op, attempt);
    let outcome: OfferOutcome<Offer>;
    try {
      outcome = classifyOfferResult(await call(attempt.keyFor(fingerprint)));
    } catch {
      outcome = UNCERTAIN;
    }
    // A key is held only through an answer that may not have landed; every other answer is terminal.
    if (outcome.kind !== "failed" || !outcome.keepKey) attempt.settle();
    if (outcome.kind === "ok") {
      qc.setQueryData(offerQueryKeys.detail(tenantId, outcome.data.offerId), outcome.data);
      refresh();
    } else if (outcome.kind === "stale") {
      refresh(offerId);
    }
    return outcome;
  }

  return {
    create: (definition) =>
      run("create", JSON.stringify(definition), undefined, (key) =>
        consoleCreateOfferDraft(definition, key),
      ),
    saveDraft: (offerId, rev, definition) =>
      run("save", JSON.stringify([offerId, rev, definition]), offerId, (key) =>
        consoleUpdateOfferDraft(offerId, rev, definition, key),
      ),
    preview: async (offerId, rev, simulation) => {
      try {
        return classifyOfferResult(await consolePreviewOffer(offerId, rev, simulation));
      } catch {
        return UNCERTAIN;
      }
    },
    publish: (offerId, rev) =>
      run("publish", JSON.stringify([offerId, rev]), offerId, (key) =>
        consolePublishOffer(offerId, rev, key),
      ),
    pause: (offerId, body) =>
      run("pause", JSON.stringify([offerId, body]), offerId, (key) =>
        consolePauseOffer(offerId, body, key),
      ),
    resume: (offerId, body) =>
      run("resume", JSON.stringify([offerId, body]), offerId, (key) =>
        consoleResumeOffer(offerId, body, key),
      ),
    end: (offerId) => run("end", offerId, offerId, (key) => consoleEndOffer(offerId, key)),
    archive: (offerId) =>
      run("archive", offerId, offerId, (key) => consoleArchiveOffer(offerId, key)),
  };
}
