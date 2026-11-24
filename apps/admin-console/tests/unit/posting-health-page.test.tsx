import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ctx, stores } from "./sale-fixtures";
import { CAIRO, EGP_USD_DAY, storeSummary, zeroDays } from "./sales-daily-fixtures";
import { ZERO_KPIS } from "./metric-claim-fixtures";

const consoleGetSalesSummary = vi.fn();
vi.mock("@/lib/sales-summary-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sales-summary-queries")>();
  return {
    ...actual,
    consoleGetSalesSummary: (...a: unknown[]) => consoleGetSalesSummary(...a),
  };
});
const listStores = vi.fn();
vi.mock("@/lib/rf2-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rf2-queries")>();
  return { ...actual, listStores: (...a: unknown[]) => listStores(...a) };
});
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { createQueryClient } from "@/lib/query";
import type { SalesKpis } from "@/metrics/metricRegistry";
import { PostingHealth } from "@/posting-health/PostingHealth";

/**
 * The posting-health report: the daily report's read, one verdict per day
 * from the served `erpPosting` counts, the server's range totals in the
 * footer, and a link to the repair queue for individual failed sales.
 */

function renderReport(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/posting-health"]}>
        <Routes>
          <Route path="/posting-health" element={<PostingHealth />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ok = (data: unknown) => ({ status: 200, data });
const failure = (status: number, code: string) => ({
  status,
  error: { error: { code, message: "x", request_id: "0190f000-0000-7000-8000-00000000e821" } },
});

const cairoStore = (over: Partial<Parameters<typeof storeSummary>[0]> = {}) => ({
  ref: CAIRO,
  timeZone: "Africa/Cairo",
  currentBusinessDate: "2026-10-23",
  ...over,
});

function postedDay(received: number, erpPosting: SalesKpis["erpPosting"]): SalesKpis {
  return {
    ...ZERO_KPIS,
    receivedSales: {
      count: received,
      byCurrency: [{ currencyCode: "EGP", count: received, total: "100.0000" }],
    },
    erpPosting,
  };
}

async function postingTable(): Promise<HTMLElement> {
  return screen.findByRole("table", { name: /posting by day/i });
}

function rowOf(table: HTMLElement, date: string): HTMLElement {
  const row = table.querySelector<HTMLElement>(`tr[data-business-date="${date}"]`);
  if (!row) throw new Error(`no row for ${date}`);
  return row;
}

describe("PostingHealth", () => {
  beforeEach(() => {
    consoleGetSalesSummary.mockReset();
    listStores.mockReset();
    activeContext.mockReset();
    activeContext.mockReturnValue(ctx("owner", "t1", CAIRO));
    listStores.mockResolvedValue({ status: 200, data: stores });
    consoleGetSalesSummary.mockResolvedValue(ok(storeSummary(cairoStore())));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T09:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("no active tenant: the scope prompt, and nothing is read", async () => {
    activeContext.mockReturnValue(ctx("owner", null));
    renderReport();
    expect(await screen.findByText(/select a tenant to view sales/i)).toBeDefined();
    expect(consoleGetSalesSummary).not.toHaveBeenCalled();
  });

  test("a role that cannot read the ERP surface gets the non-disclosing state", async () => {
    activeContext.mockReturnValue(ctx("store_staff", "t1", CAIRO));
    renderReport();
    expect(await screen.findByText(/not available to you/i)).toBeDefined();
    expect(consoleGetSalesSummary).not.toHaveBeenCalled();
  });

  test("one verdict per day from the served counts", async () => {
    consoleGetSalesSummary.mockResolvedValue(
      ok(
        storeSummary({
          ...cairoStore(),
          days: zeroDays("2026-10-16", "2026-10-23", {
            // received 5, posted 2, pending 1, unknown 2.
            "2026-10-16": EGP_USD_DAY,
            "2026-10-17": postedDay(3, { posted: 3, pending: 0, failed: 0, unknown: 0 }),
            "2026-10-18": postedDay(2, { posted: 1, pending: 0, failed: 1, unknown: 0 }),
            "2026-10-19": postedDay(2, { posted: 1, pending: 0, failed: 0, unknown: 1 }),
          }),
        }),
      ),
    );
    renderReport();
    const table = await postingTable();
    expect(consoleGetSalesSummary).toHaveBeenCalledTimes(1);
    expect(consoleGetSalesSummary).toHaveBeenCalledWith({
      from: "2026-10-16",
      to: "2026-10-23",
      store_id: CAIRO,
    });
    expect(rowOf(table, "2026-10-16").textContent).toMatch(/needs attention/i);
    expect(rowOf(table, "2026-10-17").textContent).toMatch(/fully posted/i);
    expect(rowOf(table, "2026-10-18").textContent).toMatch(/needs attention/i);
    expect(rowOf(table, "2026-10-19").textContent).toMatch(/no posting rows/i);
    expect(rowOf(table, "2026-10-20").textContent).toMatch(/no sales/i);
    expect(rowOf(table, "2026-10-23").textContent).toMatch(/running/i);
    expect(await screen.findByText("Completed days fully posted: 1 of 7.")).toBeDefined();
    expect(await screen.findByText("Completed days with failed postings: 1.")).toBeDefined();
    const foot = table.querySelector("tfoot") as HTMLElement;
    expect(foot.textContent).toMatch(/total so far/i);
    // The server's rangeTotals, figures no day adds up to.
    expect(within(foot).getByText("70")).toBeDefined();
    expect(within(foot).getAllByText("3")).toHaveLength(2);
    expect(within(foot).getByText("1")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Sales needing repair" }).getAttribute("href"),
    ).toBe("/sales-needing-repair");
  });

  test("a date missing from the read is Unknown, never 0", async () => {
    consoleGetSalesSummary.mockResolvedValue(
      ok(
        storeSummary({
          ...cairoStore(),
          days: zeroDays("2026-10-16", "2026-10-23").filter(
            (d) => d.businessDate !== "2026-10-19",
          ),
        }),
      ),
    );
    renderReport();
    const table = await postingTable();
    expect(rowOf(table, "2026-10-19").textContent).toMatch(/unknown/i);
    expect(rowOf(table, "2026-10-20").textContent).toMatch(/no sales/i);
  });

  test("a failed read shows the failure banner; Retry reads again", async () => {
    consoleGetSalesSummary.mockResolvedValue(failure(500, "server_error"));
    renderReport();
    expect(await screen.findByText(/could not be loaded/i)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(consoleGetSalesSummary).toHaveBeenCalledTimes(2);
  });
});
