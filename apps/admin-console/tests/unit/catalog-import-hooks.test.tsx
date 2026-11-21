import { useImportRows } from "@/catalog-import/useCatalogImport";
import { usePublishFlow } from "@/catalog-import/usePublishFlow";
import type { CatalogImportPreview } from "@/lib/catalog-import-queries";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-1509: the publish flow and the row pager, against a mocked query layer.
 * Publish: one Idempotency-Key per intended publish; an unclear answer is resent as it was (same key,
 * same body) and never reads as published; only the server's batch opens the result.
 * Rows: keyset pages keep what is shown when a continuation fails and restart when the filter or the
 * validation run changes.
 */
const queries = vi.hoisted(() => ({
  consolePublishCatalogImport: vi.fn(),
  consoleGetCatalogImport: vi.fn(),
  consoleListCatalogImportRows: vi.fn(),
}));
vi.mock("@/lib/catalog-import-queries", () => queries);

const PREVIEW = { version: 4, previewHash: "sha256:bbbb" } as CatalogImportPreview;
const PUBLISHED = { state: "published", batchId: "b" };
const SUMMARY = { productsCreated: 1 };

function flow() {
  const onPublished = vi.fn();
  const onRouted = vi.fn();
  const reread = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(() => usePublishFlow({ batchId: "b", onPublished, onRouted, reread }));
  return { hook, onPublished, onRouted, reread };
}

beforeEach(() => vi.resetAllMocks());

describe("usePublishFlow", () => {
  test("an unclear answer is never success, and the resend carries the same key and body", async () => {
    queries.consolePublishCatalogImport
      .mockResolvedValueOnce({ status: 0 })
      .mockResolvedValueOnce({ status: 200, data: { batch: PUBLISHED, summary: SUMMARY } });
    const { hook, onPublished } = flow();

    await act(() => hook.result.current.publish(PREVIEW));
    expect(hook.result.current.phase).toBe("unclear");
    expect(onPublished).not.toHaveBeenCalled();

    await act(() => hook.result.current.resend());
    const [first, second] = queries.consolePublishCatalogImport.mock.calls;
    expect(second?.[1]).toEqual(first?.[1]);
    expect(first?.[1]).toEqual({ expectedVersion: 4, previewHash: "sha256:bbbb" });
    expect(second?.[2]).toBe(first?.[2]);
    expect(onPublished).toHaveBeenCalledWith(PUBLISHED, SUMMARY, false);
    expect(hook.result.current.phase).toBe("idle");
  });

  test("a 425 and a 5xx are unclear; a 425 carries its wait", async () => {
    queries.consolePublishCatalogImport.mockResolvedValueOnce({
      status: 425,
      error: { error: "idempotency_in_progress", retryAfterSec: 2 },
    });
    const { hook } = flow();
    await act(() => hook.result.current.publish(PREVIEW));
    expect(hook.result.current.phase).toBe("unclear");
    expect(hook.result.current.unclear?.retryAfterSec).toBe(2);
  });

  test("a terminal refusal settles the key: the next publish is a new action", async () => {
    queries.consolePublishCatalogImport
      .mockResolvedValueOnce({ status: 409, error: { error: { code: "preview_changed" } } })
      .mockResolvedValueOnce({ status: 409, error: { error: { code: "preview_changed" } } });
    const { hook, onRouted } = flow();
    await act(() => hook.result.current.publish(PREVIEW));
    await act(() => hook.result.current.publish(PREVIEW));
    const [first, second] = queries.consolePublishCatalogImport.mock.calls;
    expect(second?.[2]).not.toBe(first?.[2]);
    expect(onRouted).toHaveBeenCalledWith({ notice: "previewChanged", step: "preview" });
  });

  test("stale_validation routes back to Validate with its notice", async () => {
    queries.consolePublishCatalogImport.mockResolvedValueOnce({
      status: 409,
      error: { error: { code: "stale_validation" } },
    });
    const { hook, onRouted, reread } = flow();
    await act(() => hook.result.current.publish(PREVIEW));
    expect(onRouted).toHaveBeenCalledWith({ notice: "stale", step: "validate" });
    expect(reread).toHaveBeenCalled();
  });

  test("refresh opens the result only for a published batch; otherwise it stays unclear", async () => {
    queries.consolePublishCatalogImport.mockResolvedValue({ status: 0 });
    const { hook, onPublished } = flow();
    await act(() => hook.result.current.publish(PREVIEW));

    queries.consoleGetCatalogImport.mockResolvedValueOnce({
      status: 200,
      data: { state: "validated" },
    });
    await act(() => hook.result.current.refresh());
    expect(hook.result.current.phase).toBe("unclear");
    expect(hook.result.current.notPublished).toBe(true);
    expect(onPublished).not.toHaveBeenCalled();

    queries.consoleGetCatalogImport.mockResolvedValueOnce({ status: 200, data: PUBLISHED });
    await act(() => hook.result.current.refresh());
    expect(onPublished).toHaveBeenCalledWith(PUBLISHED, null, false);
    expect(hook.result.current.phase).toBe("idle");
  });

  test("a replay is passed on as a replay", async () => {
    queries.consolePublishCatalogImport.mockResolvedValueOnce({
      status: 200,
      replayed: true,
      data: { batch: PUBLISHED, summary: SUMMARY },
    });
    const { hook, onPublished } = flow();
    await act(() => hook.result.current.publish(PREVIEW));
    expect(onPublished).toHaveBeenCalledWith(PUBLISHED, SUMMARY, true);
  });
});

function page(items: number[], nextCursor: string | null) {
  return {
    status: 200,
    data: { items: items.map((rowNumber) => ({ rowNumber, status: "error" })), nextCursor },
  };
}

describe("useImportRows", () => {
  test("keeps the rows shown when a continuation fails, then walks on", async () => {
    queries.consoleListCatalogImportRows
      .mockResolvedValueOnce(page([2], "c1"))
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValueOnce(page([3], null));
    const { result } = renderHook(() => useImportRows("b", undefined, 0));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.moreFailed).toBe(true));
    expect(result.current.rows).toHaveLength(1);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.rows.map((r) => r.rowNumber)).toEqual([2, 3]));
    expect(result.current.hasMore).toBe(false);
    expect(queries.consoleListCatalogImportRows.mock.calls[1]?.[1]).toMatchObject({ cursor: "c1" });
  });

  test("restarts without a cursor when the filter or the validation run changes", async () => {
    queries.consoleListCatalogImportRows.mockResolvedValue(page([2], "c1"));
    const { rerender } = renderHook(({ status, run }) => useImportRows("b", status, run), {
      initialProps: { status: undefined as "error" | undefined, run: 0 },
    });
    await waitFor(() => expect(queries.consoleListCatalogImportRows).toHaveBeenCalledTimes(1));
    rerender({ status: "error", run: 0 });
    await waitFor(() => expect(queries.consoleListCatalogImportRows).toHaveBeenCalledTimes(2));
    rerender({ status: "error", run: 1 });
    await waitFor(() => expect(queries.consoleListCatalogImportRows).toHaveBeenCalledTimes(3));
    for (const call of queries.consoleListCatalogImportRows.mock.calls) {
      expect(call[1].cursor).toBeUndefined();
    }
    expect(queries.consoleListCatalogImportRows.mock.calls[1]?.[1]).toMatchObject({
      status: "error",
    });
  });

  test("a failed first page is an error, and a decided row replaces its old self", async () => {
    queries.consoleListCatalogImportRows.mockResolvedValueOnce({ status: 500 });
    const failed = renderHook(() => useImportRows("b", undefined, 0));
    await waitFor(() => expect(failed.result.current.error?.kind).toBe("failed"));

    queries.consoleListCatalogImportRows.mockResolvedValueOnce(page([2, 3], null));
    const ok = renderHook(() => useImportRows("b", undefined, 0));
    await waitFor(() => expect(ok.result.current.rows).toHaveLength(2));
    act(() => ok.result.current.replaceRow({ rowNumber: 3, status: "excluded" } as never));
    expect(ok.result.current.rows.find((r) => r.rowNumber === 3)?.status).toBe("excluded");
    expect(ok.result.current.rows.find((r) => r.rowNumber === 2)?.status).toBe("error");
  });
});
