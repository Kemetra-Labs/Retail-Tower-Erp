import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  OTHER_STORE,
  QUARANTINE_REF,
  QUARANTINE_REF_2,
  REQUEST_ID,
  STORE,
  ctx,
  failure,
  ok,
  quarantined,
} from "./sale-quarantine-fixtures";

const api = {
  consoleListQuarantinedSales: vi.fn(),
  consoleGetQuarantinedSale: vi.fn(),
  consoleWriteOffQuarantinedSale: vi.fn(),
};
vi.mock("@/lib/sale-quarantine-queries", () => ({
  consoleListQuarantinedSales: (...a: unknown[]) => api.consoleListQuarantinedSales(...a),
  consoleGetQuarantinedSale: (...a: unknown[]) => api.consoleGetQuarantinedSale(...a),
  consoleWriteOffQuarantinedSale: (...a: unknown[]) => api.consoleWriteOffQuarantinedSale(...a),
}));
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
import { QuarantineList } from "@/sale-quarantine/QuarantineList";

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderList(entry = "/quarantined-sales"): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/quarantined-sales" element={<QuarantineList />} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const page = (items: unknown[], nextCursor: string | null = null) => ok({ items, nextCursor });

const stores = [
  { id: STORE, code: "CAI", name: "Cairo Festival", timezone: "Africa/Cairo", is_active: true },
  { id: OTHER_STORE, code: "ALX", name: "Alexandria", timezone: "Africa/Cairo", is_active: true },
];

const OPEN_LINK = { name: "Open item POS-CAI-0042" };

describe("QuarantineList (RT-1312)", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    activeContext.mockReset();
    listStores.mockReset();
    activeContext.mockReturnValue(ctx("owner"));
    listStores.mockResolvedValue({ status: 200, data: stores });
    api.consoleListQuarantinedSales.mockResolvedValue(page([quarantined()]));
  });

  test.each(["store_manager", "store_staff", "cashier", "auditor"])(
    "%s gets NoAccess and nothing is requested",
    async (role) => {
      activeContext.mockReturnValue(ctx(role));
      renderList();
      expect(await screen.findByRole("heading", { level: 1 })).toBeDefined();
      expect(screen.queryByText("Sales the till could not send")).toBeNull();
      expect(api.consoleListQuarantinedSales).not.toHaveBeenCalled();
    },
  );

  test("tenant_admin may read it", async () => {
    activeContext.mockReturnValue(ctx("tenant_admin"));
    renderList();
    expect(await screen.findByRole("link", OPEN_LINK)).toBeDefined();
  });

  test("without a tenant it asks for one and requests nothing", () => {
    activeContext.mockReturnValue(ctx("owner", false));
    renderList();
    expect(
      screen.getByText("Select a tenant to view sales the till could not send."),
    ).toBeDefined();
    expect(api.consoleListQuarantinedSales).not.toHaveBeenCalled();
  });

  test("the page has a band: group, one h1 and scope, no facts; the queue's copy says it is not recorded", async () => {
    renderList();
    await screen.findByRole("link", OPEN_LINK);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const band = screen.getByRole("heading", { level: 1 }).closest("header") as HTMLElement;
    expect(within(band).getByText("Integration")).toBeDefined();
    expect(within(band).getByText(/not recorded yet/)).toBeDefined();
    expect(within(band).getByText(/Northstar/)).toBeDefined();
    expect(band.querySelector("dl")).toBeNull();
    expect(within(band).getByRole("button", { name: "Refresh" })).toBeDefined();
  });

  test("it is kept apart from the ERP sync queue: own words, and a link to the other queue", async () => {
    renderList();
    await screen.findByRole("link", OPEN_LINK);
    const other = screen.getByRole("link", { name: "Sales needing repair (ERPNext sync)" });
    expect(other.getAttribute("href")).toBe("/sales-needing-repair");
    // The ERP queue's word is never used for these items.
    expect(document.body.textContent).not.toMatch(/quarantin(?!ed-sales)/i);
    expect(screen.getByText(/separate from Sales needing repair/)).toBeDefined();
  });

  test("rows link to the item; machine data is LTR; no repair or write-off action on the list", async () => {
    renderList();
    await screen.findByRole("link", OPEN_LINK);
    const table = screen.getByRole("table", {
      name: "Sales the till could not send, newest first",
    });
    expect(api.consoleListQuarantinedSales).toHaveBeenCalledWith({});
    const row = within(table).getAllByRole("row")[1];
    const link = within(row).getByRole("link", OPEN_LINK);
    expect(link.getAttribute("href")).toBe(`/quarantined-sales/${QUARANTINE_REF}`);
    expect(link.querySelector("bdi")?.getAttribute("dir")).toBe("ltr");
    expect(row.textContent).toContain("The server refused the sale for good");
    expect(row.textContent).toContain("1,250.50 EGP");
    expect(within(row).getByText("Open")).toBeDefined();
    await waitFor(() => expect(row.textContent).toContain("Cairo Festival"));
    expect(screen.queryByRole("button", { name: /repair|close without/i })).toBeNull();
  });

  test("a stored sale without a valid total says not recorded", async () => {
    api.consoleListQuarantinedSales.mockResolvedValue(
      page([
        quarantined({
          summary: { occurredAt: null, posTotal: null, currencyCode: null, lineCount: null },
        }),
      ]),
    );
    renderList();
    await screen.findByRole("link", OPEN_LINK);
    expect(within(screen.getByRole("table")).getAllByRole("row")[1].textContent).toContain(
      "Not recorded",
    );
  });

  test("a state this build does not know is unknown, never open", async () => {
    api.consoleListQuarantinedSales.mockResolvedValue(
      page([quarantined({ state: "held-for-review" as never })]),
    );
    renderList();
    await screen.findByRole("link", OPEN_LINK);
    const row = within(screen.getByRole("table")).getAllByRole("row")[1];
    expect(within(row).getByText("Unknown state")).toBeDefined();
    expect(within(row).queryByText("Open")).toBeNull();
  });

  test("the store and state filters go in the URL and the query on Apply", async () => {
    renderList();
    await screen.findByRole("link", OPEN_LINK);
    await waitFor(() => expect(screen.getByRole("option", { name: "Alexandria" })).toBeDefined());
    fireEvent.change(screen.getByLabelText("Store"), { target: { value: OTHER_STORE } });
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "written-off" } });
    expect(api.consoleListQuarantinedSales).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(api.consoleListQuarantinedSales).toHaveBeenLastCalledWith({
        store_id: OTHER_STORE,
        state: "written-off",
      }),
    );
    expect(screen.getByTestId("location").textContent).toBe(
      `/quarantined-sales?store=${OTHER_STORE}&state=written-off`,
    );
  });

  test("the open queue is the default: choosing Open puts nothing in the URL", async () => {
    renderList("/quarantined-sales?state=captured");
    await screen.findByRole("link", OPEN_LINK);
    expect(api.consoleListQuarantinedSales).toHaveBeenCalledWith({ state: "captured" });
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "open" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/quarantined-sales"),
    );
    await waitFor(() => expect(api.consoleListQuarantinedSales).toHaveBeenLastCalledWith({}));
  });

  test("a malformed store or state filter is never sent", async () => {
    renderList("/quarantined-sales?store=CAI");
    expect(await screen.findByText("This store is not available to you.")).toBeDefined();
    expect(api.consoleListQuarantinedSales).not.toHaveBeenCalled();
  });

  test("an unknown state filter is never sent", async () => {
    renderList("/quarantined-sales?state=everything");
    expect(await screen.findByText("This state is not known.")).toBeDefined();
    expect(api.consoleListQuarantinedSales).not.toHaveBeenCalled();
  });

  test("an out-of-scope store is the API's non-disclosing 404", async () => {
    api.consoleListQuarantinedSales.mockResolvedValue(failure(404, "not_found"));
    renderList(`/quarantined-sales?store=${OTHER_STORE}`);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This store is not available to you.");
    expect(alert.textContent).toContain(REQUEST_ID);
  });

  test("dataset-empty, state-empty and filtered-empty are different states", async () => {
    api.consoleListQuarantinedSales.mockResolvedValue(page([]));
    renderList();
    expect(await screen.findByText("No open sales the till could not send.")).toBeDefined();
    expect(screen.getByText(/does not mean every till sale was recorded/)).toBeDefined();
  });

  test("an empty closed state does not claim the queue is empty", async () => {
    api.consoleListQuarantinedSales.mockResolvedValue(page([]));
    renderList("/quarantined-sales?state=written-off");
    expect(await screen.findByText("No items in this state.")).toBeDefined();
  });

  test("filtered-empty names the store filter", async () => {
    api.consoleListQuarantinedSales.mockResolvedValue(page([]));
    renderList(`/quarantined-sales?store=${STORE}`);
    expect(await screen.findByText("No items in this store in the chosen state.")).toBeDefined();
  });

  test("Load more follows the server's cursor; a failed page keeps the rows", async () => {
    api.consoleListQuarantinedSales
      .mockResolvedValueOnce(page([quarantined()], QUARANTINE_REF))
      .mockResolvedValueOnce(failure(500))
      .mockResolvedValueOnce(
        page([quarantined({ quarantineRef: QUARANTINE_REF_2, externalId: "POS-CAI-0041" })]),
      );
    renderList();
    await screen.findByRole("link", OPEN_LINK);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(api.consoleListQuarantinedSales).toHaveBeenLastCalledWith({
        cursor: QUARANTINE_REF,
      }),
    );
    const stale = await screen.findByText(/could not be refreshed/);
    expect(screen.getByRole("link", OPEN_LINK)).toBeDefined();
    fireEvent.click(within(stale.closest("[role=alert]") as HTMLElement).getByRole("button"));
    expect(await screen.findByRole("link", { name: "Open item POS-CAI-0041" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  test.each([
    [400, "The server rejected this request.", false],
    [401, "Your session has ended. Sign in again.", false],
    [403, "This section is not available to your role.", false],
    [429, "Too many requests in a short time. Wait a moment, then retry.", true],
    [500, "Sales the till could not send could not be loaded.", true],
  ])("a %i on the first page is its own state", async (status, message, retry) => {
    api.consoleListQuarantinedSales.mockResolvedValue(failure(status));
    renderList();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(message);
    expect(within(alert).queryByRole("button", { name: "Retry" }) !== null).toBe(retry);
  });

  test("Refresh reads the queue again; nothing is written on its own", async () => {
    renderList();
    await screen.findByRole("link", OPEN_LINK);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.consoleListQuarantinedSales).toHaveBeenCalledTimes(2));
    expect(api.consoleWriteOffQuarantinedSale).not.toHaveBeenCalled();
  });
});
