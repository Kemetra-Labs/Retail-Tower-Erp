/**
 * RT-1509 reads of the import workspace: the batch, the preview and the keyset row pages.
 *
 * Every read is scope-keyed by the active tenant and role (`useReadScope`), never reused across a
 * tenant switch. The batch lives in the query cache so a write can put its answer there
 * (`useBatchCache`), and the next write chains the new `version`. The preview is a snapshot read
 * fresh on every mount. Row pages keep what is shown when a continuation fails (UX-10.18) and
 * restart without a cursor when the status filter or the validation run changes (the cursor is
 * bound to both).
 */
import {
  type CatalogImportBatch,
  type CatalogImportPreview,
  type CatalogImportRow,
  type RowStatus,
  consoleGetCatalogImport,
  consoleGetCatalogImportPreview,
  consoleListCatalogImportRows,
} from "@/lib/catalog-import-queries";
import { type Read, type ReadError, useReadScope, useServerRead } from "@/lib/server-read";
import { errorRequestIdOf } from "@/lib/write-outcome";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

const ROOT = "catalog-import";

export function useImportBatch(batchId: string | undefined): Read<CatalogImportBatch> {
  const { tenantId, role } = useReadScope();
  return useServerRead({
    queryKey: [ROOT, "batch", tenantId, role, batchId],
    enabled: tenantId !== null && batchId !== undefined,
    fetcher: () => consoleGetCatalogImport(batchId as string),
  });
}

/** Put a write's returned batch in the cache, so the next write chains its `version`. */
export function useBatchCache(batchId: string | undefined): {
  store: (batch: CatalogImportBatch) => void;
  patch: (change: (batch: CatalogImportBatch) => CatalogImportBatch) => void;
  reread: () => Promise<void>;
} {
  const qc = useQueryClient();
  const { tenantId, role } = useReadScope();
  const key = [ROOT, "batch", tenantId, role, batchId];
  return {
    store: (batch) => qc.setQueryData(key, batch),
    patch: (change) => qc.setQueryData<CatalogImportBatch>(key, (old) => (old ? change(old) : old)),
    reread: () => qc.invalidateQueries({ queryKey: key }),
  };
}

/** What publish would do, for exactly the `previewHash` it names. A snapshot: read fresh each mount. */
export function useImportPreview(
  batchId: string,
  enabled: boolean,
  revision: number,
): Read<CatalogImportPreview> {
  const { tenantId, role } = useReadScope();
  return useServerRead({
    queryKey: [ROOT, "preview", tenantId, role, batchId, revision],
    enabled: tenantId !== null && enabled,
    fetcher: () => consoleGetCatalogImportPreview(batchId),
    fresh: true,
  });
}

export interface RowPager {
  rows: readonly CatalogImportRow[];
  /** The first page is loading. */
  loading: boolean;
  /** The first page failed. */
  error: ReadError | undefined;
  hasMore: boolean;
  loadingMore: boolean;
  /** A continuation failed: the rows already shown stay as they are. */
  moreFailed: boolean;
  loadMore: () => void;
  reload: () => void;
  /** Replace a row after a decision (the answer is the server's row). */
  replaceRow: (row: CatalogImportRow) => void;
}

interface PagerState {
  rows: CatalogImportRow[];
  cursor: string | null | undefined;
  loading: boolean;
  error: ReadError | undefined;
  loadingMore: boolean;
  moreFailed: boolean;
}

const EMPTY: PagerState = {
  rows: [],
  cursor: undefined,
  loading: true,
  error: undefined,
  loadingMore: false,
  moreFailed: false,
};

/**
 * Keyset pages of one status (or every row). `run` changes when validate ran again: the walk restarts
 * from the first page, never reusing a cursor of an older validation generation.
 */
export function useImportRows(
  batchId: string,
  status: RowStatus | undefined,
  run: number,
  enabled = true,
): RowPager {
  const [state, setState] = useState<PagerState>(EMPTY);
  const seq = useRef(0);

  const fetchPage = useCallback(
    async (cursor: string | undefined): Promise<void> => {
      const mine = ++seq.current;
      const res = await consoleListCatalogImportRows(batchId, { status, cursor, limit: 50 }).catch(
        () => ({ status: 0, data: undefined, error: undefined }),
      );
      if (mine !== seq.current) return;
      if (res.status === 200 && res.data) {
        const page = res.data;
        setState((s) => ({
          rows: cursor === undefined ? [...page.items] : [...s.rows, ...page.items],
          cursor: page.nextCursor,
          loading: false,
          error: undefined,
          loadingMore: false,
          moreFailed: false,
        }));
        return;
      }
      const failure: ReadError = {
        kind: res.status === 404 ? "not-available" : "failed",
        requestId: errorRequestIdOf(res.error),
      };
      setState((s) =>
        cursor === undefined
          ? { ...EMPTY, loading: false, error: failure }
          : { ...s, loadingMore: false, moreFailed: true },
      );
    },
    [batchId, status],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` restarts the walk on purpose.
  useEffect(() => {
    if (!enabled) return;
    setState(EMPTY);
    void fetchPage(undefined);
  }, [enabled, fetchPage, run]);

  const loadMore = useCallback(() => {
    if (typeof state.cursor !== "string") return;
    const next = state.cursor;
    setState((s) => ({ ...s, loadingMore: true, moreFailed: false }));
    void fetchPage(next);
  }, [state.cursor, fetchPage]);

  const reload = useCallback(() => {
    setState(EMPTY);
    void fetchPage(undefined);
  }, [fetchPage]);

  const replaceRow = useCallback((row: CatalogImportRow) => {
    setState((s) => ({
      ...s,
      rows: s.rows.map((r) => (r.rowNumber === row.rowNumber ? row : r)),
    }));
  }, []);

  return {
    rows: state.rows,
    loading: state.loading,
    error: state.error,
    hasMore: typeof state.cursor === "string",
    loadingMore: state.loadingMore,
    moreFailed: state.moreFailed,
    loadMore,
    reload,
    replaceRow,
  };
}
