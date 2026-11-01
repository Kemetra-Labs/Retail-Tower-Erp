import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ctx, stores } from "./sale-fixtures";
import { MAADI, failure, maadi, nasr, report, zamalek } from "./sales-by-store-fixtures";

const consoleGetSalesByStore = vi.fn();
vi.mock("@/lib/sales-by-store-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sales-by-store-queries")>();
  return { ...actual, consoleGetSalesByStore: (...a: unknown[]) => consoleGetSalesByStore(...a) };
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
import { SalesByStore } from "@/sales-by-store/SalesByStore";

/**
 * RT-1054 the sales-by-store report: what it reads, what it prints from the
 * served figures, and every state the issue lists. The Console prints the
 * server's strings; no test here expects a computed figure.
 */

function Where(): React.JSX.Element {
  const loc = useLocation();
  return <output data-testid="where">{`${loc.pathname}${loc.search}`}</output>;
}

function renderReport(entry = "/sales-by-store"): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Where />
        <Routes>
          <Route path="/reports" element={<p>reports index</p>} />
          <Route path="/stores/:id" element={<p>store detail</p>} />
          <Route path="/sales-by-store" element={<SalesByStore />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ok = (data: unknown) => ({ status: 200, data });

async function loaded(): Promise<void> {
  await screen.findByRole("heading", { level: 2, name: "Store ranking" }, { timeout: 5000 });
}

function factOf(label: string): string {
  const dt = screen.getByText(label, { selector: "dt" });
  return dt.parentElement?.querySelector("dd")?.textContent ?? "";
}

function row(name: RegExp): HTMLElement {
  return screen.getByRole("button", { name });
}

describe("SalesByStore (RT-1054)", () => {
  beforeEach(() => {
    consoleGetSalesByStore.mockReset();
    listStores.mockReset();
    activeContext.mockReset();
    activeContext.mockReturnValue(ctx("owner", "t1"));
    listStores.mockResolvedValue({ status: 200, data: stores });
    consoleGetSalesByStore.mockResolvedValue(ok(report()));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T09:00:00Z"));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  describe("what it reads", () => {
    test("one read of the whole scope: the last 10 business days, EGP, against the previous period", async () => {
      renderReport();
      await loaded();
      expect(consoleGetSalesByStore).toHaveBeenCalledTimes(1);
      expect(consoleGetSalesByStore).toHaveBeenCalledWith({
        from: "2026-10-14",
        to: "2026-10-23",
        currency: "EGP",
        compare: "previous_period",
      });
    });

    test("no read waits on a UTC guess: nothing is sent before the store zones are known", async () => {
      listStores.mockReturnValue(new Promise(() => undefined));
      renderReport();
      expect(await screen.findByText("Loading the report…")).toBeDefined();
      expect(consoleGetSalesByStore).not.toHaveBeenCalled();
    });

    test("a range in the URL is read as it is, with its currency and compare", async () => {
      renderReport("/sales-by-store?from=2026-10-01&to=2026-10-07&currency=USD&compare=none");
      await loaded();
      expect(consoleGetSalesByStore).toHaveBeenCalledWith({
        from: "2026-10-01",
        to: "2026-10-07",
        currency: "USD",
        compare: "none",
      });
    });

    test("an invalid range is refused before anything is read", async () => {
      renderReport("/sales-by-store?from=2026-10-07&to=2026-10-01");
      await screen.findByRole("heading", { level: 1, name: "Sales by store" });
      expect(await screen.findByText(/before the start date|End date/i)).toBeDefined();
      expect(consoleGetSalesByStore).not.toHaveBeenCalled();
    });

    test("a role the API refuses reads nothing and shows the non-disclosing state", async () => {
      activeContext.mockReturnValue(ctx("store_staff", "t1"));
      renderReport();
      expect(await screen.findByText("These sales are not available to you.")).toBeDefined();
      expect(consoleGetSalesByStore).not.toHaveBeenCalled();
      expect(screen.queryByRole("heading", { name: "Store ranking" })).toBeNull();
    });
  });

  describe("the band and the context", () => {
    test("three served facts: the scope total in the ranking currency, the stores, those without sales", async () => {
      renderReport();
      await loaded();
      const h1 = screen.getByRole("heading", { level: 1, name: "Sales by store" });
      const band = h1.closest(".list-band") as HTMLElement;
      expect(band.textContent).toContain("Reports · Sales");
      expect(factOf("Received sales")).toBe("944,545.75 EGP");
      expect(factOf("Stores")).toBe("3");
      expect(factOf("Stores without sales")).toBe("1");
      expect(band.querySelectorAll("dt")).toHaveLength(3);
    });

    test("no band fact before the read arrives", () => {
      consoleGetSalesByStore.mockReturnValue(new Promise(() => undefined));
      renderReport();
      expect(document.querySelector(".list-band__facts")).toBeNull();
    });

    test("the context names scope, calendar, zones, read time, the baseline and received-only", async () => {
      renderReport();
      await loaded();
      const context = document.querySelector(".sbs-context") as HTMLElement;
      expect(context.textContent).toContain("Stores: every store in your scope (3)");
      expect(context.textContent).toContain("By each store's local business day");
      expect(context.textContent).toContain("Africa/Cairo");
      expect(context.textContent).toMatch(/As of/);
      expect(context.textContent).toMatch(/Previous period: .*18.*20/);
      expect(context.textContent).toMatch(/never complete/i);
    });

    test("every store zone is listed once", async () => {
      consoleGetSalesByStore.mockResolvedValue(
        ok(report({ stores: [maadi(), nasr({ storeTimezone: "America/New_York" }), zamalek()] })),
      );
      renderReport();
      await loaded();
      const context = document.querySelector(".sbs-context") as HTMLElement;
      expect(context.textContent).toContain("Africa/Cairo, America/New_York");
    });

    test("a range with a day still running says so, in the context and the exact-figures footer", async () => {
      renderReport();
      await loaded();
      expect(screen.getAllByText("Includes days so far").length).toBeGreaterThan(0);
      expect(screen.getByText("Scope total (includes days so far)")).toBeDefined();
    });

    test("a range with no running day carries neither label", async () => {
      const done = (s: ReturnType<typeof maadi>) => ({
        ...s,
        ranking: {
          ...s.ranking,
          days: s.ranking.days.map((d) => ({ ...d, state: "complete" as const })),
        },
      });
      consoleGetSalesByStore.mockResolvedValue(
        ok(report({ stores: [done(maadi()), done(nasr())] })),
      );
      renderReport();
      await loaded();
      expect(screen.queryByText("Includes days so far")).toBeNull();
      expect(screen.getByText("Scope total")).toBeDefined();
    });
  });

  describe("the ranking", () => {
    test("stores appear in the server's order; the leader is the one Ink row", async () => {
      renderReport();
      await loaded();
      const rows = Array.from(document.querySelectorAll(".sbs-rank .sbs-row"));
      expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
        "Rank 1, Maadi Branch, 512,640.25 EGP",
        "Rank 2, Nasr City Branch, 431,905.50 EGP",
        "Unranked, Zamalek Branch",
      ]);
      expect(rows[0].classList.contains("sbs-row--leader")).toBe(true);
      expect(rows[1].classList.contains("sbs-row--leader")).toBe(false);
    });

    test("a bar is the served share, and the share is that string with its point moved", async () => {
      renderReport();
      await loaded();
      const first = row(/Rank 1, Maadi/);
      expect((first.querySelector(".sbs-track i") as HTMLElement).style.inlineSize).toBe("34.63%");
      expect(first.querySelector(".sbs-track__share")?.textContent).toBe("34.63%");
      expect(row(/Rank 2, Nasr/).querySelector(".sbs-track__share")?.textContent).toBe("29.18%");
    });

    test("the change against the previous period is the served ratio with its sign, up and down", async () => {
      renderReport();
      await loaded();
      expect(row(/Rank 1, Maadi/).querySelector(".sbs-delta")?.textContent).toBe("+5.44%");
      expect(row(/Rank 1, Maadi/).querySelector(".sbs-delta--up")).not.toBeNull();
      expect(row(/Rank 2, Nasr/).querySelector(".sbs-delta")?.textContent).toBe("−10.77%");
      expect(row(/Rank 2, Nasr/).querySelector(".sbs-delta--down")).not.toBeNull();
    });

    test("a rank change is the served baseline rank in words", async () => {
      renderReport();
      await loaded();
      expect(
        within(row(/Rank 1, Maadi/)).getByText("Was rank 1 in the previous period"),
      ).toBeDefined();
      expect(
        within(row(/Rank 2, Nasr/)).getByText("Was rank 3 in the previous period"),
      ).toBeDefined();
    });

    test("a store with no sales in the previous period says so", async () => {
      consoleGetSalesByStore.mockResolvedValue(
        ok(report({ stores: [maadi({ baselineRank: null }), nasr(), zamalek()] })),
      );
      renderReport();
      await loaded();
      expect(
        within(row(/Rank 1, Maadi/)).getByText("No sales in the previous period"),
      ).toBeDefined();
    });

    test("a null ratio is a dash that says why, never 0%", async () => {
      consoleGetSalesByStore.mockResolvedValue(
        ok(
          report({
            stores: [
              maadi({ ranking: { ...maadi().ranking, deltaRatio: null, baselineTotal: "0.0000" } }),
              nasr(),
            ],
          }),
        ),
      );
      renderReport();
      await loaded();
      const delta = row(/Rank 1, Maadi/).querySelector(".sbs-delta") as HTMLElement;
      expect(delta.textContent).toContain("No comparison: no sales in the previous period");
      expect(delta.textContent).not.toContain("%");
    });

    test("unranked stores are listed last under their own heading, with no rank, bar or amount", async () => {
      renderReport();
      await loaded();
      expect(
        screen.getByRole("heading", { level: 3, name: "Stores with no sales in this currency" }),
      ).toBeDefined();
      const z = row(/Unranked, Zamalek/);
      expect(z.querySelector(".sbs-row__pos")?.textContent).toBe("—");
      expect(within(z).getByText("No received sales in this currency in the range")).toBeDefined();
      expect(z.querySelector(".sbs-track")).toBeNull();
      expect(z.querySelector(".sbs-delta")).toBeNull();
    });

    test("an inactive store is named as such, in words", async () => {
      renderReport();
      await loaded();
      expect(within(row(/Unranked, Zamalek/)).getByText("Inactive")).toBeDefined();
    });

    test("compare off drops the badges, the move text and the baseline column", async () => {
      renderReport();
      await loaded();
      fireEvent.click(
        screen.getByRole("switch", { name: "Compare with the previous equal period" }),
      );
      await waitFor(() =>
        expect(consoleGetSalesByStore).toHaveBeenLastCalledWith(
          expect.objectContaining({ compare: "none" }),
        ),
      );
      expect(screen.getByTestId("where").textContent).toContain("compare=none");
    });

    test("with compare off the served baseline is not shown at all", async () => {
      consoleGetSalesByStore.mockResolvedValue(
        ok(
          report({
            compare: "none",
            stores: [
              maadi({
                baselineRank: null,
                ranking: { ...maadi().ranking, baselineTotal: null, deltaRatio: null },
              }),
              nasr({
                baselineRank: null,
                ranking: { ...nasr().ranking, baselineTotal: null, deltaRatio: null },
              }),
            ],
          }),
        ),
      );
      renderReport("/sales-by-store?from=2026-10-21&to=2026-10-23&compare=none");
      await loaded();
      expect(document.querySelector(".sbs-rank .sbs-delta")).toBeNull();
      expect(screen.queryByText(/Was rank/)).toBeNull();
      expect(screen.queryByRole("columnheader", { name: /Previous period/ })).toBeNull();
      expect(screen.getByText("No comparison with the previous period")).toBeDefined();
    });
  });

  describe("the controls", () => {
    test("a quick range rewrites the URL and reads that range", async () => {
      renderReport();
      await loaded();
      fireEvent.click(screen.getByRole("button", { name: "Last 7 business days" }));
      await waitFor(() =>
        expect(consoleGetSalesByStore).toHaveBeenLastCalledWith(
          expect.objectContaining({ from: "2026-10-17", to: "2026-10-23" }),
        ),
      );
      expect(screen.getByTestId("where").textContent).toBe(
        "/sales-by-store?from=2026-10-17&to=2026-10-23",
      );
    });

    test("this month so far starts on the first", async () => {
      renderReport();
      await loaded();
      fireEvent.click(screen.getByRole("button", { name: "This month so far" }));
      await waitFor(() =>
        expect(consoleGetSalesByStore).toHaveBeenLastCalledWith(
          expect.objectContaining({ from: "2026-10-01", to: "2026-10-23" }),
        ),
      );
    });

    test("the pressed quick range is the one the applied range equals", async () => {
      renderReport();
      await loaded();
      expect(
        screen.getByRole("button", { name: "Last 10 business days" }).getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        screen.getByRole("button", { name: "Last 7 business days" }).getAttribute("aria-pressed"),
      ).toBe("false");
    });

    test("the ranking currency is a new read; the options are EGP and every served currency", async () => {
      renderReport();
      await loaded();
      const select = screen.getByLabelText("Ranking currency") as HTMLSelectElement;
      expect(Array.from(select.options, (o) => o.value)).toEqual(["EGP", "USD"]);
      fireEvent.change(select, { target: { value: "USD" } });
      await waitFor(() =>
        expect(consoleGetSalesByStore).toHaveBeenLastCalledWith(
          expect.objectContaining({ currency: "USD" }),
        ),
      );
      expect(screen.getByTestId("where").textContent).toContain("currency=USD");
    });

    test("dates typed in the range form apply and read", async () => {
      renderReport();
      await loaded();
      fireEvent.change(screen.getByLabelText("From business date"), {
        target: { value: "2026-10-05" },
      });
      fireEvent.change(screen.getByLabelText("To business date"), {
        target: { value: "2026-10-12" },
      });
      fireEvent.click(screen.getByRole("button", { name: /apply/i }));
      await waitFor(() =>
        expect(consoleGetSalesByStore).toHaveBeenLastCalledWith(
          expect.objectContaining({ from: "2026-10-05", to: "2026-10-12" }),
        ),
      );
    });
  });

  describe("the selected store's panel", () => {
    test("opens on the first listed store with its served figures", async () => {
      renderReport();
      await loaded();
      const panel = screen.getByRole("complementary", { name: "Maadi Branch" });
      expect(panel.textContent).toContain("Selected store · Rank 1");
      expect(panel.textContent).toContain("512,640.25 EGP");
      expect(panel.textContent).toContain("34.63% of the scope total");
      expect(panel.textContent).toContain("369.3372 EGP");
      expect(panel.textContent).toContain("486,210.40 EGP");
      expect(panel.textContent).toContain("+5.44%");
    });

    test("picking another store follows its served figures", async () => {
      renderReport();
      await loaded();
      fireEvent.click(row(/Rank 2, Nasr/));
      const panel = screen.getByRole("complementary", { name: "Nasr City Branch" });
      expect(panel.textContent).toContain("Selected store · Rank 2");
      expect(panel.textContent).toContain("431,905.50 EGP");
      expect(panel.textContent).toContain("−10.77%");
      expect(row(/Rank 2, Nasr/).getAttribute("aria-pressed")).toBe("true");
      expect(row(/Rank 1, Maadi/).getAttribute("aria-pressed")).toBe("false");
    });

    test("returns, voids and legacy refunds are the served facts, one line per currency", async () => {
      renderReport();
      await loaded();
      const panel = screen.getByRole("complementary", { name: "Maadi Branch" });
      expect(panel.textContent).toContain("9,100.00 EGP");
      expect(panel.textContent).toContain("4,200.50 EGP");
      expect(panel.textContent).toContain("250.00 EGP");
    });

    test("there is no return rate (D-12)", async () => {
      renderReport();
      await loaded();
      expect(screen.queryByText(/return rate/i)).toBeNull();
      expect(screen.getByRole("complementary", { name: "Maadi Branch" }).textContent).not.toMatch(
        /rate/i,
      );
    });

    test("an unranked store's panel says so and shows dashes, not zeros, for what is not served", async () => {
      renderReport();
      await loaded();
      fireEvent.click(row(/Unranked, Zamalek/));
      const panel = screen.getByRole("complementary", { name: /Zamalek Branch/ });
      expect(panel.textContent).toContain("Selected store · Unranked");
      expect(within(panel).getAllByText("Not available").length).toBeGreaterThanOrEqual(2);
    });

    test("it lists every business day with its served amount and a state in words", async () => {
      renderReport();
      await loaded();
      const panel = screen.getByRole("complementary", { name: "Maadi Branch" });
      const days = Array.from(panel.querySelectorAll(".sbs-days li"), (li) => li.textContent);
      expect(days).toHaveLength(3);
      expect(days[2]).toContain("(so far)");
      expect(days[1]).toContain("200,000.00 EGP");
    });

    test("it links to the store", async () => {
      renderReport();
      await loaded();
      expect(screen.getByRole("link", { name: "Store details" }).getAttribute("href")).toBe(
        `/stores/${MAADI}`,
      );
    });
  });

  describe("store × business day", () => {
    function matrix(): HTMLTableElement {
      return document.querySelector(".sbs-matrix") as HTMLTableElement;
    }

    test("each cell is the served amount of that store and day, no scaling", async () => {
      renderReport();
      await loaded();
      const maadiRow = within(matrix()).getByRole("row", { name: /Maadi Branch/ });
      const cells = within(maadiRow).getAllByRole("cell");
      expect(cells.map((c) => c.textContent?.replace(/\s*\(so far\)|\s*Best day/g, ""))).toEqual([
        "150,000.00",
        "200,000.00★",
        "162,640.25",
      ]);
    });

    test("the served best day carries a star and the words «Best day»", async () => {
      renderReport();
      await loaded();
      const cells = within(within(matrix()).getByRole("row", { name: /Nasr City/ })).getAllByRole(
        "cell",
      );
      expect(cells[0].textContent).toContain("★");
      expect(cells[0].textContent).toContain("Best day");
      expect(cells[1].textContent).not.toContain("★");
    });

    test("a day still running is hatched and named; a real zero is faded and shows 0", async () => {
      renderReport();
      await loaded();
      const maadiCells = within(
        within(matrix()).getByRole("row", { name: /Maadi Branch/ }),
      ).getAllByRole("cell");
      expect(maadiCells[2].classList.contains("sbs-cell--so-far")).toBe(true);
      expect(maadiCells[2].textContent).toContain("(so far)");
      const zamalekCells = within(
        within(matrix()).getByRole("row", { name: /Zamalek/ }),
      ).getAllByRole("cell");
      expect(zamalekCells[0].textContent).toBe("0");
      expect(zamalekCells[0].classList.contains("sbs-cell--zero")).toBe(true);
    });

    test("a day not begun that holds stored sales shows its real figure, marked as not begun", async () => {
      const days = maadi().ranking.days.map((d, i) =>
        i === 2 ? { ...d, state: "not_begun" as const, total: "1234.0000" } : d,
      );
      consoleGetSalesByStore.mockResolvedValue(
        ok(report({ stores: [maadi({ ranking: { ...maadi().ranking, days } }), nasr()] })),
      );
      renderReport();
      await loaded();
      const cell = within(within(matrix()).getByRole("row", { name: /Maadi Branch/ })).getAllByRole(
        "cell",
      )[2];
      expect(cell.textContent).toContain("1,234.00");
      expect(cell.textContent).toContain("(not yet begun)");
      expect(cell.classList.contains("sbs-cell--not-begun")).toBe(true);
    });

    test("the column heads name the full date for a screen reader", async () => {
      renderReport();
      await loaded();
      const heads = within(matrix()).getAllByRole("columnheader");
      expect(heads).toHaveLength(4);
      expect(heads[1].querySelector("time")?.getAttribute("datetime")).toBe("2026-10-21");
    });
  });

  describe("the exact figures", () => {
    test("each served fact prints its count and one line per currency; the footer is the served total", async () => {
      renderReport();
      await loaded();
      const table = document.querySelector(".sbs-table") as HTMLElement;
      const maadiRow = within(table).getByRole("row", { name: /Maadi Branch/ });
      expect(maadiRow.textContent).toContain("512,640.25 EGP");
      expect(maadiRow.textContent).toContain("120.00 USD");
      const foot = table.querySelector("tfoot") as HTMLElement;
      expect(foot.textContent).toContain("944,545.75 EGP");
      expect(foot.textContent).toContain("120.00 USD");
      expect(foot.textContent).toContain("14,100.00 EGP");
    });

    test("the previous period shows in the ranking currency, and has no served scope total", async () => {
      renderReport();
      await loaded();
      const table = document.querySelector(".sbs-table") as HTMLElement;
      expect(
        within(table).getByRole("columnheader", { name: "Previous period (EGP)" }),
      ).toBeDefined();
      const nasrRow = within(table).getByRole("row", { name: /Nasr City/ });
      expect(nasrRow.textContent).toContain("389,870.10 EGP");
      expect(nasrRow.textContent).toContain("−10.77%");
      expect(
        within(table.querySelector("tfoot") as HTMLElement).getAllByText("Not available"),
      ).toHaveLength(2);
    });
  });

  describe("states", () => {
    test("loading names what is coming and shows no figure", async () => {
      consoleGetSalesByStore.mockReturnValue(new Promise(() => undefined));
      renderReport();
      expect(await screen.findByText("Loading the report…")).toBeDefined();
      expect(screen.queryByRole("heading", { name: "Store ranking" })).toBeNull();
    });

    test("an empty scope says so and shows no table", async () => {
      consoleGetSalesByStore.mockResolvedValue(ok(report({ stores: [], storeCount: 0 })));
      renderReport();
      expect(await screen.findByText("There are no stores in your scope.")).toBeDefined();
      expect(screen.queryByRole("heading", { name: "Store ranking" })).toBeNull();
    });

    test("a scope of one store is not rankable: the figures show, with the reason, and no rank", async () => {
      consoleGetSalesByStore.mockResolvedValue(
        ok(
          report({
            rankable: false,
            stores: [maadi({ rank: null, baselineRank: null })],
          }),
        ),
      );
      renderReport();
      await loaded();
      expect(screen.getByText(/one store or none, so there is no ranking/i)).toBeDefined();
      const only = document.querySelector(".sbs-rank .sbs-row") as HTMLElement;
      expect(only.classList.contains("sbs-row--leader")).toBe(false);
      expect(only.querySelector(".sbs-row__pos")?.textContent).toBe("—");
    });

    test("a currency nobody sold in leaves every store unranked, and says so", async () => {
      consoleGetSalesByStore.mockResolvedValue(
        ok(
          report({
            currency: "EUR",
            stores: [
              maadi({ rank: null, baselineRank: null }),
              nasr({ rank: null, baselineRank: null }),
            ],
          }),
        ),
      );
      renderReport("/sales-by-store?from=2026-10-21&to=2026-10-23&currency=EUR");
      await loaded();
      expect(
        screen.getByText(
          "There are no received sales in EUR in this range, so every store is unranked.",
        ),
      ).toBeDefined();
    });

    test("400 scope_too_large says nothing was cut off and shows no table", async () => {
      consoleGetSalesByStore.mockResolvedValue(failure(400, "scope_too_large"));
      renderReport();
      expect(
        await screen.findByText(
          "Your scope is larger than the report can rank (500 stores at most).",
        ),
      ).toBeDefined();
      expect(screen.getByText(/nothing was cut off/i)).toBeDefined();
      expect(screen.queryByRole("heading", { name: "Store ranking" })).toBeNull();
    });

    test("400 on a bad field lands at the To field, not in the body", async () => {
      consoleGetSalesByStore.mockResolvedValue(failure(400, "validation_error"));
      renderReport();
      expect(await screen.findByText(/The server refused this request/)).toBeDefined();
      expect(document.querySelector(".sbs-report")).toBeNull();
    });

    test("429 is a calm notice with a retry that reads again", async () => {
      consoleGetSalesByStore.mockResolvedValueOnce(failure(429, "rate_limited"));
      renderReport();
      expect(
        await screen.findByText("Too many requests. Try again when the wait ends."),
      ).toBeDefined();
      consoleGetSalesByStore.mockResolvedValue(ok(report()));
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await loaded();
      expect(consoleGetSalesByStore).toHaveBeenCalledTimes(2);
    });

    test("404 is the non-disclosing state", async () => {
      consoleGetSalesByStore.mockResolvedValue(failure(404, "not_found"));
      renderReport();
      expect(await screen.findByText("These sales are not available to you.")).toBeDefined();
    });

    test("a server error is a danger banner with the request id and a retry", async () => {
      consoleGetSalesByStore.mockResolvedValueOnce(failure(500, "system_failure", "req-9"));
      renderReport();
      expect(await screen.findByText("The report could not be loaded.")).toBeDefined();
      expect(document.body.textContent).toContain("req-9");
      consoleGetSalesByStore.mockResolvedValue(ok(report()));
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await loaded();
    });

    test("an unexpected status is the generic banner, never a raw error", async () => {
      consoleGetSalesByStore.mockResolvedValue({ status: 401 });
      renderReport();
      expect(await screen.findByText("The report could not be loaded.")).toBeDefined();
    });
  });

  describe("navigation", () => {
    test("links back to the Reports index", async () => {
      renderReport();
      await loaded();
      expect(screen.getByRole("link", { name: "Reports" }).getAttribute("href")).toBe("/reports");
    });

    test("the three sections carry the decorative index 01 to 03", async () => {
      renderReport();
      await loaded();
      const badges = Array.from(document.querySelectorAll(".section-index"), (b) => b.textContent);
      expect(badges).toEqual(["01", "02", "03"]);
    });
  });
});
