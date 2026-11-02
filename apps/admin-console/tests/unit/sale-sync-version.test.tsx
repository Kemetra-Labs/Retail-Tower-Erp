import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SALE, ctx, ok, syncStatus, timeline } from "./sale-sync-fixtures";
import { readSource } from "./source-scan";

const api = {
  consoleGetSaleSyncStatus: vi.fn(),
  consoleGetSaleAuditTimeline: vi.fn(),
  consoleListNeedsRepair: vi.fn(),
  consoleRepairSaleSync: vi.fn(),
};
vi.mock("@/lib/sale-sync-ops-queries", () => ({
  consoleGetSaleSyncStatus: (...a: unknown[]) => api.consoleGetSaleSyncStatus(...a),
  consoleGetSaleAuditTimeline: (...a: unknown[]) => api.consoleGetSaleAuditTimeline(...a),
  consoleListNeedsRepair: (...a: unknown[]) => api.consoleListNeedsRepair(...a),
  consoleRepairSaleSync: (...a: unknown[]) => api.consoleRepairSaleSync(...a),
}));
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { createQueryClient } from "@/lib/query";
import { SaleSyncSections } from "@/sale-sync/SaleSyncSections";
import { saleQueryKeys } from "@/sales/useSales";

/**
 * RT-1072 (RT-973 §6, §7 slice 2): the sale detail's sync chip is reconciled by
 * `syncStatusVersion`, not last-write-wins.
 *   Edge case 1: a detail read in flight no longer holds the repair back.
 *   Edge case 2: a read that settles with a newer status is not overwritten.
 *   Absent on either side: the pre-RT-973 behaviour (write after the read).
 *   An errored read is never masked. No client timeout (E6).
 */
type Client = ReturnType<typeof createQueryClient>;
type CachedDetail = {
  summary: { syncStatus: string; syncStatusVersion?: number; voided?: boolean };
};

const DETAIL_KEY = saleQueryKeys.detail({ tenantId: "t1", activeStoreId: null }, SALE);

function seeded(summary: CachedDetail["summary"], updatedAt?: number): Client {
  const client = createQueryClient();
  client.setQueryData(DETAIL_KEY, { summary: { saleRef: SALE, ...summary } }, { updatedAt });
  return client;
}

const cached = (client: Client) => client.getQueryData<CachedDetail>(DETAIL_KEY)?.summary;

const statusRegion = () => screen.getByRole("region", { name: "Sale sync with the server" });

/** Starts a detail read that settles only when `finish` is called (or never). */
function readInFlight(client: Client) {
  let finish: (value: unknown) => void = () => {};
  const promise = new Promise((resolve) => {
    finish = resolve;
  });
  void client
    .fetchQuery({ queryKey: DETAIL_KEY, queryFn: () => promise, staleTime: 0, retry: false })
    .catch(() => undefined);
  return {
    settle: async (summary: CachedDetail["summary"]) => {
      await act(async () => {
        finish({ summary: { saleRef: SALE, ...summary } });
        await promise;
      });
    },
  };
}

async function repairWith(client: Client, version: number | undefined): Promise<void> {
  api.consoleRepairSaleSync.mockResolvedValue(
    ok(
      syncStatus({
        syncStatus: "failed-retryable",
        deadLetter: null,
        ...(version === undefined ? {} : { syncStatusVersion: version }),
      }),
    ),
  );
  render(
    <QueryClientProvider client={client}>
      <SaleSyncSections saleRef={SALE} timeZone="Africa/Cairo" />
    </QueryClientProvider>,
  );
  fireEvent.click(await within(statusRegion()).findByRole("button", { name: "Request repair" }));
  const confirm = screen.getByRole("region", { name: "Confirm the repair request" });
  fireEvent.click(within(confirm).getByRole("button", { name: "Confirm repair" }));
  await within(statusRegion()).findByText(/The server accepted the repair/);
}

describe("sale detail sync chip: version-based reconciliation (RT-973 §6)", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    activeContext.mockReturnValue(ctx("owner"));
    api.consoleGetSaleSyncStatus.mockResolvedValue(ok(syncStatus({ syncStatusVersion: 3 })));
    api.consoleGetSaleAuditTimeline.mockResolvedValue(ok(timeline()));
  });

  test("rule 1: a newer repair lands at once, with its version and the detail's freshness time", async () => {
    const client = seeded({ syncStatus: "failed-needs-repair", syncStatusVersion: 3 }, 1_000);
    await repairWith(client, 4);
    expect(cached(client)).toMatchObject({ syncStatus: "failed-retryable", syncStatusVersion: 4 });
    expect(client.getQueryState(DETAIL_KEY)?.dataUpdatedAt).toBe(1_000);
  });

  test("edge case 1: a detail read that never settles does not hold the repair back (no timeout)", async () => {
    const client = seeded({ syncStatus: "failed-needs-repair", syncStatusVersion: 3 });
    readInFlight(client);
    await repairWith(client, 4);
    await waitFor(() => expect(cached(client)?.syncStatus).toBe("failed-retryable"));
    expect(cached(client)?.syncStatusVersion).toBe(4);
    expect(client.getQueryState(DETAIL_KEY)?.fetchStatus).toBe("fetching");
  });

  test("edge case 2: a read that settles with a newer status is kept whole", async () => {
    const client = seeded({ syncStatus: "failed-needs-repair", syncStatusVersion: 3 });
    const read = readInFlight(client);
    await repairWith(client, 4);
    await read.settle({ syncStatus: "synced", syncStatusVersion: 5, voided: true });
    await waitFor(() => expect(client.getQueryState(DETAIL_KEY)?.fetchStatus).toBe("idle"));
    expect(cached(client)).toMatchObject({
      syncStatus: "synced",
      syncStatusVersion: 5,
      voided: true,
    });
  });

  test("rule 2: a read that settles older keeps the repair on top of its other fields", async () => {
    const client = seeded({ syncStatus: "failed-needs-repair", syncStatusVersion: 3 });
    const read = readInFlight(client);
    await repairWith(client, 4);
    await read.settle({ syncStatus: "failed-needs-repair", syncStatusVersion: 3, voided: true });
    await waitFor(() => expect(cached(client)?.syncStatus).toBe("failed-retryable"));
    expect(cached(client)).toMatchObject({ syncStatusVersion: 4, voided: true });
  });

  test("an equal version is the same status: the settled read is taken whole", async () => {
    const client = seeded({ syncStatus: "failed-needs-repair", syncStatusVersion: 3 });
    const read = readInFlight(client);
    await repairWith(client, 4);
    await read.settle({ syncStatus: "failed-retryable", syncStatusVersion: 4, voided: true });
    await waitFor(() => expect(cached(client)?.voided).toBe(true));
    expect(cached(client)).toMatchObject({ syncStatus: "failed-retryable", syncStatusVersion: 4 });
  });

  test("a replayed (older) repair never overwrites a newer cached detail", async () => {
    const client = seeded({ syncStatus: "synced", syncStatusVersion: 6 });
    await repairWith(client, 4);
    expect(cached(client)).toMatchObject({ syncStatus: "synced", syncStatusVersion: 6 });
  });

  test("a replayed (older) repair never overwrites a newer cached sync status", async () => {
    api.consoleGetSaleSyncStatus.mockResolvedValue(
      ok(syncStatus({ syncStatus: "failed-needs-repair", syncStatusVersion: 6 })),
    );
    const client = seeded({ syncStatus: "failed-needs-repair", syncStatusVersion: 6 });
    await repairWith(client, 4);
    const key = ["sale-sync", "t1", null, "status", SALE];
    expect(client.getQueryData<{ syncStatusVersion?: number }>(key)?.syncStatusVersion).toBe(6);
  });

  test("absent on the repair: the pre-RT-973 behaviour, written after the read in flight", async () => {
    const client = seeded({ syncStatus: "failed-needs-repair", syncStatusVersion: 3 });
    const read = readInFlight(client);
    await repairWith(client, undefined);
    // Not written while the read is in flight.
    expect(cached(client)?.syncStatus).toBe("failed-needs-repair");
    await read.settle({ syncStatus: "synced", syncStatusVersion: 5, voided: true });
    await waitFor(() => expect(cached(client)?.syncStatus).toBe("failed-retryable"));
    expect(cached(client)).toMatchObject({ syncStatusVersion: 5, voided: true });
  });

  test("absent on the cached detail: the pre-RT-973 behaviour, written after the read in flight", async () => {
    const client = seeded({ syncStatus: "failed-needs-repair" });
    const read = readInFlight(client);
    await repairWith(client, 4);
    expect(cached(client)?.syncStatus).toBe("failed-needs-repair");
    await read.settle({ syncStatus: "failed-needs-repair", voided: true });
    await waitFor(() => expect(cached(client)?.syncStatus).toBe("failed-retryable"));
    expect(cached(client)).toMatchObject({ syncStatusVersion: 4, voided: true });
  });

  test("absent on both sides and no read in flight: the repair is written as before", async () => {
    const client = seeded({ syncStatus: "failed-needs-repair" });
    await repairWith(client, undefined);
    expect(cached(client)?.syncStatus).toBe("failed-retryable");
    expect(cached(client)?.syncStatusVersion).toBeUndefined();
  });

  test("an errored read is never masked, even by a newer repair", async () => {
    const client = seeded({ syncStatus: "failed-needs-repair", syncStatusVersion: 3 });
    client
      .getQueryCache()
      .find({ queryKey: DETAIL_KEY })
      ?.setState({ status: "error", error: new Error("session ended") });
    await repairWith(client, 4);
    expect(client.getQueryState(DETAIL_KEY)?.status).toBe("error");
    expect(cached(client)?.syncStatus).toBe("failed-needs-repair");
  });

  test("a read in flight that then fails is not masked by the second write", async () => {
    const client = seeded({ syncStatus: "failed-needs-repair", syncStatusVersion: 3 });
    let fail: (error: Error) => void = () => {};
    const promise = new Promise((_, reject) => {
      fail = reject;
    });
    void client
      .fetchQuery({ queryKey: DETAIL_KEY, queryFn: () => promise, staleTime: 0, retry: false })
      .catch(() => undefined);
    await repairWith(client, 4);
    await act(async () => {
      fail(new Error("read failed"));
      await promise.catch(() => undefined);
    });
    await waitFor(() => expect(client.getQueryState(DETAIL_KEY)?.status).toBe("error"));
  });

  test("E6: the sync hooks add no client timeout or abort to the detail read", () => {
    const src = readSource("src/sale-sync/useSaleSync.ts");
    expect(src).not.toMatch(/AbortSignal|AbortController|setTimeout|timeout/);
  });
});
