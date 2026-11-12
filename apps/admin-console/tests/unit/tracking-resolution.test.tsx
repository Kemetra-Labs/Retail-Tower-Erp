import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-455 part 2: the Tracking Resolution queue and the sale-line findings tab
 * against mocked contract answers. Covers role gating (the owner binds, a
 * tenant_admin sees the action recessed, a store_manager gets the count only,
 * OD-9), the bind flow with its reason, always-required note and confirm step,
 * the server's refusals shown as sent, and the loading, empty and error states
 * (an unknown count is «—», never zero). Nothing here is a success unless the
 * server answered one.
 */
const api = {
  getTenantTrackingSummary: vi.fn(),
  listSafetyFindings: vi.fn(),
  listTrackingHolds: vi.fn(),
  listInventoryRecalls: vi.fn(),
  listTrackingResolutionQueue: vi.fn(),
  bindTrackingResolution: vi.fn(),
  listSaleLineFindings: vi.fn(),
};
vi.mock("@/lib/tracking-queries", () => ({
  getTenantTrackingSummary: (...a: unknown[]) => api.getTenantTrackingSummary(...a),
  listSafetyFindings: (...a: unknown[]) => api.listSafetyFindings(...a),
  listTrackingHolds: (...a: unknown[]) => api.listTrackingHolds(...a),
  listInventoryRecalls: (...a: unknown[]) => api.listInventoryRecalls(...a),
  listTrackingResolutionQueue: (...a: unknown[]) => api.listTrackingResolutionQueue(...a),
  bindTrackingResolution: (...a: unknown[]) => api.bindTrackingResolution(...a),
  listSaleLineFindings: (...a: unknown[]) => api.listSaleLineFindings(...a),
}));
const getTrackedSelling = vi.fn();
vi.mock("@/lib/tracked-selling-queries", () => ({
  getTrackedSellingSetting: (...a: unknown[]) => getTrackedSelling(...a),
}));
const getProduct = vi.fn();
vi.mock("@/lib/catalog-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog-queries")>();
  return { ...actual, consoleGetCatalogProduct: (...a: unknown[]) => getProduct(...a) };
});
const listTrackingIdentities = vi.fn();
vi.mock("@/lib/inventory-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inventory-queries")>();
  return { ...actual, listTrackingIdentities: (...a: unknown[]) => listTrackingIdentities(...a) };
});
const listStores = vi.fn();
vi.mock("@/lib/rf2-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rf2-queries")>();
  return { ...actual, listStores: (...a: unknown[]) => listStores(...a) };
});
const listMembers = vi.fn();
vi.mock("@/lib/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client")>();
  return { ...actual, listMembers: (...a: unknown[]) => listMembers(...a) };
});
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));

import { createQueryClient } from "@/lib/query";
import { resetRateLimit } from "@/lib/rate-limit";
import { TrackingHolds } from "@/tracking/TrackingHolds";

const STORE = "0190f000-0000-7000-8000-0000000007a1";
const PRODUCT = "0190f000-0000-7000-8000-0000000007c1";
const IDENTITY = "0190f000-0000-7000-8000-0000000007b1";
const SALE = "0190f000-0000-7000-8000-000000000a01";
const LINE_1 = "0190f000-0000-7000-8000-000000000b01";
const LINE_2 = "0190f000-0000-7000-8000-000000000b02";
const OMAR = "0190f000-0000-7000-8000-0000000000c1";

function ctx(role: string) {
  return {
    context: {
      user: { id: "u1", display_name: "Amal Saleh" },
      active_tenant: { id: "t1", name: "Northstar Retail" },
      active_store: null,
      active_role_code: role,
      memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", role_code: role }],
    },
    switchTenant: () => {},
    switchStore: () => {},
    clearStore: () => {},
  };
}
const ok = <T,>(data: T) => ({ status: 200, data });
const failure = (status: number, code = "x", message = "x") => ({
  status,
  error: { error: { code, message, request_id: "req-1" } },
});
const queue = (
  items: unknown[],
  unresolvedCount = items.length,
  nextCursor: string | null = null,
) => ok({ items, nextCursor, unresolvedCount });

const line = (id: string, extra: object = {}) => ({
  saleLineId: id,
  tenantProductRef: PRODUCT,
  reason: "identity_unknown",
  sentIdentityId: null,
  scannedCode: "LOT-X",
  quantity: "2",
  unit: "pcs",
  ...extra,
});
const sale = (extra: object = {}) => ({
  saleId: SALE,
  storeId: STORE,
  businessDate: "2026-11-10",
  occurredAt: "2026-11-10T09:00:00Z",
  capturedAt: "2026-11-10T09:05:00Z",
  status: "unresolved",
  unresolvedLines: [line(LINE_1)],
  resolution: null,
  ...extra,
});
const finding = (id: string, extra: object = {}) => ({
  id,
  kind: "sold_under_hold",
  severity: "critical",
  cause: "quality_hold",
  storeId: STORE,
  saleId: SALE,
  saleLineId: LINE_1,
  tenantProductRef: PRODUCT,
  trackingIdentityId: IDENTITY,
  holdId: null,
  businessDate: "2026-11-10",
  occurredAt: "2026-11-10T09:00:00Z",
  recordedAt: "2026-11-10T09:05:00Z",
  ...extra,
});

function renderAt(entry: string): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/tracking" element={<TrackingHolds />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  for (const fn of [getProduct, listStores, listMembers, activeContext, listTrackingIdentities]) {
    fn.mockReset();
  }
  resetRateLimit();
  activeContext.mockReturnValue(ctx("owner"));
  getTrackedSelling.mockReset();
  getTrackedSelling.mockResolvedValue(
    ok({
      enabled: true,
      changedAt: "2026-11-08T18:00:00Z",
      changedBy: null,
      preconditionsMet: true,
      unmetPreconditions: [],
    }),
  );
  api.getTenantTrackingSummary.mockResolvedValue(ok({ hasTrackedProducts: true }));
  api.listSafetyFindings.mockResolvedValue(
    ok({ findings: [], generatedAt: "2026-11-12T01:00:00Z" }),
  );
  api.listTrackingHolds.mockResolvedValue(ok({ items: [], nextCursor: null }));
  api.listInventoryRecalls.mockResolvedValue(ok({ items: [], nextCursor: null }));
  api.listTrackingResolutionQueue.mockResolvedValue(queue([sale()]));
  api.listSaleLineFindings.mockResolvedValue(ok({ items: [finding("f1")], nextCursor: null }));
  listTrackingIdentities.mockResolvedValue(
    ok({
      items: [
        {
          id: IDENTITY,
          productId: PRODUCT,
          kind: "batch",
          code: "LOT-2026-1004",
          expiryDate: "2027-04-04",
          manufacturedOn: null,
          origin: "erp_external",
        },
      ],
      nextCursor: null,
    }),
  );
  getProduct.mockResolvedValue(ok({ summary: { name: "Mango juice 1 L" } }));
  listStores.mockResolvedValue({
    status: 200,
    data: [{ id: STORE, tenant_id: "t1", code: "MAA", name: "Maadi", is_active: true }],
  });
  listMembers.mockResolvedValue({
    status: 200,
    data: [
      {
        membership_id: "m1",
        user: { id: OMAR, email: "omar@x.eg", display_name: "Omar" },
        role_code: "owner",
        store_access_kind: "all",
        revoked_at: null,
      },
    ],
  });
});
afterEach(cleanup);

async function openBind(): Promise<HTMLElement> {
  renderAt("/tracking?tab=resolution");
  fireEvent.click(await screen.findByRole("button", { name: "Bind identity" }));
  return screen.findByTestId("tracking-bind-form");
}

async function fillBind(form: HTMLElement, note = "Scanned the wrong lot"): Promise<void> {
  const choose = await within(form).findByRole("combobox", { name: /Mango juice/ });
  await within(form).findByRole("option", { name: /LOT-2026-1004/ });
  fireEvent.change(choose, { target: { value: IDENTITY } });
  fireEvent.change(within(form).getByLabelText(/Reason/), {
    target: { value: "label_misprint" },
  });
  fireEvent.change(within(form).getByLabelText(/Note/), { target: { value: note } });
}

describe("resolution queue (owner)", () => {
  test("lists the unresolved sales with their lines and the tab count", async () => {
    renderAt("/tracking?tab=resolution");
    const table = await screen.findByTestId("tracking-queue-table");
    expect(within(table).getByText("Unknown identity")).toBeTruthy();
    expect(within(table).getByText("LOT-X")).toBeTruthy();
    expect(api.listTrackingResolutionQueue).toHaveBeenCalledWith(
      expect.objectContaining({ status: "unresolved" }),
    );
    expect(
      within(screen.getByRole("tab", { name: /Resolution queue/ })).getByText("1"),
    ).toBeTruthy();
  });

  test("empty: says nothing waits", async () => {
    api.listTrackingResolutionQueue.mockResolvedValue(queue([], 0));
    renderAt("/tracking?tab=resolution");
    expect(await screen.findByText("No sales are waiting to be bound.")).toBeTruthy();
  });

  test("a failed read says the count is unknown and retries", async () => {
    api.listTrackingResolutionQueue.mockResolvedValue(failure(500));
    renderAt("/tracking?tab=resolution");
    expect(
      await screen.findByText("The resolution queue could not be loaded. The count is unknown."),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("tab", { name: /Resolution queue/ })).queryByText("0"),
    ).toBeNull();
  });

  test("loading is announced before the rows", async () => {
    api.listTrackingResolutionQueue.mockReturnValue(new Promise(() => {}));
    renderAt("/tracking?tab=resolution");
    expect(await screen.findByText(/Loading the resolution queue/i)).toBeTruthy();
  });

  test("a resolved sale shows its recorded resolution, with the actor's name", async () => {
    api.listTrackingResolutionQueue.mockResolvedValue(
      queue(
        [
          sale({
            status: "resolved",
            resolution: {
              id: "r1",
              saleId: SALE,
              reasonCode: "label_misprint",
              note: "Wrong lot scanned",
              resolvedBy: OMAR,
              resolvedAt: "2026-11-11T10:00:00Z",
              lines: [{ saleLineId: LINE_1, trackingIdentityId: IDENTITY }],
            },
          }),
        ],
        0,
      ),
    );
    renderAt("/tracking?tab=resolution");
    const by = await screen.findByTestId("tracking-resolved-by");
    expect(within(by).getByText("Wrong lot scanned")).toBeTruthy();
    expect(await within(by).findByText("Omar")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bind identity" })).toBeNull();
  });
});

describe("bind flow (owner)", () => {
  test("validates reason, identity and the always-required note before asking to confirm", async () => {
    const form = await openBind();
    fireEvent.click(within(form).getByRole("button", { name: "Review binding" }));
    expect(within(form).getByText("Choose an identity for every line.")).toBeTruthy();
    expect(
      within(form).getByText("Write a note explaining the binding: it is required."),
    ).toBeTruthy();
    expect(api.bindTrackingResolution).not.toHaveBeenCalled();
  });

  test("captures the reason, confirms, sends one command with a key, and shows the recorded line", async () => {
    api.bindTrackingResolution.mockResolvedValue(
      ok({
        id: "r1",
        saleId: SALE,
        reasonCode: "label_misprint",
        note: "Scanned the wrong lot",
        resolvedBy: OMAR,
        resolvedAt: "2026-11-12T01:10:00Z",
        lines: [{ saleLineId: LINE_1, trackingIdentityId: IDENTITY }],
      }),
    );
    const form = await openBind();
    await fillBind(form, "  Scanned the wrong lot  ");
    fireEvent.click(within(form).getByRole("button", { name: "Review binding" }));
    expect(api.bindTrackingResolution).not.toHaveBeenCalled();
    fireEvent.click(within(form).getByRole("button", { name: "Confirm binding" }));
    expect(await within(form).findByText("The binding was recorded on 1 line.")).toBeTruthy();
    expect(api.bindTrackingResolution).toHaveBeenCalledTimes(1);
    const [saleId, command, key] = api.bindTrackingResolution.mock.calls[0];
    expect(saleId).toBe(SALE);
    expect(command).toEqual({
      reasonCode: "label_misprint",
      note: "Scanned the wrong lot",
      lines: [{ saleLineId: LINE_1, trackingIdentityId: IDENTITY }],
    });
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThanOrEqual(16);
  });

  test("a 409 is shown as the server sent it, with its code, never as success", async () => {
    api.bindTrackingResolution.mockResolvedValue(
      failure(409, "tracking_resolution_identity_held", "The identity is held."),
    );
    const form = await openBind();
    await fillBind(form);
    fireEvent.click(within(form).getByRole("button", { name: "Review binding" }));
    fireEvent.click(within(form).getByRole("button", { name: "Confirm binding" }));
    expect(await within(form).findByText("The identity is held.")).toBeTruthy();
    expect(within(form).getByText(/tracking_resolution_identity_held/)).toBeTruthy();
    expect(within(form).getByText(/active hold now/)).toBeTruthy();
    expect(within(form).queryByText(/The binding was recorded/)).toBeNull();
  });

  test("a 404 says the sale or an identity was not found, not «batches not imported»", async () => {
    api.bindTrackingResolution.mockResolvedValue(failure(404, "not_found", "Not found."));
    const form = await openBind();
    await fillBind(form);
    fireEvent.click(within(form).getByRole("button", { name: "Review binding" }));
    fireEvent.click(within(form).getByRole("button", { name: "Confirm binding" }));
    expect(await within(form).findByText(/did not find this sale/)).toBeTruthy();
    expect(within(form).queryByText(/imported from ERPNext/)).toBeNull();
  });

  test("no answer says the result is unknown and keeps the form usable", async () => {
    api.bindTrackingResolution.mockRejectedValue(new Error("network"));
    const form = await openBind();
    await fillBind(form);
    fireEvent.click(within(form).getByRole("button", { name: "Review binding" }));
    fireEvent.click(within(form).getByRole("button", { name: "Confirm binding" }));
    expect(await within(form).findByText(/No answer arrived/)).toBeTruthy();
    expect(within(form).getByRole("button", { name: "Review binding" })).toBeTruthy();
  });

  test("a sale with two lines asks for an identity per line", async () => {
    api.listTrackingResolutionQueue.mockResolvedValue(
      queue([
        sale({
          unresolvedLines: [
            line(LINE_1),
            line(LINE_2, { reason: "tracking_missing", scannedCode: null }),
          ],
        }),
      ]),
    );
    const form = await openBind();
    await waitFor(() => expect(within(form).getAllByTestId("tracking-bind-line")).toHaveLength(2));
  });

  test("a failed identity read says so for that line", async () => {
    listTrackingIdentities.mockResolvedValue(failure(500));
    const form = await openBind();
    expect(
      await within(form).findByText("This product's identities could not be loaded."),
    ).toBeTruthy();
  });
});

describe("resolution queue (role gating)", () => {
  test("tenant_admin reads the sales but the bind is recessed with the owner-only reason", async () => {
    activeContext.mockReturnValue(ctx("tenant_admin"));
    renderAt("/tracking?tab=resolution");
    const button = await screen.findByRole("button", { name: "Bind identity" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(screen.queryByTestId("tracking-bind-form")).toBeNull();
    expect(screen.getByTestId("tracking-bind-notice").textContent).toMatch(/owner only/);
    expect(api.bindTrackingResolution).not.toHaveBeenCalled();
  });

  test("store_manager gets the count only: no rows, no queue paging, the count in its note", async () => {
    activeContext.mockReturnValue(ctx("store_manager"));
    api.listTrackingResolutionQueue.mockResolvedValue(queue([], 3));
    renderAt("/tracking");
    const note = await screen.findByTestId("tracking-manager-notes");
    await waitFor(() => expect(within(note).getByText("3")).toBeTruthy());
    expect(api.listTrackingResolutionQueue).toHaveBeenCalledWith({
      status: "unresolved",
      limit: 1,
    });
    fireEvent.click(screen.getByRole("tab", { name: /Resolution queue/ }));
    expect(await screen.findAllByTestId("tracking-queue-count")).not.toHaveLength(0);
    expect(screen.queryByTestId("tracking-queue-table")).toBeNull();
    expect(screen.queryByRole("button", { name: "Bind identity" })).toBeNull();
  });

  test("store_manager: a failed count read is unknown, never zero", async () => {
    activeContext.mockReturnValue(ctx("store_manager"));
    api.listTrackingResolutionQueue.mockResolvedValue(failure(500));
    renderAt("/tracking");
    expect(await screen.findByText(/count is unknown/)).toBeTruthy();
  });
});

describe("sale-line findings tab (OD-2)", () => {
  test("lists the recorded findings, pages by cursor and shows no total", async () => {
    api.listSaleLineFindings
      .mockResolvedValueOnce(ok({ items: [finding("f1")], nextCursor: "c1" }))
      .mockResolvedValueOnce(
        ok({
          items: [finding("f2", { kind: "erp_intent_held", cause: "expired" })],
          nextCursor: null,
        }),
      );
    renderAt("/tracking?tab=saleLines");
    const table = await screen.findByTestId("tracking-saleline-table");
    expect(within(table).getByText("Sold under a hold")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Load more/ }));
    expect(await within(table).findByText("ERPNext posting held")).toBeTruthy();
    expect(api.listSaleLineFindings).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "c1" }),
    );
    expect(
      within(screen.getByRole("tab", { name: /Sale-line findings/ })).queryByText(/\d/),
    ).toBeNull();
  });

  test("the kind filter reads again with that kind (the sold-under-hold view)", async () => {
    renderAt("/tracking?tab=saleLines");
    await screen.findByTestId("tracking-saleline-table");
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "sold_under_hold" } });
    await waitFor(() =>
      expect(api.listSaleLineFindings).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "sold_under_hold" }),
      ),
    );
  });

  test("empty and failed states are distinct", async () => {
    api.listSaleLineFindings.mockResolvedValue(ok({ items: [], nextCursor: null }));
    renderAt("/tracking?tab=saleLines");
    expect(await screen.findByText("No sale-line findings are recorded.")).toBeTruthy();
    cleanup();
    api.listSaleLineFindings.mockResolvedValue(failure(500));
    renderAt("/tracking?tab=saleLines");
    expect(await screen.findByText("Sale-line findings could not be loaded.")).toBeTruthy();
  });

  test("a store_manager sees the findings without an identity link", async () => {
    activeContext.mockReturnValue(ctx("store_manager"));
    renderAt("/tracking?tab=saleLines");
    const table = await screen.findByTestId("tracking-saleline-table");
    expect(within(table).queryByRole("link")).toBeNull();
  });
});

describe("gate (OD-T4)", () => {
  test("with the switch off nothing of part 2 is read", async () => {
    getTrackedSelling.mockResolvedValue({ status: 404, error: { error: { code: "not_found" } } });
    renderAt("/tracking?tab=resolution");
    expect(await screen.findByTestId("tracking-selling-off")).toBeTruthy();
    expect(api.listTrackingResolutionQueue).not.toHaveBeenCalled();
    expect(api.listSaleLineFindings).not.toHaveBeenCalled();
  });
});
