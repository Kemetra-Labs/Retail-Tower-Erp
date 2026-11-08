import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-455: the holds screen and the identity detail against mocked contract
 * reads. Role gating (store_manager sees findings only, never the hold or
 * recall lists), TR-6 (no tracked products), loading / empty / error states
 * (an unknown count is never a zero), the «قريبًا» tabs that call nothing, and
 * OD-3 actor names with the fallback label.
 */
const api = {
  getTenantTrackingSummary: vi.fn(),
  listSafetyFindings: vi.fn(),
  listTrackingHolds: vi.fn(),
  getTrackingHold: vi.fn(),
  listInventoryRecalls: vi.fn(),
  getInventoryRecall: vi.fn(),
  getTrackingIdentity: vi.fn(),
  getTrackingIdentityPositions: vi.fn(),
  listExpiryCorrections: vi.fn(),
};
vi.mock("@/lib/tracking-queries", () => ({
  getTenantTrackingSummary: (...a: unknown[]) => api.getTenantTrackingSummary(...a),
  listSafetyFindings: (...a: unknown[]) => api.listSafetyFindings(...a),
  listTrackingHolds: (...a: unknown[]) => api.listTrackingHolds(...a),
  getTrackingHold: (...a: unknown[]) => api.getTrackingHold(...a),
  listInventoryRecalls: (...a: unknown[]) => api.listInventoryRecalls(...a),
  getInventoryRecall: (...a: unknown[]) => api.getInventoryRecall(...a),
  getTrackingIdentity: (...a: unknown[]) => api.getTrackingIdentity(...a),
  getTrackingIdentityPositions: (...a: unknown[]) => api.getTrackingIdentityPositions(...a),
  listExpiryCorrections: (...a: unknown[]) => api.listExpiryCorrections(...a),
}));
// RT-455 part 1 (OD-T4): the tracking pages show only while the switch is on.
const getTrackedSelling = vi.fn();
vi.mock("@/lib/tracked-selling-queries", () => ({
  getTrackedSellingSetting: (...a: unknown[]) => getTrackedSelling(...a),
}));
const SWITCH_ON = {
  status: 200,
  data: {
    enabled: true,
    changedAt: "2026-11-08T18:00:00Z",
    changedBy: null,
    preconditionsMet: true,
    unmetPreconditions: [],
  },
};
const getProduct = vi.fn();
vi.mock("@/lib/catalog-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog-queries")>();
  return { ...actual, consoleGetCatalogProduct: (...a: unknown[]) => getProduct(...a) };
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
import { TrackingIdentityDetail } from "@/tracking/TrackingIdentityDetail";

const STORE = "0190f000-0000-7000-8000-0000000007a1";
const PRODUCT = "0190f000-0000-7000-8000-0000000007c1";
const IDENTITY = "0190f000-0000-7000-8000-0000000007b1";
const HOLD = "0190f000-0000-7000-8000-0000000007e1";
const RECALL = "0190f000-0000-7000-8000-0000000007f1";
const OMAR = "0190f000-0000-7000-8000-0000000000c1";
const FORMER = "0190f000-0000-7000-8000-0000000000c9";

function ctx(role: string | null = "owner") {
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
const failure = (status: number) => ({
  status,
  error: { error: { code: "x", message: "x", request_id: "req-1" } },
});
const page = (items: unknown[], nextCursor: string | null = null) => ok({ items, nextCursor });

const activeHold = {
  kind: "active_tracking_hold",
  severity: "critical",
  holdId: HOLD,
  holdKind: "quality_hold",
  recallId: null,
  trackingIdentityId: IDENTITY,
  tenantProductRef: PRODUCT,
  identityKind: "batch",
  identityCode: "LOT-2026-0912",
  expiryDate: "2027-03-12",
  placedAt: "2026-10-30T09:14:00Z",
  storeIds: [STORE],
};
const expiredRow = {
  kind: "expired_lot_sellable",
  severity: "critical",
  trackingIdentityId: IDENTITY,
  tenantProductRef: PRODUCT,
  identityKind: "batch",
  identityCode: "LOT-2026-0418",
  expiryDate: "2026-10-29",
  storeId: STORE,
  storeBusinessDate: "2026-10-31",
  sellableQuantity: "14",
  stockingUnit: "pcs",
};
const holdRecord = {
  id: HOLD,
  trackingIdentityId: IDENTITY,
  tenantProductRef: PRODUCT,
  kind: "quality_hold",
  reasonCode: "label_misprint",
  note: "Unreadable label",
  recallId: null,
  placedBy: OMAR,
  placedAt: "2026-10-30T09:14:00Z",
  releasedBy: null,
  releasedAt: null,
  releaseNote: null,
  active: true,
};
const releasedHold = {
  ...holdRecord,
  id: "0190f000-0000-7000-8000-0000000007e2",
  reasonCode: "legacy_reason",
  active: false,
  releasedBy: FORMER,
  releasedAt: "2026-10-31T10:00:00Z",
};
const recallSummary = {
  id: RECALL,
  tenantProductRef: PRODUCT,
  reasonCode: "authority_notice",
  reference: "EDA-2026-1182",
  note: null,
  effectiveAt: "2026-10-29T18:02:00Z",
  createdBy: OMAR,
  createdAt: "2026-10-29T18:02:00Z",
  holdCount: 2,
  activeHoldCount: 1,
};
const identity = {
  id: IDENTITY,
  productId: PRODUCT,
  kind: "batch",
  code: "LOT-2026-1004",
  expiryDate: "2027-04-04",
  manufacturedOn: "2026-10-04",
  origin: "erp_external",
};
const statuses = (sellable: string) =>
  ["sellable", "return_inspection", "quality_hold", "damaged", "expired", "recall_hold"].map(
    (s) => ({ inventoryStatus: s, quantity: s === "sellable" ? sellable : "0" }),
  );

function renderAt(entry: string): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/tracking" element={<TrackingHolds />} />
          <Route path="/tracking/identities/:identityId" element={<TrackingIdentityDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  getProduct.mockReset();
  listStores.mockReset();
  listMembers.mockReset();
  activeContext.mockReset();
  resetRateLimit();
  activeContext.mockReturnValue(ctx("owner"));
  getTrackedSelling.mockReset();
  getTrackedSelling.mockResolvedValue(SWITCH_ON);
  api.getTenantTrackingSummary.mockResolvedValue(ok({ hasTrackedProducts: true }));
  api.listSafetyFindings.mockResolvedValue(
    ok({ findings: [activeHold, expiredRow], generatedAt: "2026-11-03T12:32:00Z" }),
  );
  api.listTrackingHolds.mockResolvedValue(page([releasedHold]));
  api.getTrackingHold.mockResolvedValue(ok(holdRecord));
  api.listInventoryRecalls.mockResolvedValue(page([recallSummary]));
  api.getInventoryRecall.mockResolvedValue(
    ok({ ...recallSummary, holds: [{ ...holdRecord, kind: "recall_hold", recallId: RECALL }] }),
  );
  api.getTrackingIdentity.mockResolvedValue(ok(identity));
  api.getTrackingIdentityPositions.mockResolvedValue(
    ok({
      trackingIdentityId: IDENTITY,
      tenantProductRef: PRODUCT,
      stores: [
        {
          storeId: STORE,
          stockingUnit: "pcs",
          quantity: "-1",
          sellableQuantity: "-1",
          statusQuantities: statuses("-1"),
        },
      ],
    }),
  );
  api.listExpiryCorrections.mockResolvedValue(page([]));
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
        user: { id: OMAR, email: "omar@x.eg", display_name: "Omar Nabil" },
        role_code: "tenant_admin",
        store_access_kind: "all",
        revoked_at: null,
      },
    ],
  });
});

afterEach(cleanup);

describe("holds screen gate (RT-455)", () => {
  test("a role outside the findings read gets NoAccess and nothing is asked", () => {
    activeContext.mockReturnValue(ctx("cashier"));
    renderAt("/tracking");
    expect(api.listSafetyFindings).not.toHaveBeenCalled();
    expect(api.getTenantTrackingSummary).not.toHaveBeenCalled();
  });

  test("TR-6: a tenant with no tracked products sees why, and no findings are read", async () => {
    api.getTenantTrackingSummary.mockResolvedValue(ok({ hasTrackedProducts: false }));
    renderAt("/tracking");
    expect(await screen.findByTestId("tracking-not-tracked")).toBeTruthy();
    expect(screen.getByText("This tenant has no tracked products.")).toBeTruthy();
    expect(api.listSafetyFindings).not.toHaveBeenCalled();
  });
});

describe("tracked-selling switch gate (RT-455 part 1, OD-T4)", () => {
  test.each([
    ["off", { ...SWITCH_ON, data: { ...SWITCH_ON.data, enabled: false } }],
    ["the deployment gate's 404", { status: 404, error: { error: { code: "not_found" } } }],
  ])("%s: the holds screen says it is not available and reads nothing", async (_, answer) => {
    getTrackedSelling.mockResolvedValue(answer);
    renderAt("/tracking");
    expect(await screen.findByTestId("tracking-selling-off")).toBeTruthy();
    expect(
      screen.getByText("Holds and recalls is not available for this tenant now."),
    ).toBeTruthy();
    expect(api.listSafetyFindings).not.toHaveBeenCalled();
    expect(api.listTrackingHolds).not.toHaveBeenCalled();
  });

  test("off: the identity detail is hidden too and reads nothing", async () => {
    getTrackedSelling.mockResolvedValue({
      ...SWITCH_ON,
      data: { ...SWITCH_ON.data, enabled: false },
    });
    renderAt(`/tracking/identities/${IDENTITY}`);
    expect(await screen.findByTestId("tracking-selling-off")).toBeTruthy();
    expect(api.getTrackingIdentity).not.toHaveBeenCalled();
  });

  test("a failed switch read fails closed with a retry and the request id", async () => {
    getTrackedSelling.mockResolvedValueOnce({
      status: 500,
      error: { error: { code: "internal", request_id: "req_ts_1" } },
    });
    renderAt("/tracking");
    expect(
      await screen.findByText(
        "Whether batch selling is on could not be confirmed, so Holds and recalls is not shown.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("req_ts_1")).toBeTruthy();
    expect(api.listSafetyFindings).not.toHaveBeenCalled();
    getTrackedSelling.mockResolvedValue(SWITCH_ON);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("tracking-active-table")).toBeTruthy();
  });

  test("on: the holds screen renders", async () => {
    renderAt("/tracking");
    expect(await screen.findByTestId("tracking-active-table")).toBeTruthy();
    expect(getTrackedSelling).toHaveBeenCalled();
  });
});

describe("holds screen (owner)", () => {
  test("band facts count the whole findings set; active holds list with names", async () => {
    renderAt("/tracking");
    const table = await screen.findByTestId("tracking-active-table");
    expect(within(table).getByText("LOT-2026-0912")).toBeTruthy();
    expect(await within(table).findByText("Mango juice 1 L")).toBeTruthy();
    expect(await within(table).findByText("Maadi")).toBeTruthy();
    const band = screen.getByRole("banner");
    expect(within(band).getByText("Active holds")).toBeTruthy();
    expect(within(band).getByText("Expired positions still sellable")).toBeTruthy();
  });

  test("the hold drawer reads the hold and names the actor (OD-3)", async () => {
    renderAt("/tracking");
    fireEvent.click(await screen.findByRole("button", { name: "View the hold on LOT-2026-0912" }));
    const drawer = await screen.findByTestId("tracking-hold-drawer");
    expect(api.getTrackingHold).toHaveBeenCalledWith(HOLD);
    expect(await within(drawer).findByText("Omar Nabil")).toBeTruthy();
    expect(within(drawer).getByText("Label misprint")).toBeTruthy();
    expect(within(drawer).getByTestId("tracking-release-notice").textContent).toMatch(/final/);
  });

  test("a tenant_admin is told release is owner only", async () => {
    activeContext.mockReturnValue(ctx("tenant_admin"));
    renderAt("/tracking");
    fireEvent.click(await screen.findByRole("button", { name: "View the hold on LOT-2026-0912" }));
    const notice = await screen.findByTestId("tracking-release-notice");
    expect(notice.textContent).toMatch(/Only the tenant owner/);
  });

  test("released holds: unknown reason as sent, former member as the fallback", async () => {
    renderAt("/tracking?tab=released");
    const table = await screen.findByTestId("tracking-released-table");
    expect(api.listTrackingHolds).toHaveBeenCalledWith(
      expect.objectContaining({ status: "released" }),
    );
    expect(within(table).getByText("legacy_reason")).toBeTruthy();
    expect(await within(table).findByText(/Not a member now/)).toBeTruthy();
  });

  test("recalls list opens the recall drawer with its holds", async () => {
    renderAt("/tracking?tab=recalls");
    fireEvent.click(await screen.findByRole("button", { name: "View recall EDA-2026-1182" }));
    const drawer = await screen.findByTestId("tracking-recall-drawer");
    expect(api.getInventoryRecall).toHaveBeenCalledWith(RECALL);
    expect(await within(drawer).findByTestId("tracking-recall-holds")).toBeTruthy();
  });

  test("expired-sellable rows link to the product's status move", async () => {
    renderAt("/tracking?tab=expired");
    const link = await screen.findByRole("link", { name: "Move to “Expired”" });
    expect(link.getAttribute("href")).toBe(`/inventory/stores/${STORE}/products/${PRODUCT}`);
  });

  test.each(["resolution", "saleLines", "expiring"])(
    "the %s tab says what is missing and calls nothing new",
    async (tab) => {
      renderAt(`/tracking?tab=${tab}`);
      expect(
        await screen.findByTestId(
          tab === "expiring" ? "tracking-expiring-stopped" : "tracking-soon",
        ),
      ).toBeTruthy();
      expect(api.listTrackingHolds).not.toHaveBeenCalled();
      expect(api.listInventoryRecalls).not.toHaveBeenCalled();
    },
  );

  test("empty findings: the empty copy, and no consistency band", async () => {
    api.listSafetyFindings.mockResolvedValue(
      ok({ findings: [], generatedAt: "2026-11-03T12:32:00Z" }),
    );
    renderAt("/tracking");
    expect(await screen.findByText("No active holds.")).toBeTruthy();
    expect(screen.queryByTestId("tracking-consistency")).toBeNull();
  });

  test("a consistency finding shows the critical band (OD-8)", async () => {
    api.listSafetyFindings.mockResolvedValue(
      ok({
        findings: [
          {
            kind: "tracking_consistency",
            severity: "critical",
            check: "identity_without_edge_map",
            tenantProductRef: PRODUCT,
            trackingIdentityId: IDENTITY,
            storeId: null,
            stockingUnit: null,
          },
        ],
        generatedAt: "2026-11-03T12:32:00Z",
      }),
    );
    renderAt("/tracking");
    const band = await screen.findByTestId("tracking-consistency");
    expect(within(band).getByText("1 tracking consistency finding")).toBeTruthy();
    expect(within(band).getByText("Identity with no ERPNext link")).toBeTruthy();
  });

  test("a failed findings read: no counts in the band, the error says unknown", async () => {
    api.listSafetyFindings.mockResolvedValue(failure(500));
    renderAt("/tracking");
    expect(await screen.findByTestId("tracking-band-unknown")).toBeTruthy();
    expect(
      screen.getByText(
        "Tracking safety findings could not be loaded. The band's counts are unknown.",
      ),
    ).toBeTruthy();
    expect(within(screen.getByRole("banner")).queryByText("Active holds")).toBeNull();
  });
});

describe("holds screen (store_manager)", () => {
  test("findings only: no hold or recall list, no «View», no identity link", async () => {
    activeContext.mockReturnValue(ctx("store_manager"));
    renderAt("/tracking");
    const table = await screen.findByTestId("tracking-active-table");
    expect(within(table).queryByRole("button")).toBeNull();
    expect(within(table).queryByRole("link")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Released holds" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Recalls" })).toBeNull();
    expect(screen.getByTestId("tracking-manager-notes")).toBeTruthy();
    expect(api.listTrackingHolds).not.toHaveBeenCalled();
    expect(api.listInventoryRecalls).not.toHaveBeenCalled();
    expect(listMembers).not.toHaveBeenCalled();
  });
});

describe("identity detail (RT-455 II-2..II-5)", () => {
  test("owner: the identity, its holds, positions as sent and corrections", async () => {
    api.listTrackingHolds.mockResolvedValue(page([holdRecord]));
    renderAt(`/tracking/identities/${IDENTITY}?store=${STORE}`);
    expect(await screen.findByTestId("tracking-identity-fields")).toBeTruthy();
    expect(api.listTrackingHolds).toHaveBeenCalledWith(
      expect.objectContaining({ trackingIdentityId: IDENTITY, status: "all" }),
    );
    expect(await screen.findByTestId("tracking-identity-active-holds")).toBeTruthy();
    const positions = await screen.findByTestId("tracking-identity-positions");
    expect(within(positions).getAllByText("-1").length).toBeGreaterThan(0);
    expect(await screen.findByText("No expiry corrections.")).toBeTruthy();
    const back = screen.getByRole("link", { name: /Back/ });
    expect(back.getAttribute("href")).toBe(`/inventory/stores/${STORE}/products/${PRODUCT}`);
  });

  test("no hold ever: says so", async () => {
    api.listTrackingHolds.mockResolvedValue(page([]));
    renderAt(`/tracking/identities/${IDENTITY}`);
    expect(await screen.findByTestId("tracking-identity-no-hold")).toBeTruthy();
    expect(await screen.findByText("This batch has never been held.")).toBeTruthy();
  });

  test("a store_manager gets the non-disclosing answer and nothing is asked", () => {
    activeContext.mockReturnValue(ctx("store_manager"));
    renderAt(`/tracking/identities/${IDENTITY}`);
    expect(screen.getByTestId("tracking-identity-unavailable")).toBeTruthy();
    expect(api.getTrackingIdentity).not.toHaveBeenCalled();
  });

  test("a 404 reads «not available»", async () => {
    api.getTrackingIdentity.mockResolvedValue(failure(404));
    renderAt(`/tracking/identities/${IDENTITY}`);
    expect(await screen.findByTestId("tracking-identity-unavailable")).toBeTruthy();
  });

  test("a failed positions read: quantities unknown, not zero", async () => {
    api.getTrackingIdentityPositions.mockResolvedValue(failure(500));
    renderAt(`/tracking/identities/${IDENTITY}`);
    await waitFor(() =>
      expect(
        screen.getByText("The batch's stock could not be loaded. Quantities are unknown."),
      ).toBeTruthy(),
    );
  });
});
