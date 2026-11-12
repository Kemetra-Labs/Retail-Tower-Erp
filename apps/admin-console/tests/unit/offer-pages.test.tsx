import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";

const consoleListOffers = vi.fn();
const consoleGetOffer = vi.fn();
const consoleListOfferVersions = vi.fn();
const consoleCreateOfferDraft = vi.fn();
const consoleUpdateOfferDraft = vi.fn();
const consolePreviewOffer = vi.fn();
const consolePublishOffer = vi.fn();
const consolePauseOffer = vi.fn();
const consoleResumeOffer = vi.fn();
const consoleEndOffer = vi.fn();
const consoleArchiveOffer = vi.fn();
vi.mock("@/lib/offer-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/offer-queries")>();
  return {
    ...actual,
    consoleListOffers: (...a: unknown[]) => consoleListOffers(...a),
    consoleGetOffer: (...a: unknown[]) => consoleGetOffer(...a),
    consoleListOfferVersions: (...a: unknown[]) => consoleListOfferVersions(...a),
    consoleCreateOfferDraft: (...a: unknown[]) => consoleCreateOfferDraft(...a),
    consoleUpdateOfferDraft: (...a: unknown[]) => consoleUpdateOfferDraft(...a),
    consolePreviewOffer: (...a: unknown[]) => consolePreviewOffer(...a),
    consolePublishOffer: (...a: unknown[]) => consolePublishOffer(...a),
    consolePauseOffer: (...a: unknown[]) => consolePauseOffer(...a),
    consoleResumeOffer: (...a: unknown[]) => consoleResumeOffer(...a),
    consoleEndOffer: (...a: unknown[]) => consoleEndOffer(...a),
    consoleArchiveOffer: (...a: unknown[]) => consoleArchiveOffer(...a),
  };
});
const consoleListCatalogBrands = vi.fn();
const consoleCreateCatalogBrand = vi.fn();
const consoleRenameCatalogBrand = vi.fn();
vi.mock("@/lib/brand-queries", () => ({
  consoleListCatalogBrands: (...a: unknown[]) => consoleListCatalogBrands(...a),
  consoleCreateCatalogBrand: (...a: unknown[]) => consoleCreateCatalogBrand(...a),
  consoleRenameCatalogBrand: (...a: unknown[]) => consoleRenameCatalogBrand(...a),
}));
const consoleListCatalogCategories = vi.fn();
const consoleGetCatalogProduct = vi.fn();
vi.mock("@/lib/catalog-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog-queries")>();
  return {
    ...actual,
    consoleListCatalogCategories: (...a: unknown[]) => consoleListCatalogCategories(...a),
    consoleGetCatalogProduct: (...a: unknown[]) => consoleGetCatalogProduct(...a),
  };
});
const activeContext = vi.fn();
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => activeContext(),
}));
vi.mock("@/stores/useStoreQueries", () => ({
  useStoreList: (tenantId: string | null) => ({
    result: tenantId
      ? {
          kind: "rows",
          rows: [
            { id: STORE_A, name: "Maadi" },
            { id: STORE_B, name: "Zamalek" },
          ],
        }
      : undefined,
    isLoading: false,
  }),
}));

import { BrandList } from "@/brands/BrandList";
import { createQueryClient } from "@/lib/query";
import { OfferList } from "@/offers/OfferList";
import { OfferPage } from "@/offers/OfferPage";
import {
  CATEGORY_SHOES,
  OFFER_ID,
  PRODUCT_Z,
  STORE_A,
  STORE_B,
  definition,
  draftOffer,
  offer,
  preview,
} from "./offer-fixtures";

/**
 * RT-1338 (RT-286 S6) offers screens. Acceptance 2: a role without offers.publish cannot publish, and
 * a store_manager pauses only in their own stores, with a required reason. The editor follows the
 * contract's flow: Save → Preview (of the saved revision) → Publish (naming that revision).
 */

const asRole = (role: string, membership: Record<string, unknown> = {}) => ({
  context: {
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_store: null,
    active_role_code: role,
    memberships: [{ tenant_id: "t1", ...membership }],
  },
});
const managerOfA = () =>
  asRole("store_manager", { store_access_kind: "specific", accessible_store_ids: [STORE_A] });

let queryClient: ReturnType<typeof createQueryClient>;

function renderAt(path: string): void {
  queryClient = createQueryClient();
  function Tree({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  render(
    <Tree>
      <Routes>
        <Route path="/offers" element={<OfferList />} />
        <Route path="/offers/new" element={<OfferPage />} />
        <Route path="/offers/:offerId" element={<OfferPage />} />
        <Route path="/catalog/brands" element={<BrandList />} />
      </Routes>
    </Tree>,
  );
}

function summary(over: Record<string, unknown> = {}) {
  return {
    offerId: OFFER_ID,
    state: "active",
    nameAr: "اشترِ واحصل",
    nameEn: "Buy and get",
    currentVersion: 2,
    hasDraft: false,
    schedule: { timeBasis: "store_local", startsAt: "2026-11-20T09:00", endsAt: null },
    storeScope: { allStores: true },
    updatedAt: "2026-11-12T10:00:00Z",
    rematerialisationConflictCount: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  activeContext.mockReturnValue(asRole("owner", { store_access_kind: "all" }));
  consoleListCatalogCategories.mockResolvedValue({
    status: 200,
    data: { items: [{ categoryId: CATEGORY_SHOES, name: "Shoes" }] },
  });
  consoleListCatalogBrands.mockResolvedValue({ status: 200, data: { items: [] } });
  consoleGetCatalogProduct.mockResolvedValue({
    status: 200,
    data: { summary: { productId: PRODUCT_Z, name: "Runner" } },
  });
  consoleListOfferVersions.mockResolvedValue({
    status: 200,
    data: { items: [], nextCursor: null },
  });
});

describe("offers list", () => {
  test("shows state, schedule, scope and version; an owner can create", async () => {
    consoleListOffers.mockResolvedValue({
      status: 200,
      data: { items: [summary({ hasDraft: true })], nextCursor: null },
    });
    renderAt("/offers");
    expect(await screen.findByRole("cell", { name: /Buy and get/ })).toBeTruthy();
    const row = screen.getByRole("row", { name: /Buy and get/ });
    expect(within(row).getByText("Active")).toBeTruthy();
    expect(screen.getByText("All stores")).toBeTruthy();
    expect(screen.getByText("Draft in progress")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "New offer" }).length).toBeGreaterThan(0);
  });

  test("a store_manager reads their offers and sees no New offer", async () => {
    activeContext.mockReturnValue(managerOfA());
    consoleListOffers.mockResolvedValue({
      status: 200,
      data: { items: [summary()], nextCursor: null },
    });
    renderAt("/offers");
    expect(await screen.findByRole("cell", { name: /Buy and get/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New offer" })).toBeNull();
    expect(screen.getByText(/Only offers that cover your stores/)).toBeTruthy();
  });

  test("a role that cannot read gets nothing requested", async () => {
    activeContext.mockReturnValue(asRole("store_staff"));
    renderAt("/offers");
    await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
    expect(consoleListOffers).not.toHaveBeenCalled();
  });

  test("a failed read says so with catalog copy, never the server's words", async () => {
    consoleListOffers.mockResolvedValue({
      status: 500,
      error: { error: { code: "boom", message: "stack trace" } },
    });
    renderAt("/offers");
    expect(await screen.findByText("Couldn't load the offers.")).toBeTruthy();
    expect(screen.queryByText(/stack trace/)).toBeNull();
  });
});

describe("a store_manager pauses only their own stores (OD-12)", () => {
  beforeEach(() => {
    activeContext.mockReturnValue(managerOfA());
    consoleGetOffer.mockResolvedValue({ status: 200, data: offer({ state: "active" }) });
  });

  test("the offer offers Pause and nothing else: no form, publish, resume, end or archive", async () => {
    renderAt(`/offers/${OFFER_ID}`);
    expect(await screen.findByRole("button", { name: "Pause" })).toBeTruthy();
    for (const name of ["Publish", "Resume", "End offer", "Archive", "Save draft"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.getByText(/stores and pauses shown here are yours only/)).toBeTruthy();
  });

  test("the reason is required, only own stores are offered, and the pause names them", async () => {
    consolePauseOffer.mockResolvedValue({ status: 200, data: offer({ state: "active" }) });
    renderAt(`/offers/${OFFER_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    const drawer = await screen.findByRole("dialog", { name: "Pause the offer" });
    // No whole-offer choice; the roster is narrowed to the membership (Maadi only).
    expect(within(drawer).queryByLabelText("The whole offer in all stores")).toBeNull();
    expect(within(drawer).getByLabelText("Maadi")).toBeTruthy();
    expect(within(drawer).queryByLabelText("Zamalek")).toBeNull();

    fireEvent.click(within(drawer).getByRole("button", { name: "Pause" }));
    expect(await within(drawer).findAllByText("Enter the reason for pausing.")).toBeTruthy();
    expect(consolePauseOffer).not.toHaveBeenCalled();

    fireEvent.change(within(drawer).getByLabelText(/Reason for pausing/), {
      target: { value: "Wrong price" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Pause" }));
    expect(await within(drawer).findAllByText("Choose at least one store.")).toBeTruthy();
    fireEvent.click(within(drawer).getByLabelText("Maadi"));
    fireEvent.click(within(drawer).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(consolePauseOffer).toHaveBeenCalledTimes(1));
    const [id, body, key] = consolePauseOffer.mock.calls[0];
    expect(id).toBe(OFFER_ID);
    expect(body).toEqual({ reason: "Wrong price", storeIds: [STORE_A] });
    expect(key).toMatch(/^[\x21-\x7E]{16,128}$/);
  });

  test("a 403 from the server is a banner in the drawer, in catalog copy", async () => {
    consolePauseOffer.mockResolvedValue({
      status: 403,
      error: { error: { code: "forbidden", message: "nope" } },
    });
    renderAt(`/offers/${OFFER_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    const drawer = await screen.findByRole("dialog", { name: "Pause the offer" });
    fireEvent.change(within(drawer).getByLabelText(/Reason for pausing/), {
      target: { value: "r" },
    });
    fireEvent.click(within(drawer).getByLabelText("Maadi"));
    fireEvent.click(within(drawer).getByRole("button", { name: "Pause" }));
    expect(
      await within(drawer).findByText("You don't have permission for this action."),
    ).toBeTruthy();
  });
});

describe("an owner's lifecycle controls", () => {
  test("an active offer can be paused as a whole, ended and (when ended) archived, each after a confirm", async () => {
    consoleGetOffer.mockResolvedValue({ status: 200, data: offer({ state: "active" }) });
    consoleEndOffer.mockResolvedValue({ status: 200, data: offer({ state: "ended" }) });
    renderAt(`/offers/${OFFER_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    const drawer = await screen.findByRole("dialog", { name: "Pause the offer" });
    expect(within(drawer).getByLabelText("The whole offer in all stores")).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "End offer" }));
    expect(screen.getByText(/can't be brought back/)).toBeTruthy();
    expect(consoleEndOffer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "End the offer" }));
    await waitFor(() => expect(consoleEndOffer).toHaveBeenCalledWith(OFFER_ID, expect.any(String)));
    expect(await screen.findByText("The offer ended.")).toBeTruthy();
  });

  test("a paused offer shows the reason and can be resumed after a confirm", async () => {
    consoleGetOffer.mockResolvedValue({
      status: 200,
      data: offer({
        state: "paused",
        pause: { pausedAt: "2026-11-12T11:00:00Z", pausedByUserId: "u", reason: "Wrong price" },
      }),
    });
    consoleResumeOffer.mockResolvedValue({ status: 200, data: offer({ state: "active" }) });
    renderAt(`/offers/${OFFER_ID}`);
    expect(await screen.findByText("Wrong price")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume the offer" }));
    await waitFor(() =>
      expect(consoleResumeOffer).toHaveBeenCalledWith(OFFER_ID, {}, expect.any(String)),
    );
  });

  test("a resume refused for overlapping offers lists the conflicts (OD-7)", async () => {
    consoleGetOffer.mockResolvedValue({ status: 200, data: offer({ state: "paused" }) });
    consoleResumeOffer.mockResolvedValue({
      status: 409,
      error: {
        error: {
          code: "offer_conflict",
          message: "x",
          conflicts: [
            {
              offerId: "o2",
              offerVersion: 1,
              nameAr: "عرض آخر",
              state: "active",
              sharedProductCount: 3,
            },
          ],
        },
      },
    });
    renderAt(`/offers/${OFFER_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume the offer" }));
    expect(await screen.findByText(/conflicts with other live or paused offers/)).toBeTruthy();
    expect(screen.getByText(/3 shared items/)).toBeTruthy();
  });
});

describe("the editor: Save → Preview → Publish", () => {
  beforeEach(() => {
    consoleGetOffer.mockResolvedValue({ status: 200, data: draftOffer() });
  });

  test("Publish is not offered until a publishable preview of the saved revision exists", async () => {
    renderAt(`/offers/${OFFER_ID}`);
    const publish = await screen.findByRole("button", { name: "Publish" });
    expect((publish as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Preview the saved draft before publishing.")).toBeTruthy();
    // The chosen exclusion is named, and exclusion-wins is said in the copy.
    expect(await screen.findByText("Runner")).toBeTruthy();
    expect(screen.getAllByText(/Exclusion always wins/).length).toBeGreaterThan(0);
  });

  test("preview shows the count, the sample and the simulation box; then Publish names the revision", async () => {
    consolePreviewOffer.mockResolvedValue({ status: 200, data: preview() });
    consolePublishOffer.mockResolvedValue({ status: 200, data: offer({ state: "scheduled" }) });
    renderAt(`/offers/${OFFER_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "Validate and preview" }));
    await waitFor(() => expect(consolePreviewOffer).toHaveBeenCalledWith(OFFER_ID, 1, undefined));
    expect(await screen.findByText("12 eligible items")).toBeTruthy();
    expect(await screen.findByText("The draft can be published now.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Cart simulation" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(consolePublishOffer).toHaveBeenCalledTimes(1));
    const [id, revision, key] = consolePublishOffer.mock.calls[0];
    expect([id, revision]).toEqual([OFFER_ID, 1]);
    expect(key).toMatch(/^[\x21-\x7E]{16,128}$/);
    expect(await screen.findByText(/The offer was published/)).toBeTruthy();
  });

  test("a preview with an issue or a conflict blocks Publish and says why", async () => {
    consolePreviewOffer.mockResolvedValue({
      status: 200,
      data: preview({
        publishable: false,
        issues: [{ code: "offer_eligible_set_empty", message: "x" }],
        conflicts: [
          {
            offerId: "o2",
            offerVersion: 1,
            nameAr: "عرض آخر",
            state: "paused",
            sharedProductCount: 1,
            sharedProductSample: [],
          },
        ],
      }),
    });
    renderAt(`/offers/${OFFER_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "Validate and preview" }));
    expect(await screen.findByText("The offer matches no active item.")).toBeTruthy();
    expect(screen.getByText(/1 shared item/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("a simulation sends exact decimal strings and shows only the server's result", async () => {
    consolePreviewOffer.mockResolvedValueOnce({ status: 200, data: preview() });
    consolePreviewOffer.mockResolvedValueOnce({
      status: 200,
      data: preview({
        simulation: {
          currencyCode: "EGP",
          applications: 1,
          totalDiscount: "40.00",
          total: "160.00",
          lines: [
            {
              lineIndex: 0,
              unitPrice: "100.00",
              quantity: 1,
              eligible: true,
              discountAmount: "0.00",
              lineAmount: "100.00",
            },
            {
              lineIndex: 1,
              unitPrice: "100.00",
              quantity: 1,
              eligible: true,
              discountAmount: "40.00",
              lineAmount: "60.00",
            },
          ],
        },
      }),
    });
    renderAt(`/offers/${OFFER_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "Validate and preview" }));
    const box = await screen.findByRole("region", { name: "Cart simulation" });
    fireEvent.change(within(box).getByLabelText("Unit price, line 1"), {
      target: { value: "100" },
    });
    fireEvent.change(within(box).getByLabelText("Quantity, line 1"), { target: { value: "2" } });
    fireEvent.click(within(box).getByRole("button", { name: "Run simulation" }));
    await waitFor(() => expect(consolePreviewOffer).toHaveBeenCalledTimes(2));
    expect(consolePreviewOffer.mock.calls[1]).toEqual([
      OFFER_ID,
      1,
      { currencyCode: "EGP", lines: [{ unitPrice: "100", quantity: 2 }] },
    ]);
    expect(await within(box).findByText(/Total discount: 40.00 EGP/)).toBeTruthy();
  });

  test("editing the form drops the preview and turns Preview off until the draft is saved", async () => {
    consolePreviewOffer.mockResolvedValue({ status: 200, data: preview() });
    renderAt(`/offers/${OFFER_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "Validate and preview" }));
    expect(await screen.findByText("12 eligible items")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Name in English/), { target: { value: "Changed" } });
    await waitFor(() => expect(screen.queryByText("12 eligible items")).toBeNull());
    expect(
      (screen.getByRole("button", { name: "Validate and preview" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("Save the draft first to preview it.")).toBeTruthy();
  });

  test("a stale Save keeps what was typed: nothing is reloaded under the form", async () => {
    consoleUpdateOfferDraft.mockResolvedValue({
      status: 409,
      error: { error: { code: "offer_draft_changed_concurrently", message: "x" } },
    });
    renderAt(`/offers/${OFFER_ID}`);
    const name = await screen.findByLabelText(/Name in English/);
    fireEvent.change(name, { target: { value: "My long edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText(/your changes were not saved/)).toBeTruthy();
    expect((screen.getByLabelText(/Name in English/) as HTMLInputElement).value).toBe(
      "My long edit",
    );
    expect(consoleGetOffer).toHaveBeenCalledTimes(1);
  });

  test("a 409 offer_state_invalid reads the offer again", async () => {
    consoleGetOffer.mockResolvedValueOnce({ status: 200, data: offer({ state: "active" }) });
    consoleEndOffer.mockResolvedValue({
      status: 409,
      error: { error: { code: "offer_state_invalid", message: "x" } },
    });
    consoleGetOffer.mockResolvedValue({ status: 200, data: offer({ state: "ended" }) });
    renderAt(`/offers/${OFFER_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "End offer" }));
    fireEvent.click(screen.getByRole("button", { name: "End the offer" }));
    expect(await screen.findByText(/state doesn't allow this now/)).toBeTruthy();
    await waitFor(() => expect(consoleGetOffer.mock.calls.length).toBeGreaterThan(1));
    expect(await screen.findByRole("button", { name: "Archive" })).toBeTruthy();
  });

  test("a 409 on publish is shown as stale and the offer is read again", async () => {
    consolePreviewOffer.mockResolvedValue({ status: 200, data: preview() });
    consolePublishOffer.mockResolvedValue({
      status: 409,
      error: { error: { code: "offer_draft_changed_concurrently", message: "x" } },
    });
    renderAt(`/offers/${OFFER_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "Validate and preview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    expect(await screen.findByText(/The draft changed since you opened it/)).toBeTruthy();
    await waitFor(() => expect(consoleGetOffer.mock.calls.length).toBeGreaterThan(1));
  });
});

describe("creating an offer", () => {
  test("a blocked Save lists every error in form order and sends nothing", async () => {
    renderAt("/offers/new");
    fireEvent.click(await screen.findByRole("button", { name: "Save draft" }));
    expect(
      await screen.findByRole("link", { name: "Enter the offer name in Arabic." }),
    ).toBeTruthy();
    expect(consoleCreateOfferDraft).not.toHaveBeenCalled();
  });

  test("a valid form is sent whole under a fresh Idempotency-Key, with the exclusion", async () => {
    consoleCreateOfferDraft.mockResolvedValue({ status: 201, data: draftOffer() });
    consoleGetOffer.mockResolvedValue({ status: 200, data: draftOffer() });
    renderAt("/offers/new");
    fireEvent.change(await screen.findByLabelText(/Name in Arabic/), {
      target: { value: "اشترِ واحصل" },
    });
    fireEvent.change(screen.getByLabelText(/Starts at/), { target: { value: "2026-11-20T09:00" } });
    const include = screen.getByRole("group", { name: "Include" });
    fireEvent.click(await within(include).findByLabelText("Shoes"));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(consoleCreateOfferDraft).toHaveBeenCalledTimes(1));
    const [sent, key] = consoleCreateOfferDraft.mock.calls[0];
    expect(sent).toEqual(
      expect.objectContaining({
        nameAr: "اشترِ واحصل",
        type: "buy_x_get_y_percent",
        eligibility: { include: { categoryIds: [CATEGORY_SHOES] } },
        storeScope: { allStores: true },
        schedule: { timeBasis: "store_local", startsAt: "2026-11-20T09:00", endsAt: null },
      }),
    );
    expect(sent.parameters).toMatchObject({ rewardSelection: "cheapest", percentOff: "50" });
    expect(key).toMatch(/^[\x21-\x7E]{16,128}$/);
  });

  test("a store_manager cannot create: NoAccess and nothing is requested", async () => {
    activeContext.mockReturnValue(managerOfA());
    renderAt("/offers/new");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull());
    expect(consoleCreateOfferDraft).not.toHaveBeenCalled();
  });
});

describe("a published offer starts its next draft", () => {
  test("saving with no draft sends expectedDraftRevision null", async () => {
    consoleGetOffer.mockResolvedValue({ status: 200, data: offer({ state: "active" }) });
    consoleUpdateOfferDraft.mockResolvedValue({
      status: 200,
      data: offer({
        state: "active",
        draft: {
          draftRevision: 1,
          definition: definition({ nameEn: "Renamed" }),
          updatedAt: "2026-11-12T12:00:00Z",
          updatedByUserId: "u",
        },
      }),
    });
    renderAt(`/offers/${OFFER_ID}`);
    fireEvent.change(await screen.findByLabelText(/Name in English/), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(consoleUpdateOfferDraft).toHaveBeenCalledTimes(1));
    const [id, revision, sent] = consoleUpdateOfferDraft.mock.calls[0];
    expect([id, revision, sent.nameEn]).toEqual([OFFER_ID, null, "Renamed"]);
  });
});

describe("brands page", () => {
  test("lists the brands; an owner creates one under a fresh key and the list refreshes", async () => {
    consoleListCatalogBrands.mockResolvedValueOnce({
      status: 200,
      data: { items: [{ brandId: "b1", name: "Nike", updatedAt: "2026-11-12T10:00:00Z" }] },
    });
    consoleCreateCatalogBrand.mockResolvedValue({
      status: 201,
      data: { brandId: "b2", name: "Adidas", updatedAt: "2026-11-12T11:00:00Z" },
    });
    renderAt("/catalog/brands");
    expect(await screen.findByRole("cell", { name: "Nike" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Add brand" })[0]);
    const drawer = await screen.findByRole("dialog", { name: "Add brand" });
    fireEvent.change(within(drawer).getByLabelText(/Name/), { target: { value: "  Adidas " } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Add brand" }));
    await waitFor(() => expect(consoleCreateCatalogBrand).toHaveBeenCalledTimes(1));
    expect(consoleCreateCatalogBrand.mock.calls[0][0]).toBe("Adidas");
    expect(consoleCreateCatalogBrand.mock.calls[0][1]).toMatch(/^[\x21-\x7E]{16,128}$/);
  });

  test("a name clash returns to the name field, not a banner", async () => {
    consoleListCatalogBrands.mockResolvedValue({ status: 200, data: { items: [] } });
    consoleCreateCatalogBrand.mockResolvedValue({
      status: 409,
      error: { error: { code: "brand_name_conflict", message: "x" } },
    });
    renderAt("/catalog/brands");
    fireEvent.click((await screen.findAllByRole("button", { name: "Add brand" }))[0]);
    const drawer = await screen.findByRole("dialog", { name: "Add brand" });
    fireEvent.change(within(drawer).getByLabelText(/Name/), { target: { value: "Nike" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Add brand" }));
    expect(await within(drawer).findByText("A brand with this name already exists.")).toBeTruthy();
  });

  test("a store_manager reads brands and has no create or rename", async () => {
    activeContext.mockReturnValue(managerOfA());
    consoleListCatalogBrands.mockResolvedValue({
      status: 200,
      data: { items: [{ brandId: "b1", name: "Nike", updatedAt: "2026-11-12T10:00:00Z" }] },
    });
    renderAt("/catalog/brands");
    expect(await screen.findByRole("cell", { name: "Nike" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add brand" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Rename/ })).toBeNull();
  });
});
