import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-970 Overview v2: the KPI ledger strip, the pipeline strip, the 14-day
 * trend and the latest sales. Every number is an existing read (mocked here
 * at its typed wrapper); a missing source is «غير متاح», never 0.
 */
const consoleGetSalesSummary = vi.fn();
vi.mock("@/lib/sales-summary-queries", () => ({
  consoleGetSalesSummary: (...a: unknown[]) => consoleGetSalesSummary(...a),
}));
const consoleListDevices = vi.fn();
vi.mock("@/lib/device-queries", () => ({
  consoleListDevices: (...a: unknown[]) => consoleListDevices(...a),
}));
const consoleListSales = vi.fn();
vi.mock("@/lib/sale-queries", () => ({
  consoleListSales: (...a: unknown[]) => consoleListSales(...a),
}));
const quiet = () => Promise.resolve({ status: 200, data: { items: [], nextCursor: null } });
vi.mock("@/lib/stock-discrepancy-queries", () => ({
  listErpnextNegativeOnHandStores: () => quiet(),
}));
vi.mock("@/lib/shift-close-queries", () => ({ consoleListShiftCloses: () => quiet() }));
vi.mock("@/lib/unknown-items-queries", () => ({
  listUnknownItems: () => Promise.resolve({ status: 200, data: { items: [], next_cursor: null } }),
}));
vi.mock("@/stores/useStoreQueries", () => ({
  useStoreList: () => ({ result: { kind: "rows", rows: [] }, isLoading: false }),
}));
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { setLocale } from "@/i18n/locale";
import { createQueryClient } from "@/lib/query";
import { TREND_DAYS } from "@/overview/glanceLogic";
import { Overview } from "@/shell/Overview";
import { ZERO_KPIS } from "./metric-claim-fixtures";
import { CAIRO, NEW_YORK, dates, scopeSummary, storeSummary } from "./sales-daily-fixtures";

const NOW = "2026-10-23T10:00:00Z";
const TODAY = "2026-10-23";
const YESTERDAY = "2026-10-22";
const RANGE = { from: "2026-10-09", to: "2026-10-24" };

function day(count: number, egp: string, over: Partial<typeof ZERO_KPIS> = {}) {
  return {
    ...ZERO_KPIS,
    receivedSales: { count, byCurrency: [{ currencyCode: "EGP", count, total: egp }] },
    ...over,
  };
}

const TODAY_KPIS = day(338, "52318.5000", {
  returns: { count: 4, byCurrency: [{ currencyCode: "EGP", count: 4, total: "486.0000" }] },
  voids: { count: 1, byCurrency: [{ currencyCode: "EGP", count: 1, total: "57.2500" }] },
  erpPosting: { posted: 329, pending: 4, failed: 3, unknown: 2 },
});
const YESTERDAY_KPIS = day(310, "45000.0000", {
  returns: { count: 6, byCurrency: [{ currencyCode: "EGP", count: 6, total: "500.0000" }] },
  voids: { count: 1, byCurrency: [{ currencyCode: "EGP", count: 1, total: "10.0000" }] },
});

function storeRead() {
  return storeSummary(
    { ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: TODAY },
    { from: RANGE.from, to: TODAY },
    { [TODAY]: TODAY_KPIS, [YESTERDAY]: YESTERDAY_KPIS },
  );
}

const ok = (data: unknown) => Promise.resolve({ status: 200, data });
const fail = (status: number) =>
  Promise.resolve({ status, error: { error: { code: "x", request_id: "req-9" } } });

const SALE = {
  saleRef: "0190f000-0000-7000-8000-0000000005b1",
  storeRef: CAIRO,
  saleNumber: "R-0042",
  businessDate: TODAY,
  occurredAt: "2026-10-23T09:30:00Z",
  receivedAt: "2026-10-23T09:30:05Z",
  device: { deviceRef: null, label: "Till 1", labelSource: "recorded" },
  operator: { operatorRef: null, displayName: "Sara", nameSource: "recorded" },
  currencyCode: "EGP",
  posTotal: "412.75",
  syncStatus: "synced",
  voided: false,
  returnState: "none",
  erpPostingState: "unknown",
};

function ctx(role: string, store: { id: string; name: string } | null = null) {
  return {
    context: {
      active_tenant: { id: "t1", name: "Northstar Retail" },
      active_store: store,
      active_role_code: role,
    },
  };
}

function renderOverview(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const kpis = () => screen.getByRole("region", { name: "Today so far" });
const pipeline = () =>
  screen.getByRole("region", { name: "A sale's path from the till to ERPNext" });
const cell = (label: string) =>
  within(kpis()).getByText(label, { selector: "dt" }).parentElement as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  for (const fn of [consoleGetSalesSummary, consoleListDevices, consoleListSales, activeContext]) {
    fn.mockReset();
  }
  activeContext.mockReturnValue(ctx("owner", { id: CAIRO, name: "Cairo Festival City" }));
  consoleGetSalesSummary.mockImplementation(() => ok(storeRead()));
  consoleListDevices.mockImplementation(() => ok({ items: [{}, {}, {}], nextCursor: null }));
  consoleListSales.mockImplementation(() =>
    ok({ items: [SALE], nextCursor: null, storeTimezone: "Africa/Cairo" }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("one summary read feeds the strips and the trend", () => {
  test("reads once, over the 16-day window, narrowed to the active store", async () => {
    renderOverview();
    await screen.findByText("52,318.50 EGP");
    expect(consoleGetSalesSummary).toHaveBeenCalledTimes(1);
    expect(consoleGetSalesSummary).toHaveBeenCalledWith({
      store_id: CAIRO,
      ...RANGE,
      page_size: 50,
    });
  });
});

describe("KPI ledger strip", () => {
  test("four contract figures, today so far, each against the previous business day", async () => {
    renderOverview();
    await screen.findByText("52,318.50 EGP");
    expect(
      within(kpis())
        .getAllByRole("term")
        .map((dt) => dt.textContent),
    ).toEqual(["Received sales", "Transactions", "Returns", "Voids"]);
    // No figure the contract does not define (RT-751 AC 1).
    expect(within(kpis()).queryByText(/net|average|%/i)).toBeNull();
    const received = cell("Received sales");
    expect(received.textContent).toContain(
      "Higher than the previous business day in full (45,000.00 EGP)",
    );
    // An arrow reinforces the words; colour is never the only cue.
    expect(received.querySelector("svg[data-icon='increase']")).not.toBeNull();
    expect(cell("Transactions").textContent).toContain("338");
    expect(cell("Transactions").textContent).toContain(
      "Higher than the previous business day in full (310)",
    );
    expect(cell("Returns").textContent).toContain(
      "Lower than the previous business day in full (500.00 EGP)",
    );
    expect(cell("Returns").querySelector("svg[data-icon='decrease']")).not.toBeNull();
    expect(cell("Voids").textContent).toContain("Same as the previous business day in full (1)");
    expect(
      within(kpis()).getByText(/compared with the previous business day in full/),
    ).toBeTruthy();
  });

  test("a date the read lacks is «غير متاح» (Not available), never 0", async () => {
    const read = storeRead();
    read.stores[0].days = read.stores[0].days.filter((d) => d.businessDate !== TODAY);
    consoleGetSalesSummary.mockImplementation(() => ok(read));
    renderOverview();
    await screen.findAllByText("Not available");
    expect(within(cell("Received sales")).getByText("Not available")).toBeTruthy();
    expect(within(cell("Transactions")).getByText("Not available")).toBeTruthy();
    expect(within(cell("Transactions")).queryByText("0")).toBeNull();
    // The pipeline has no today either: no made-up counts.
    expect(within(pipeline()).getAllByText("Not available")).toHaveLength(2);
  });

  test("a missing previous day says so instead of comparing", async () => {
    const read = storeRead();
    read.stores[0].days = read.stores[0].days.filter((d) => d.businessDate !== YESTERDAY);
    consoleGetSalesSummary.mockImplementation(() => ok(read));
    renderOverview();
    await screen.findByText("52,318.50 EGP");
    expect(cell("Transactions").textContent).toContain("Previous business day: not available");
  });

  test("stores on different business days: no single today, a pointer to daily sales", async () => {
    activeContext.mockReturnValue(ctx("owner"));
    consoleGetSalesSummary.mockImplementation(() =>
      ok(
        scopeSummary(
          [
            { ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: TODAY },
            { ref: NEW_YORK, timeZone: "America/New_York", currentBusinessDate: YESTERDAY },
          ],
          { range: RANGE },
        ),
      ),
    );
    renderOverview();
    expect(await screen.findByText(/Stores are on different business days/)).toBeTruthy();
    expect(within(kpis()).getByRole("link", { name: "Daily received sales" })).toBeTruthy();
  });

  test("a failed read: an in-panel error with its request id and a retry, never zeros", async () => {
    consoleGetSalesSummary.mockImplementation(() => fail(500));
    renderOverview();
    const alert = await within(
      await screen.findByRole("region", { name: "Today so far" }),
    ).findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load this part. Nothing was changed.");
    expect(alert.textContent).toContain("req-9");
    consoleGetSalesSummary.mockImplementation(() => ok(storeRead()));
    await act(async () => {
      fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    });
    expect(await screen.findByText("52,318.50 EGP")).toBeTruthy();
    // The trend reads the same summary: one announcement, not two.
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  test("loading is a skeleton marked busy", () => {
    consoleGetSalesSummary.mockImplementation(() => new Promise(() => {}));
    renderOverview();
    expect(kpis().querySelector("[aria-busy='true']")).not.toBeNull();
  });

  test("a role the summary refuses: no strip, no trend; the pipeline says Not available", async () => {
    consoleGetSalesSummary.mockImplementation(() => fail(403));
    renderOverview();
    await within(pipeline()).findAllByText("Not available");
    expect(screen.queryByRole("region", { name: "Today so far" })).toBeNull();
    expect(screen.queryByText("Received sales, last 14 business days")).toBeNull();
  });
});

describe("pipeline strip", () => {
  test("active-trust devices, today's received count and the four posting buckets", async () => {
    renderOverview();
    expect(await within(pipeline()).findByText("Trusted devices: 3")).toBeTruthy();
    expect(consoleListDevices).toHaveBeenCalledWith({
      trust_state: "active",
      page_size: 50,
      store_id: CAIRO,
    });
    // Nothing claims connectivity the contract does not record.
    expect(within(pipeline()).queryByText(/online|offline|connected/i)).toBeNull();
    expect(within(pipeline()).getByText("Today's sales: 338")).toBeTruthy();
    expect(within(pipeline()).getByText("Posted: 329 of 338")).toBeTruthy();
    for (const part of ["Pending: 4", "Failed: 3", "Unknown: 2"]) {
      expect(within(pipeline()).getByText(part)).toBeTruthy();
    }
  });

  test("a further page of devices is 'or more'", async () => {
    consoleListDevices.mockImplementation(() => ok({ items: [{}, {}], nextCursor: "c2" }));
    renderOverview();
    expect(await within(pipeline()).findByText("Trusted devices: 2 or more")).toBeTruthy();
  });

  test("each step links to its screen, only where the role may go", async () => {
    renderOverview();
    await within(pipeline()).findByText("Posted: 329 of 338");
    expect(
      within(pipeline()).getByRole("link", { name: "View devices" }).getAttribute("href"),
    ).toBe("/devices");
    expect(within(pipeline()).getByRole("link", { name: "View sales" }).getAttribute("href")).toBe(
      `/sales?store=${CAIRO}&from=${TODAY}&to=${TODAY}`,
    );
    expect(
      within(pipeline()).getByRole("link", { name: "Repair sales" }).getAttribute("href"),
    ).toBe("/sales-needing-repair");
    cleanup();
    activeContext.mockReturnValue(ctx("store_manager", { id: CAIRO, name: "Cairo Festival City" }));
    renderOverview();
    await within(pipeline()).findByText("Posted: 329 of 338");
    expect(within(pipeline()).queryByRole("link", { name: "Repair sales" })).toBeNull();
    expect(within(pipeline()).queryByRole("link", { name: "Connection status" })).toBeNull();
  });

  test("a role that cannot read devices: the step is Not available, nothing is read", async () => {
    activeContext.mockReturnValue(ctx("store_staff", { id: CAIRO, name: "Cairo Festival City" }));
    renderOverview();
    const step = (await within(pipeline()).findByText("Points of sale")).closest(
      "li",
    ) as HTMLElement;
    expect(within(step).getByText("Not available")).toBeTruthy();
    expect(consoleListDevices).not.toHaveBeenCalled();
  });
});

describe("14-day trend", () => {
  test("a picture with a summary, and the same figures as a table on request", async () => {
    renderOverview();
    const chart = await screen.findByRole("img", { name: /Bars of received sales in EGP/ });
    // Data colour, never a status colour: the bars are the viz series.
    expect(chart.querySelectorAll(".daily-chart__bar").length).toBeGreaterThan(0);
    expect(
      chart.querySelector("[class*='badge'], [class*='danger'], [class*='success']"),
    ).toBeNull();
    const chartBtn = screen.getByRole("button", { name: "Chart" });
    expect(chartBtn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByRole("button", { name: "Table" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("img", { name: /Bars of received sales/ })).toBeNull();
    const table = screen.getByRole("table", { name: "Received sales, last 14 business days" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(TREND_DAYS);
    // Newest first; today is "So far".
    expect(rows[0].textContent).toContain("52,318.50 EGP");
    expect(rows[0].textContent).toContain("So far");
  });

  test("a date the read lacks is Unknown in the table, never 0", async () => {
    const read = storeRead();
    read.stores[0].days = read.stores[0].days.filter((d) => d.businessDate !== "2026-10-20");
    consoleGetSalesSummary.mockImplementation(() => ok(read));
    renderOverview();
    await screen.findByRole("img", { name: /Bars of received sales/ });
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    const row = screen
      .getAllByRole("row")
      .find((r) => r.querySelector("time")?.getAttribute("dateTime") === "2026-10-20");
    expect(row?.textContent).toContain("Unknown");
    expect(row?.textContent).toContain("—");
  });

  test("covers the last 14 business days of the read", () => {
    expect(dates("2026-10-10", TODAY)).toHaveLength(TREND_DAYS);
  });
});

describe("latest sales", () => {
  test("the active store's newest five, with the ERPNext badge, linking to each sale", async () => {
    renderOverview();
    const panel = await screen.findByRole("region", { name: "Latest sales" });
    const link = await within(panel).findByRole("link", { name: "R-0042" });
    expect(link.getAttribute("href")).toBe(`/sales/${SALE.saleRef}`);
    expect(within(panel).getByText("ERPNext posting state unknown")).toBeTruthy();
    const query = consoleListSales.mock.calls[0][0] as Record<string, unknown>;
    expect(query).toMatchObject({ store_id: CAIRO, page_size: 5, to: RANGE.to });
    const span = (Date.parse(String(query.to)) - Date.parse(String(query.from))) / 86_400_000;
    expect(span).toBeLessThanOrEqual(30);
  });

  test("tenant-wide the list needs a store: it says so and reads nothing", async () => {
    activeContext.mockReturnValue(ctx("owner"));
    consoleGetSalesSummary.mockImplementation(() =>
      ok(
        scopeSummary([{ ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: TODAY }], {
          range: RANGE,
        }),
      ),
    );
    renderOverview();
    expect(
      await screen.findByText("Choose a store in the scope switcher to see its latest sales."),
    ).toBeTruthy();
    expect(consoleListSales).not.toHaveBeenCalled();
  });
});

describe("Arabic", () => {
  test("the same strip in Arabic, with «غير متاح» for a missing figure", async () => {
    setLocale("ar");
    const read = storeRead();
    read.stores[0].days = read.stores[0].days.filter((d) => d.businessDate !== TODAY);
    consoleGetSalesSummary.mockImplementation(() => ok(read));
    renderOverview();
    expect((await screen.findAllByText("غير متاح")).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "مؤشرات اليوم حتى الآن" })).toBeTruthy();
  });
});
