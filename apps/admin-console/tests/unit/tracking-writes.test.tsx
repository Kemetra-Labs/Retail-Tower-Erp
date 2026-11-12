import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * RT-455 (owner approval, comment 15245): the four governed commands against
 * mocked contract answers. Until RT-453 writes identities each one answers 404,
 * and the screen must say nothing was recorded, never show a success. Also: the
 * «أخرى» note rule, release for the owner only (recessed with the reason for a
 * tenant_admin) behind a confirm step, the held key on a retry after no answer,
 * and the recall built from the picked product's batches.
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
  listTrackingResolutionQueue: vi.fn(),
  listSaleLineFindings: vi.fn(),
  placeQualityHold: vi.fn(),
  releaseTrackingHold: vi.fn(),
  createInventoryRecall: vi.fn(),
  correctTrackingIdentityExpiry: vi.fn(),
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
  listTrackingResolutionQueue: (...a: unknown[]) => api.listTrackingResolutionQueue(...a),
  listSaleLineFindings: (...a: unknown[]) => api.listSaleLineFindings(...a),
  placeQualityHold: (...a: unknown[]) => api.placeQualityHold(...a),
  releaseTrackingHold: (...a: unknown[]) => api.releaseTrackingHold(...a),
  createInventoryRecall: (...a: unknown[]) => api.createInventoryRecall(...a),
  correctTrackingIdentityExpiry: (...a: unknown[]) => api.correctTrackingIdentityExpiry(...a),
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
const catalog = { getProduct: vi.fn(), listProducts: vi.fn() };
vi.mock("@/lib/catalog-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog-queries")>();
  return {
    ...actual,
    consoleGetCatalogProduct: (...a: unknown[]) => catalog.getProduct(...a),
    consoleListCatalogProducts: (...a: unknown[]) => catalog.listProducts(...a),
  };
});
const listTrackingIdentities = vi.fn();
vi.mock("@/lib/inventory-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inventory-queries")>();
  return {
    ...actual,
    listTrackingIdentities: (...a: unknown[]) => listTrackingIdentities(...a),
  };
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
import { WRITE_TIMEOUT_MS, useCreateRecall } from "@/tracking/useTrackingWrites";

const PRODUCT = "0190f000-0000-7000-8000-0000000007c1";
const IDENTITY = "0190f000-0000-7000-8000-0000000007b1";
const IDENTITY_2 = "0190f000-0000-7000-8000-0000000007b2";
const HOLD = "0190f000-0000-7000-8000-0000000007e1";
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

const ok = <T,>(data: T, status = 200) => ({ status, data });
const notFound = {
  status: 404,
  error: { error: { code: "not_found", message: "Resource not found.", request_id: "req-404" } },
};
const page = (items: unknown[]) => ok({ items, nextCursor: null });

const identity = {
  id: IDENTITY,
  productId: PRODUCT,
  kind: "batch",
  code: "LOT-2026-1004",
  expiryDate: "2027-04-04",
  manufacturedOn: "2026-10-04",
  origin: "erp_external",
};
const activeHold = {
  id: HOLD,
  trackingIdentityId: IDENTITY,
  tenantProductRef: PRODUCT,
  kind: "quality_hold",
  reasonCode: "label_misprint",
  note: null,
  recallId: null,
  placedBy: OMAR,
  placedAt: "2026-10-30T09:14:00Z",
  releasedBy: null,
  releasedAt: null,
  releaseNote: null,
  active: true,
};

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
  catalog.getProduct.mockReset();
  catalog.listProducts.mockReset();
  listTrackingIdentities.mockReset();
  listStores.mockReset();
  listMembers.mockReset();
  activeContext.mockReset();
  resetRateLimit();
  activeContext.mockReturnValue(ctx("owner"));
  getTrackedSelling.mockReset();
  getTrackedSelling.mockResolvedValue(SWITCH_ON);
  api.getTenantTrackingSummary.mockResolvedValue(ok({ hasTrackedProducts: true }));
  api.listTrackingResolutionQueue.mockResolvedValue(
    ok({ items: [], nextCursor: null, unresolvedCount: 0 }),
  );
  api.listSaleLineFindings.mockResolvedValue(ok({ items: [], nextCursor: null }));
  api.listSafetyFindings.mockResolvedValue(
    ok({ findings: [], generatedAt: "2026-11-03T12:32:00Z" }),
  );
  api.listTrackingHolds.mockResolvedValue(page([]));
  api.listInventoryRecalls.mockResolvedValue(page([]));
  api.getTrackingIdentity.mockResolvedValue(ok(identity));
  api.getTrackingHold.mockResolvedValue(ok(activeHold));
  api.getTrackingIdentityPositions.mockResolvedValue(
    ok({ trackingIdentityId: IDENTITY, tenantProductRef: PRODUCT, stores: [] }),
  );
  api.listExpiryCorrections.mockResolvedValue(page([]));
  for (const fn of [
    api.placeQualityHold,
    api.releaseTrackingHold,
    api.createInventoryRecall,
    api.correctTrackingIdentityExpiry,
  ]) {
    fn.mockResolvedValue(notFound);
  }
  catalog.getProduct.mockResolvedValue(ok({ summary: { name: "Mango juice 1 L" } }));
  catalog.listProducts.mockResolvedValue(
    ok({
      items: [
        {
          productId: PRODUCT,
          name: "Mango juice 1 L",
          status: "active",
          categoryId: null,
          categoryName: null,
          primarySku: "MJ-1",
          primaryBarcode: null,
        },
      ],
      nextCursor: null,
    }),
  );
  listTrackingIdentities.mockResolvedValue(
    page([identity, { ...identity, id: IDENTITY_2, code: "LOT-2026-1005" }]),
  );
  listStores.mockResolvedValue({ status: 200, data: [] });
  listMembers.mockResolvedValue({ status: 200, data: [] });
});

afterEach(cleanup);

async function openPlaceHold(): Promise<HTMLElement> {
  renderAt(`/tracking/identities/${IDENTITY}`);
  fireEvent.click(await screen.findByRole("button", { name: "Place quality hold" }));
  return screen.findByTestId("tracking-place-hold");
}

describe("place a quality hold", () => {
  test("«Other» without a note is stopped before anything is sent", async () => {
    const form = await openPlaceHold();
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "other" } });
    fireEvent.click(within(form).getByRole("button", { name: "Place hold" }));
    expect(await within(form).findByText("Write a note that explains “Other”.")).toBeTruthy();
    expect(api.placeQualityHold).not.toHaveBeenCalled();
  });

  test("the 404 until RT-453: nothing recorded, the server's words, the console hint", async () => {
    const form = await openPlaceHold();
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "other" } });
    fireEvent.change(within(form).getByLabelText(/^Note/), { target: { value: "  torn  " } });
    fireEvent.click(within(form).getByRole("button", { name: "Place hold" }));
    const refusal = await within(form).findByTestId("tracking-write-refusal");
    expect(api.placeQualityHold).toHaveBeenCalledWith(
      { trackingIdentityId: IDENTITY, reasonCode: "other", note: "torn" },
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      expect.any(AbortSignal),
    );
    expect(within(refusal).getByText("Nothing was recorded")).toBeTruthy();
    expect(within(refusal).getByText("Resource not found.")).toBeTruthy();
    expect(
      within(refusal).getByText(/Tracking commands work only once batches are imported/),
    ).toBeTruthy();
    expect(within(form).queryByText(/A quality hold was placed/)).toBeNull();
  });

  test("no answer: unknown outcome, and a retry reuses the same key", async () => {
    api.placeQualityHold.mockRejectedValueOnce(new Error("offline"));
    const form = await openPlaceHold();
    fireEvent.change(within(form).getByLabelText("Reason"), {
      target: { value: "supplier_notice" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Place hold" }));
    expect(await within(form).findByText(/No answer arrived/)).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "Place hold" }));
    await waitFor(() => expect(api.placeQualityHold).toHaveBeenCalledTimes(2));
    const [first, second] = api.placeQualityHold.mock.calls.map((call) => call[1]);
    expect(second).toBe(first);
  });

  test("a 201 with the hold is the only success", async () => {
    api.placeQualityHold.mockResolvedValue(
      ok({ hold: activeHold, safetyRevision: { revision: 2 } }, 201),
    );
    const form = await openPlaceHold();
    fireEvent.change(within(form).getByLabelText("Reason"), {
      target: { value: "label_misprint" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Place hold" }));
    expect(
      await within(form).findByText(
        "A quality hold was placed on LOT-2026-1004. Holds and quantities are re-read from the server.",
      ),
    ).toBeTruthy();
  });
});

describe("release (owner only)", () => {
  test("owner: confirm step, then the 404 is shown as a refusal", async () => {
    api.listTrackingHolds.mockResolvedValue(page([activeHold]));
    renderAt(`/tracking/identities/${IDENTITY}`);
    fireEvent.click(await screen.findByRole("button", { name: "Release hold" }));
    const release = await screen.findByTestId("tracking-release");
    fireEvent.click(within(release).getByRole("button", { name: "Release hold" }));
    expect(api.releaseTrackingHold).not.toHaveBeenCalled();
    fireEvent.click(within(release).getByRole("button", { name: "Yes, release the hold" }));
    await waitFor(() =>
      expect(api.releaseTrackingHold).toHaveBeenCalledWith(HOLD, {}, expect.any(AbortSignal)),
    );
    // The outcome sits in the drawer, outside the release section (pr-review finding 1).
    const drawer = screen.getByTestId("tracking-hold-drawer");
    expect(await within(drawer).findByTestId("tracking-write-refusal")).toBeTruthy();
    expect(within(drawer).queryByText(/was released/)).toBeNull();
  });

  test("tenant_admin: the release is recessed with the reason and sends nothing", async () => {
    activeContext.mockReturnValue(ctx("tenant_admin"));
    api.listTrackingHolds.mockResolvedValue(page([activeHold]));
    renderAt(`/tracking/identities/${IDENTITY}`);
    fireEvent.click(await screen.findByRole("button", { name: "View hold" }));
    const release = await screen.findByTestId("tracking-release");
    const button = within(release).getByRole("button", { name: "Release hold" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(within(release).getByText(/Only the tenant owner can release/)).toBeTruthy();
    expect(api.releaseTrackingHold).not.toHaveBeenCalled();
  });
  test("a recorded release stays on screen after the hold re-reads as released", async () => {
    api.listTrackingHolds.mockResolvedValue(page([activeHold]));
    api.releaseTrackingHold.mockResolvedValue(
      ok({ hold: { ...activeHold, active: false }, safetyRevision: { revision: 4 } }),
    );
    api.getTrackingHold
      .mockResolvedValueOnce(ok(activeHold))
      .mockResolvedValue(ok({ ...activeHold, active: false, releasedAt: "2026-11-03T13:00:00Z" }));
    renderAt(`/tracking/identities/${IDENTITY}`);
    fireEvent.click(await screen.findByRole("button", { name: "Release hold" }));
    const drawer = await screen.findByTestId("tracking-hold-drawer");
    const release = await within(drawer).findByTestId("tracking-release");
    fireEvent.click(within(release).getByRole("button", { name: "Release hold" }));
    fireEvent.click(within(release).getByRole("button", { name: "Yes, release the hold" }));
    await waitFor(() => expect(within(drawer).queryByTestId("tracking-release")).toBeNull());
    // A success banner is a status region that fills on the next task.
    expect(await within(drawer).findByText(/The hold on LOT-2026-1004 was released/)).toBeTruthy();
  });
});

describe("expiry correction", () => {
  test("409 expiry_unchanged: the server's code and the console hint", async () => {
    api.correctTrackingIdentityExpiry.mockResolvedValue({
      status: 409,
      error: { error: { code: "expiry_unchanged", message: "Same date.", request_id: "r" } },
    });
    renderAt(`/tracking/identities/${IDENTITY}`);
    const form = await screen.findByTestId("tracking-expiry-form");
    fireEvent.change(within(form).getByLabelText("New expiry date"), {
      target: { value: "2027-04-04" },
    });
    fireEvent.change(within(form).getByLabelText("Reason"), {
      target: { value: "label_misprint" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Record correction" }));
    expect(await within(form).findByText(/That is the current expiry date/)).toBeTruthy();
    expect(api.correctTrackingIdentityExpiry).toHaveBeenCalledWith(
      IDENTITY,
      { expiryDate: "2027-04-04", reasonCode: "label_misprint" },
      expect.any(String),
      expect.any(AbortSignal),
    );
  });

  test("an empty date is refused; clearing is an explicit choice that sends null", async () => {
    renderAt(`/tracking/identities/${IDENTITY}`);
    const form = await screen.findByTestId("tracking-expiry-form");
    fireEvent.change(within(form).getByLabelText("Reason"), {
      target: { value: "supplier_notice" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Record correction" }));
    expect(
      await within(form).findByText("Choose the new date, or choose to clear the expiry date."),
    ).toBeTruthy();
    expect(api.correctTrackingIdentityExpiry).not.toHaveBeenCalled();

    fireEvent.click(within(form).getByRole("checkbox", { name: /Clear the expiry date/ }));
    fireEvent.click(within(form).getByRole("button", { name: "Record correction" }));
    expect(await within(form).findByTestId("tracking-write-refusal")).toBeTruthy();
    expect(api.correctTrackingIdentityExpiry.mock.calls[0][1]).toEqual({
      expiryDate: null,
      reasonCode: "supplier_notice",
    });
  });

  test("the success banner keeps the recorded date when the field changes", async () => {
    api.correctTrackingIdentityExpiry.mockResolvedValue(
      ok({ correction: {}, safetyRevision: { revision: 3 } }, 201),
    );
    renderAt(`/tracking/identities/${IDENTITY}`);
    const form = await screen.findByTestId("tracking-expiry-form");
    const dateField = within(form).getByLabelText("New expiry date");
    fireEvent.change(dateField, { target: { value: "2027-03-28" } });
    fireEvent.change(within(form).getByLabelText("Reason"), {
      target: { value: "label_misprint" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Record correction" }));
    expect(await within(form).findByText(/corrected to 2027-03-28/)).toBeTruthy();
    fireEvent.change(dateField, { target: { value: "2027-05-01" } });
    expect(within(form).getByText(/corrected to 2027-03-28/)).toBeTruthy();
  });
});

describe("record a recall", () => {
  test("product, batches, reason and reference; the 404 is a refusal", async () => {
    renderAt("/tracking");
    fireEvent.click(await screen.findByRole("button", { name: "Record recall" }));
    const drawer = await screen.findByTestId("tracking-recall-create");
    fireEvent.click(await within(drawer).findByRole("option", { name: /Mango juice 1 L/ }));
    expect(await within(drawer).findByText("LOT-2026-1005")).toBeTruthy();
    expect(listTrackingIdentities).toHaveBeenCalledWith(PRODUCT, {});

    fireEvent.click(within(drawer).getByRole("button", { name: "Record the recall" }));
    expect(await within(drawer).findByText("Choose at least one batch.")).toBeTruthy();
    expect(within(drawer).getByText("Enter the reference, 1 to 200 characters.")).toBeTruthy();
    expect(api.createInventoryRecall).not.toHaveBeenCalled();

    const boxes = within(drawer).getAllByRole("checkbox");
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.change(within(drawer).getByLabelText("Reason"), {
      target: { value: "authority_notice" },
    });
    fireEvent.change(within(drawer).getByLabelText("Reference"), {
      target: { value: " EDA-2026-1182 " },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Record the recall" }));
    await waitFor(() =>
      expect(api.createInventoryRecall).toHaveBeenCalledWith(
        {
          tenantProductRef: PRODUCT,
          trackingIdentityIds: [IDENTITY, IDENTITY_2],
          reasonCode: "authority_notice",
          reference: "EDA-2026-1182",
        },
        expect.any(String),
        expect.any(AbortSignal),
      ),
    );
    expect(await within(drawer).findByTestId("tracking-write-refusal")).toBeTruthy();
    expect(within(drawer).queryByText(/The recall was recorded/)).toBeNull();
  });

  test("a store_manager gets no «Record recall»", async () => {
    activeContext.mockReturnValue(ctx("store_manager"));
    renderAt("/tracking");
    await screen.findByTestId("tracking-manager-notes");
    expect(screen.queryByRole("button", { name: "Record recall" })).toBeNull();
  });
});

describe("CodeRabbit round 2", () => {
  test("a command with no answer ends as unknown after the bounded wait", async () => {
    vi.useFakeTimers();
    try {
      api.createInventoryRecall.mockReturnValue(new Promise(() => {}));
      const client = createQueryClient();
      const { result } = renderHook(() => useCreateRecall(), {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      });
      let done: Promise<unknown> = Promise.resolve();
      act(() => {
        done = result.current.submit({
          tenantProductRef: PRODUCT,
          trackingIdentityIds: [IDENTITY],
          reasonCode: "supplier_notice",
          reference: "R-1",
        });
      });
      expect(result.current.pending).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(WRITE_TIMEOUT_MS);
        await done;
      });
      expect(result.current.pending).toBe(false);
      expect(result.current.outcome).toEqual({ kind: "failed" });
      // The timeout aborts the request too, so a retry never overlaps it.
      const signal = api.createInventoryRecall.mock.calls[0][2] as AbortSignal;
      expect(signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failed active-holds refresh hides the action and says the state is unknown", async () => {
    let activeReads = 0;
    api.listTrackingHolds.mockImplementation((query: { status?: string }) => {
      if (query.status !== "active") return Promise.resolve(page([]));
      activeReads += 1;
      return Promise.resolve(
        activeReads === 1
          ? page([])
          : { status: 500, error: { error: { code: "x", message: "x", request_id: "r" } } },
      );
    });
    api.placeQualityHold.mockResolvedValue(
      ok({ hold: activeHold, safetyRevision: { revision: 2 } }, 201),
    );
    renderAt(`/tracking/identities/${IDENTITY}`);
    fireEvent.click(await screen.findByRole("button", { name: "Place quality hold" }));
    const form = await screen.findByTestId("tracking-place-hold");
    fireEvent.change(within(form).getByLabelText("Reason"), {
      target: { value: "label_misprint" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Place hold" }));
    expect(
      await screen.findByText("The batch's holds could not be loaded. Its hold state is unknown."),
    ).toBeTruthy();
    expect(screen.queryByTestId("tracking-identity-no-hold")).toBeNull();
    expect(screen.queryByRole("button", { name: "Place quality hold" })).toBeNull();
  });

  test("after a recorded clear the choice lapses and the date field is usable again", async () => {
    api.correctTrackingIdentityExpiry.mockResolvedValue(
      ok({ correction: {}, safetyRevision: { revision: 5 } }, 201),
    );
    api.getTrackingIdentity
      .mockResolvedValueOnce(ok(identity))
      .mockResolvedValue(ok({ ...identity, expiryDate: null }));
    renderAt(`/tracking/identities/${IDENTITY}`);
    const form = await screen.findByTestId("tracking-expiry-form");
    fireEvent.click(within(form).getByRole("checkbox", { name: /Clear the expiry date/ }));
    expect((within(form).getByLabelText("New expiry date") as HTMLInputElement).disabled).toBe(
      true,
    );
    fireEvent.change(within(form).getByLabelText("Reason"), {
      target: { value: "supplier_notice" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Record correction" }));
    await waitFor(() =>
      expect(within(form).queryByRole("checkbox", { name: /Clear the expiry date/ })).toBeNull(),
    );
    expect((within(form).getByLabelText("New expiry date") as HTMLInputElement).disabled).toBe(
      false,
    );
  });

  test("the recall's product cannot change while the request is pending", async () => {
    api.createInventoryRecall.mockReturnValue(new Promise(() => {}));
    renderAt("/tracking");
    fireEvent.click(await screen.findByRole("button", { name: "Record recall" }));
    const drawer = await screen.findByTestId("tracking-recall-create");
    fireEvent.click(await within(drawer).findByRole("option", { name: /Mango juice 1 L/ }));
    await within(drawer).findByText("LOT-2026-1005");
    fireEvent.click(within(drawer).getAllByRole("checkbox")[0]);
    fireEvent.change(within(drawer).getByLabelText("Reason"), {
      target: { value: "supplier_notice" },
    });
    fireEvent.change(within(drawer).getByLabelText("Reference"), { target: { value: "R-1" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Record the recall" }));
    const change = await within(drawer).findByRole("button", { name: "Change product" });
    await waitFor(() => expect((change as HTMLButtonElement).disabled).toBe(true));
  });
});
