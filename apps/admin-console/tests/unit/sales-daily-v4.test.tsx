import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ctx, stores } from "./sale-fixtures";
import {
  CAIRO,
  EGP_USD_DAY,
  NEW_YORK,
  scopeSummary,
  storeSummary,
  zeroDays,
} from "./sales-daily-fixtures";

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
import { SalesDaily } from "@/sales-daily/SalesDaily";

/**
 * RT-1020 (v4.0) the daily report's Ink band and day panel. The band's facts are
 * the served period, zone(s) and read time (no range total, which is per
 * currency); the day panel shows one day's served figures, never a sum and never
 * an unknown as 0.
 */

function renderReport(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/sales-daily"]}>
        <Routes>
          <Route path="/reports" element={<p>reports index</p>} />
          <Route path="/sales" element={<p>sales list</p>} />
          <Route path="/sales-daily" element={<SalesDaily />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ok = (data: unknown) => ({ status: 200, data });
const cairoStore = (over: Record<string, unknown> = {}) => ({
  ref: CAIRO,
  timeZone: "Africa/Cairo",
  currentBusinessDate: "2026-10-23",
  ...over,
});

async function dayPanel(): Promise<HTMLElement> {
  // The first render of a cold file can take longer than the 1s default.
  return screen.findByRole("complementary", { name: "Business day detail" }, { timeout: 5000 });
}

function factOf(label: string): string {
  const dt = screen.getByText(label, { selector: "dt" });
  return dt.parentElement?.querySelector("dd")?.textContent ?? "";
}

describe("SalesDaily v4 band and day panel (RT-1020)", () => {
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
    cleanup();
    vi.useRealTimers();
  });

  test("the band names the store and tenant, with the served period, zone and read time", async () => {
    renderReport();
    // Nothing is claimed before the read arrives.
    expect(document.querySelector(".list-band__facts")).toBeNull();
    await dayPanel();
    const h1 = screen.getByRole("heading", { level: 1, name: "Daily received sales" });
    const band = h1.closest(".list-band") as HTMLElement;
    expect(band.textContent).toContain("Reports · Sales");
    expect(band.textContent).toContain("Cairo Festival · Northstar Retail");
    const facts = screen.getByLabelText("Report context from the server");
    expect(facts.tagName).toBe("DL");
    expect(factOf("Period")).toMatch(/16.*23/);
    expect(factOf("Time zone")).toBe("Africa/Cairo");
    expect(factOf("Read at")).not.toBe("");
    // At most three facts, and no money among them.
    expect(facts.querySelectorAll("dt")).toHaveLength(3);
    expect(facts.textContent).not.toMatch(/EGP|USD/);
  });

  test("a whole-scope read says so in the subtitle and lists each zone once", async () => {
    activeContext.mockReturnValue(ctx("owner", "t1"));
    consoleGetSalesSummary.mockResolvedValue(
      ok(
        scopeSummary(
          [
            { ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-24" },
            { ref: NEW_YORK, timeZone: "America/New_York", currentBusinessDate: "2026-10-23" },
          ],
          { range: { from: "2026-10-17", to: "2026-10-24" } },
        ),
      ),
    );
    renderReport();
    await dayPanel();
    const band = screen.getByRole("heading", { level: 1 }).closest(".list-band") as HTMLElement;
    expect(band.textContent).toContain("All stores in scope · Northstar Retail");
    expect(factOf("Time zone")).toBe("Africa/Cairo, America/New_York");
  });

  test("a read that covers only the first page of stores says the zone list is partial", async () => {
    activeContext.mockReturnValue(ctx("owner", "t1"));
    consoleGetSalesSummary.mockResolvedValue(
      ok(
        scopeSummary(
          [{ ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-24" }],
          { range: { from: "2026-10-17", to: "2026-10-24" }, storeCount: 60, nextCursor: "c2" },
        ),
      ),
    );
    renderReport();
    await dayPanel();
    expect(factOf("Time zone")).toMatch(/zones of the first 1 store only/i);
  });

  test("the report links back to the index and to Sales", async () => {
    renderReport();
    await dayPanel();
    expect(screen.getByRole("link", { name: "Reports" }).getAttribute("href")).toBe("/reports");
    expect(screen.getByRole("link", { name: "Sales" }).getAttribute("href")).toBe("/sales");
  });

  test("the day panel opens on the latest day, in words, and follows the chosen day's served figures", async () => {
    consoleGetSalesSummary.mockResolvedValue(
      ok(storeSummary(cairoStore(), undefined, { "2026-10-20": EGP_USD_DAY })),
    );
    renderReport();
    const panel = await dayPanel();
    const picker = within(panel).getByLabelText("Business day") as HTMLSelectElement;
    expect(picker.value).toBe("2026-10-23");
    expect(panel.querySelector(".daily-table__mark")?.textContent).toMatch(/so far/i);
    fireEvent.change(picker, { target: { value: "2026-10-20" } });
    // The day's served lines, one per currency, never added.
    expect(panel.textContent).toContain("1,250.50 EGP");
    expect(panel.textContent).toContain("40.00 USD");
    expect(panel.textContent).not.toContain("1,290.50");
    expect(panel.querySelector(".daily-table__mark")).toBeNull();
  });

  test("a day the read lacks is Unknown with its note, never a zero", async () => {
    consoleGetSalesSummary.mockResolvedValue(
      ok(
        storeSummary(
          cairoStore({
            days: zeroDays("2026-10-16", "2026-10-23").filter(
              (d) => d.businessDate !== "2026-10-19",
            ),
          }),
        ),
      ),
    );
    renderReport();
    const panel = await dayPanel();
    fireEvent.change(within(panel).getByLabelText("Business day"), {
      target: { value: "2026-10-19" },
    });
    expect(within(panel).getByText("Unknown")).toBeDefined();
    expect(within(panel).getByText(/not zero/i)).toBeDefined();
    expect(within(panel).queryByText("0")).toBeNull();
  });

  test("a day that has not begun says so, and the panel opens on the latest day that has", async () => {
    // The store's day is the 22nd, so the range's last day (the 23rd) has not begun.
    consoleGetSalesSummary.mockResolvedValue(
      ok(
        storeSummary(
          cairoStore({
            currentBusinessDate: "2026-10-22",
            days: zeroDays("2026-10-16", "2026-10-22"),
          }),
        ),
      ),
    );
    renderReport();
    const panel = await dayPanel();
    const picker = within(panel).getByLabelText("Business day") as HTMLSelectElement;
    expect(picker.value).toBe("2026-10-22");
    fireEvent.change(picker, { target: { value: "2026-10-23" } });
    expect(within(panel).getByText(/has not begun/i)).toBeDefined();
    expect(within(panel).queryByText(/not zero/i)).toBeNull();
    expect(within(panel).getByText("Unknown")).toBeDefined();
  });

  test("the Sales link carries the store and the day in a one-store read, and is absent for a scope", async () => {
    renderReport();
    const panel = await dayPanel();
    fireEvent.change(within(panel).getByLabelText("Business day"), {
      target: { value: "2026-10-20" },
    });
    const link = within(panel).getByRole("link", { name: "Sales for this day" });
    expect(link.getAttribute("href")).toBe(`/sales?store=${CAIRO}&from=2026-10-20&to=2026-10-20`);
    cleanup();

    activeContext.mockReturnValue(ctx("owner", "t1"));
    consoleGetSalesSummary.mockResolvedValue(
      ok(
        scopeSummary([{ ref: CAIRO, timeZone: "Africa/Cairo", currentBusinessDate: "2026-10-23" }]),
      ),
    );
    renderReport();
    const scopePanel = await dayPanel();
    expect(within(scopePanel).queryByRole("link", { name: "Sales for this day" })).toBeNull();
    expect(
      within(scopePanel).getByRole("link", { name: "This day's row in the table" }),
    ).toBeDefined();
  });
});
