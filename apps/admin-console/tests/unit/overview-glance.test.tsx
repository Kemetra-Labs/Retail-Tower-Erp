import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-993 Overview v4 (DESIGN.md §12.4, D-V7; owner decisions RT-993 comment
 * 15088): greeting and pipeline rail, one receipt row (a hero and three
 * cards), the trend against the previous period, today's ERPNext posting as a
 * part-to-whole ring, the latest sales, and the side column. Every number is
 * an existing read (mocked here at its typed wrapper); a missing source is
 * «غير متاح» or «قريبًا», never 0.
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
import { Overview } from "@/shell/Overview";
import { ZERO_KPIS } from "./metric-claim-fixtures";
import { CAIRO, NEW_YORK, scopeSummary, storeSummary } from "./sales-daily-fixtures";

const NOW = "2026-10-23T10:00:00Z";
const TODAY = "2026-10-23";
const YESTERDAY = "2026-10-22";
const RANGE = { from: "2026-09-25", to: "2026-10-24" };

function day(count: number, egp: string, over: Partial<typeof ZERO_KPIS> = {}) {
  return {
    ...ZERO_KPIS,
    receivedSales: { count, byCurrency: [{ currencyCode: "EGP", count, total: egp }] },
    ...over,
  };
}

const TODAY_KPIS = day(338, "52318.5000", {
  returns: { count: 4, byCurrency: [{ currencyCode: "EGP", count: 4, total: "486.0000" }] },
  voids: { count: 2, byCurrency: [{ currencyCode: "EGP", count: 2, total: "57.2500" }] },
  erpPosting: { posted: 329, pending: 4, failed: 3, unknown: 2 },
  syncStatus: { captured: 0, synced: 336, failedRetryable: 0, failedNeedsRepair: 2 },
});
const YESTERDAY_KPIS = day(310, "45000.0000", {
  returns: { count: 6, byCurrency: [{ currencyCode: "EGP", count: 6, total: "500.0000" }] },
  voids: { count: 1, byCurrency: [{ currencyCode: "EGP", count: 1, total: "10.0000" }] },
});
const SAME_DAY_LAST_WEEK = day(300, "40000.0000");

function storeRead() {
  return storeSummary(
    { ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: TODAY },
    { from: RANGE.from, to: TODAY },
    { [TODAY]: TODAY_KPIS, [YESTERDAY]: YESTERDAY_KPIS, "2026-10-16": SAME_DAY_LAST_WEEK },
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

function ctx(
  role: string,
  store: { id: string; name: string } | null = null,
  user: { display_name?: string | null } = { display_name: "Amal Saleh" },
) {
  return {
    context: {
      user: { id: "u1", email: "amal@northstar.eg", ...user },
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
const card = (label: string) => within(kpis()).getByRole("article", { name: label });
const rail = () => screen.getByRole("group", { name: "Sale pipeline" });
const node = (name: string) =>
  within(rail()).getByText(name, { selector: ".pipeline-rail__name" }).closest("li") as HTMLElement;
const trend = () =>
  screen.getByRole("region", { name: "Received sales: this period against the previous one" });
const posting = () => screen.getByRole("region", { name: "Today's sales in ERPNext" });

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

describe("one summary read feeds the row, the rail and both charts", () => {
  test("reads once, over the 30-day window, narrowed to the active store", async () => {
    renderOverview();
    await within(kpis()).findByText("52,318.50 EGP");
    expect(consoleGetSalesSummary).toHaveBeenCalledTimes(1);
    expect(consoleGetSalesSummary).toHaveBeenCalledWith({
      store_id: CAIRO,
      ...RANGE,
      page_size: 50,
    });
  });
});

describe("greeting", () => {
  test("the page's one h1 greets the user; the scope line stays the first fact", () => {
    renderOverview();
    const h1 = screen.getByRole("heading", { level: 1, name: "Welcome, Amal Saleh" });
    expect((h1.parentElement as HTMLElement).textContent).toContain("Northstar Retail");
  });

  test("no display name: the title is the page's name", () => {
    activeContext.mockReturnValue(
      ctx("owner", { id: CAIRO, name: "Cairo Festival City" }, { display_name: null }),
    );
    renderOverview();
    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
  });
});

describe("receipt row", () => {
  test("one hero and three cards, each a contract figure; nothing the contract lacks", async () => {
    renderOverview();
    await within(kpis()).findByText("52,318.50 EGP");
    expect(
      within(kpis())
        .getAllByRole("article")
        .map(
          (a) =>
            a.getAttribute("aria-label") ?? a.querySelector(".receipt-card__label")?.textContent,
        ),
    ).toEqual(["Received sales", "Transactions", "Returns", "Voids"]);
    expect(card("Received sales").classList.contains("receipt-card--hero")).toBe(true);
    expect(kpis().querySelectorAll(".receipt-card--hero")).toHaveLength(1);
    // RT-751 AC 1 / RT-975: no net sales and no average basket.
    expect(within(kpis()).queryByText(/net|average|basket/i)).toBeNull();
  });

  test("each card names its scope, period, baseline and freshness", async () => {
    renderOverview();
    await within(kpis()).findByText("52,318.50 EGP");
    const context = kpis().querySelector(".receipt-row__context") as HTMLElement;
    expect(context.textContent).toContain("Cairo Festival City · Today so far · ");
    expect(context.textContent).toContain("As of");
    for (const label of ["Received sales", "Transactions", "Returns", "Voids"]) {
      expect(card(label).getAttribute("aria-describedby")).toBe(context.id);
      expect(card(label).textContent).toMatch(/previous business day in full/);
    }
  });

  test("a delta shows the arrow, the signed value and the named baseline, coloured by good direction", async () => {
    renderOverview();
    await within(kpis()).findByText("52,318.50 EGP");
    const received = card("Received sales").querySelector(".glance-delta") as HTMLElement;
    expect(received.textContent).toContain("+7,318.50 EGP");
    expect(received.textContent).toContain(
      "Higher than the previous business day in full (45,000.00 EGP)",
    );
    expect(received.querySelector("svg[data-icon='increase']")).not.toBeNull();
    expect(received.dataset.tone).toBe("good");

    const count = card("Transactions").querySelector(".glance-delta") as HTMLElement;
    expect(count.textContent).toContain("+28");
    expect(count.dataset.tone).toBe("good");

    // Returns fell: good. Voids rose: bad (owner decision, §12.8.2).
    const returns = card("Returns").querySelector(".glance-delta") as HTMLElement;
    expect(returns.textContent).toContain("-14.00 EGP");
    expect(returns.querySelector("svg[data-icon='decrease']")).not.toBeNull();
    expect(returns.dataset.tone).toBe("good");
    const voids = card("Voids").querySelector(".glance-delta") as HTMLElement;
    expect(voids.textContent).toContain("+1");
    expect(voids.dataset.tone).toBe("bad");
  });

  test("the hero sparkline states its period and keeps gaps", async () => {
    const read = storeRead();
    read.stores[0].days = read.stores[0].days.filter((d) => d.businessDate !== "2026-10-20");
    consoleGetSalesSummary.mockImplementation(() => ok(read));
    renderOverview();
    await within(kpis()).findByText("52,318.50 EGP");
    const spark = await within(card("Received sales")).findByRole("img", {
      name: /Received sales in EGP over the last 14 business days/,
    });
    expect(within(card("Received sales")).getByText("Last 14 business days")).toBeTruthy();
    expect(spark.querySelectorAll("polyline").length).toBe(2);
  });

  test("a date the read lacks is «غير متاح» (Not available), never 0", async () => {
    const read = storeRead();
    read.stores[0].days = read.stores[0].days.filter((d) => d.businessDate !== TODAY);
    consoleGetSalesSummary.mockImplementation(() => ok(read));
    renderOverview();
    await within(kpis()).findAllByText("Not available");
    expect(within(card("Received sales")).getByText("Not available")).toBeTruthy();
    expect(within(card("Transactions")).getByText("Not available")).toBeTruthy();
    expect(within(card("Transactions")).queryByText("0")).toBeNull();
    // The rail has no today either: no made-up counts.
    expect(within(node("Server")).getByText("Not available")).toBeTruthy();
    expect(within(node("ERPNext")).getByText("Not available")).toBeTruthy();
  });

  test("a missing previous day says so instead of comparing", async () => {
    const read = storeRead();
    read.stores[0].days = read.stores[0].days.filter((d) => d.businessDate !== YESTERDAY);
    consoleGetSalesSummary.mockImplementation(() => ok(read));
    renderOverview();
    await within(kpis()).findByText("52,318.50 EGP");
    const delta = card("Transactions").querySelector(".glance-delta") as HTMLElement;
    expect(delta.textContent).toContain("Previous business day: not available");
    expect(delta.dataset.tone).toBe("neutral");
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
    expect(await within(kpis()).findByText("52,318.50 EGP")).toBeTruthy();
    // The charts read the same summary: one announcement, not three.
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  test("loading is a skeleton marked busy", () => {
    consoleGetSalesSummary.mockImplementation(() => new Promise(() => {}));
    renderOverview();
    expect(kpis().querySelector("[aria-busy='true']")).not.toBeNull();
  });

  test("a role the summary refuses: no row, no charts; the rail says Not available", async () => {
    consoleGetSalesSummary.mockImplementation(() => fail(403));
    renderOverview();
    await within(rail()).findAllByText("Not available");
    expect(screen.queryByRole("region", { name: "Today so far" })).toBeNull();
    expect(
      screen.queryByRole("region", {
        name: "Received sales: this period against the previous one",
      }),
    ).toBeNull();
    expect(screen.queryByRole("region", { name: "Today's sales in ERPNext" })).toBeNull();
  });
});

describe("pipeline rail", () => {
  test("three nodes, each a fact in words: devices, today's received count, posting", async () => {
    renderOverview();
    expect(await within(node("POS")).findByText("Trusted devices: 3")).toBeTruthy();
    expect(consoleListDevices).toHaveBeenCalledWith({
      trust_state: "active",
      page_size: 50,
      store_id: CAIRO,
    });
    // Nothing claims connectivity the contract does not record.
    expect(within(rail()).queryByText(/online|offline|connected/i)).toBeNull();
    expect(node("POS").querySelector("[data-status='unknown']")).not.toBeNull();
    expect(node("Server").textContent).toContain("Today's sales: 338");
    expect(node("Server").textContent).toContain("Failed, needs repair: 2");
    expect(node("Server").querySelector("[data-status='failed']")).not.toBeNull();
    const erp = node("ERPNext").textContent ?? "";
    for (const part of ["Posted: 329 of 338", "Pending: 4", "Failed: 3", "Unknown: 2"]) {
      expect(erp).toContain(part);
    }
    expect(node("ERPNext").querySelector("[data-status='failed']")).not.toBeNull();
  });

  test("a further page of devices is 'or more'", async () => {
    consoleListDevices.mockImplementation(() => ok({ items: [{}, {}], nextCursor: "c2" }));
    renderOverview();
    expect(await within(node("POS")).findByText("Trusted devices: 2 or more")).toBeTruthy();
  });

  test("the rail's screens are linked beside it, only where the role may go", async () => {
    renderOverview();
    await within(node("ERPNext")).findByText(/Posted: 329 of 338/);
    const links = screen.getByRole("navigation", { name: "Sale pipeline screens" });
    expect(within(links).getByRole("link", { name: "View devices" }).getAttribute("href")).toBe(
      "/devices",
    );
    expect(within(links).getByRole("link", { name: "View sales" }).getAttribute("href")).toBe(
      `/sales?store=${CAIRO}&from=${TODAY}&to=${TODAY}`,
    );
    expect(within(links).getByRole("link", { name: "Repair sales" }).getAttribute("href")).toBe(
      "/sales-needing-repair",
    );
    cleanup();
    activeContext.mockReturnValue(ctx("store_manager", { id: CAIRO, name: "Cairo Festival City" }));
    renderOverview();
    await within(node("ERPNext")).findByText(/Posted: 329 of 338/);
    expect(screen.queryByRole("link", { name: "Repair sales" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Connection status" })).toBeNull();
  });

  test("a role that cannot read devices: the node is Not available, nothing is read", async () => {
    activeContext.mockReturnValue(ctx("store_staff", { id: CAIRO, name: "Cairo Festival City" }));
    renderOverview();
    expect(await within(node("POS")).findByText("Not available")).toBeTruthy();
    expect(consoleListDevices).not.toHaveBeenCalled();
  });
});

describe("trend against the previous period", () => {
  test("states its question; a picture with a summary, two lines, and a legend", async () => {
    renderOverview();
    const chart = await within(trend()).findByRole("img", {
      name: /Lines of received sales in EGP: the last 14 business days/,
    });
    expect(
      within(trend()).getByText(
        "Are this period's daily sales above or below the same days of the period before?",
      ),
    ).toBeTruthy();
    expect(chart.querySelectorAll(".trend-chart__line--current").length).toBeGreaterThan(0);
    expect(chart.querySelectorAll(".trend-chart__line--previous").length).toBeGreaterThan(0);
    // Identity never by colour alone: a legend names both lines.
    expect(within(trend()).getByText("This period")).toBeTruthy();
    expect(within(trend()).getByText("Previous period")).toBeTruthy();
    // Data colour, never a status colour.
    expect(chart.querySelector("[class*='danger'], [class*='success']")).toBeNull();
  });

  test("the period is a segmented control: 7 or 14 days", async () => {
    renderOverview();
    await within(trend()).findByRole("img");
    const seven = within(trend()).getByRole("button", { name: "7 days" });
    expect(
      within(trend()).getByRole("button", { name: "14 days" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(seven);
    expect(seven.getAttribute("aria-pressed")).toBe("true");
    expect(within(trend()).getByRole("img", { name: /the last 7 business days/ })).toBeTruthy();
    expect(consoleGetSalesSummary).toHaveBeenCalledTimes(1);
  });

  test("a hover over a late day survives a switch to the shorter period (keyboard, no pointerleave)", async () => {
    renderOverview();
    const chart = await within(trend()).findByRole("img");
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 560,
      height: 204,
      right: 560,
      bottom: 204,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    // Near the newest day: index 13 of 14 (the hover tooltip shows its difference).
    fireEvent.pointerMove(chart, { clientX: 550, clientY: 100 });
    expect(trend().querySelector(".trend-chart__tip")).not.toBeNull();
    fireEvent.click(within(trend()).getByRole("button", { name: "7 days" }));
    expect(within(trend()).getByRole("img", { name: /the last 7 business days/ })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("the same figures as a table: each day beside the same day of the previous period", async () => {
    renderOverview();
    await within(trend()).findByRole("img");
    fireEvent.click(within(trend()).getByRole("button", { name: "7 days" }));
    fireEvent.click(within(trend()).getByRole("button", { name: "Table" }));
    expect(within(trend()).queryByRole("img")).toBeNull();
    const table = within(trend()).getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(7);
    // Newest first; today is "So far" and compared with 2026-10-16.
    expect(rows[0].textContent).toContain("52,318.50 EGP");
    expect(rows[0].textContent).toContain("40,000.00 EGP");
    expect(rows[0].textContent).toContain("+12,318.50 EGP");
    expect(rows[0].textContent).toContain("So far");
  });

  test("a date the read lacks is Unknown in the table and a gap in the chart, never 0", async () => {
    const read = storeRead();
    read.stores[0].days = read.stores[0].days.filter((d) => d.businessDate !== "2026-10-20");
    consoleGetSalesSummary.mockImplementation(() => ok(read));
    renderOverview();
    const chart = await within(trend()).findByRole("img");
    expect(chart.querySelectorAll(".trend-chart__line--current")).toHaveLength(2);
    fireEvent.click(within(trend()).getByRole("button", { name: "Table" }));
    const row = within(trend())
      .getAllByRole("row")
      .find((r) => r.querySelector("time")?.getAttribute("dateTime") === "2026-10-20");
    expect(row?.textContent).toContain("Unknown");
    expect(row?.textContent).toContain("—");
  });
});

describe("today's posting, part to whole", () => {
  test("states its question; a ring of the four posting buckets and a real table", async () => {
    renderOverview();
    const ring = await within(posting()).findByRole("img", {
      name: /Ring of today's 338 received sales by ERPNext posting state/,
    });
    expect(
      within(posting()).getByText("Of today's received sales, how many has ERPNext posted?"),
    ).toBeTruthy();
    // At most five parts, in the viz palette, never status colours.
    const arcs = ring.querySelectorAll(".posting-ring__arc");
    expect(arcs.length).toBeLessThanOrEqual(5);
    expect(arcs.length).toBe(4);
    const table = within(posting()).getByRole("table", {
      name: "Share of today's 338 received sales",
    });
    const rows = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.textContent);
    expect(rows[0]).toContain("Posted");
    expect(rows[0]).toContain("329");
    expect(rows[0]).toContain("97.3%");
    expect(rows[3]).toContain("Unknown");
    // Unknown is never "not posted" (RT-956).
    expect(within(posting()).getByText(/never means not posted/i)).toBeTruthy();
  });

  test("no sale received today: says so, no 0/0 ring", async () => {
    const read = storeRead();
    read.stores[0].days = read.stores[0].days.map((d) =>
      d.businessDate === TODAY ? { ...d, kpis: ZERO_KPIS } : d,
    );
    consoleGetSalesSummary.mockImplementation(() => ok(read));
    renderOverview();
    expect(await within(posting()).findByText("No sales received today yet.")).toBeTruthy();
    expect(within(posting()).queryByRole("img")).toBeNull();
    expect(within(posting()).queryByText(/%/)).toBeNull();
  });
});

describe("side column", () => {
  test("at most four quick actions, each a destination the role may open, with a description", async () => {
    renderOverview();
    const quick = screen.getByRole("navigation", { name: "Quick actions" });
    const links = within(quick).getAllByRole("link");
    expect(links.length).toBeLessThanOrEqual(4);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/sales-daily",
      "/sales-needing-repair",
      "/catalog/products",
      "/operators",
    ]);
    for (const link of links) expect(link.getAttribute("aria-describedby")).toBeTruthy();
    cleanup();
    activeContext.mockReturnValue(ctx("store_manager", { id: CAIRO, name: "Cairo Festival City" }));
    renderOverview();
    const managerLinks = within(
      screen.getByRole("navigation", { name: "Quick actions" }),
    ).getAllByRole("link");
    expect(managerLinks.map((a) => a.getAttribute("href"))).not.toContain("/sales-needing-repair");
  });

  test("stores today and low stock: a clear «قريبًا» frame and no invented numbers", async () => {
    renderOverview();
    for (const name of ["Stores today", "Low stock"]) {
      const region = screen.getByRole("region", { name });
      expect(within(region).getByText("Coming soon")).toBeTruthy();
      expect(region.textContent).not.toMatch(/\d/);
    }
  });

  test("the attention list keeps its place in the side column", async () => {
    renderOverview();
    const side = screen.getByRole("region", { name: "Overview side column" });
    expect(within(side).getByRole("region", { name: "Needs your attention" })).toBeTruthy();
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
  test("the same row in Arabic, «غير متاح» for a missing figure, «قريبًا» for a missing read", async () => {
    setLocale("ar");
    const read = storeRead();
    read.stores[0].days = read.stores[0].days.filter((d) => d.businessDate !== TODAY);
    consoleGetSalesSummary.mockImplementation(() => ok(read));
    renderOverview();
    expect((await screen.findAllByText("غير متاح")).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "مؤشرات اليوم حتى الآن" })).toBeTruthy();
    expect(screen.getAllByText("قريبًا").length).toBeGreaterThanOrEqual(2);
  });
});
