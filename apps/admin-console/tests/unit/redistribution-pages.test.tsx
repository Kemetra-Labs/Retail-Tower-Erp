import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";

const listRedistributionProposals = vi.fn();
const getRedistributionProposal = vi.fn();
const createRedistributionProposal = vi.fn();
const reviewRedistributionProposal = vi.fn();
const acceptRedistributionProposal = vi.fn();
const rejectRedistributionProposal = vi.fn();
vi.mock("@/lib/redistribution-queries", () => ({
  listRedistributionProposals: (...a: unknown[]) => listRedistributionProposals(...a),
  getRedistributionProposal: (...a: unknown[]) => getRedistributionProposal(...a),
  createRedistributionProposal: (...a: unknown[]) => createRedistributionProposal(...a),
  reviewRedistributionProposal: (...a: unknown[]) => reviewRedistributionProposal(...a),
  acceptRedistributionProposal: (...a: unknown[]) => acceptRedistributionProposal(...a),
  rejectRedistributionProposal: (...a: unknown[]) => rejectRedistributionProposal(...a),
}));
const consoleGetCatalogProduct = vi.fn();
vi.mock("@/lib/catalog-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog-queries")>();
  return {
    ...actual,
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

import { createQueryClient } from "@/lib/query";
import { RedistributionList } from "@/redistribution/RedistributionList";
import { RedistributionPage } from "@/redistribution/RedistributionPage";
import {
  LINE_1,
  LINE_2,
  PRODUCT_1,
  PROPOSAL_ID,
  STORE_A,
  STORE_B,
  TRANSFER_1,
  createdOutcome,
  droppedOutcome,
  line,
  proposal,
  summary,
} from "./redistribution-fixtures";

/**
 * RT-1601 acceptance 1: the redistribution screens' states, errors and role visibility. The Console
 * computes nothing: every line, quantity and outcome on screen is one the mocked Backend-Core sent.
 */

const asRole = (role: string, membership: Record<string, unknown> = {}) => ({
  context: {
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_store: null,
    active_role_code: role,
    memberships: [{ tenant_id: "t1", ...membership }],
  },
});
const notFound = {
  status: 404,
  error: { error: { code: "not_found", message: "Not Found", request_id: "req-404" } },
};

function renderAt(path: string): void {
  const client = createQueryClient();
  function Tree({ children }: Readonly<{ children: ReactNode }>) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  render(
    <Tree>
      <Routes>
        <Route path="/inventory/redistribution" element={<RedistributionList />} />
        <Route path="/inventory/redistribution/:proposalId" element={<RedistributionPage />} />
      </Routes>
    </Tree>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  activeContext.mockReturnValue(asRole("owner", { store_access_kind: "all" }));
  consoleGetCatalogProduct.mockImplementation(async (id: string) => ({
    status: 200,
    data: { summary: { productId: id, name: id === PRODUCT_1 ? "Mineral water" : "Juice" } },
  }));
  listRedistributionProposals.mockResolvedValue({
    status: 200,
    data: { items: [summary()], nextCursor: null },
  });
  getRedistributionProposal.mockResolvedValue({ status: 200, data: proposal() });
});

describe("role visibility", () => {
  test.each([
    ["store_manager", { store_access_kind: "specific" }],
    ["store_staff", { store_access_kind: "specific" }],
    ["cashier", { store_access_kind: "all" }],
  ])("%s with %o gets NoAccess and nothing is requested", async (role, membership) => {
    activeContext.mockReturnValue(asRole(role, membership));
    renderAt("/inventory/redistribution");
    expect(await screen.findByText("No assigned access")).toBeTruthy();
    expect(listRedistributionProposals).not.toHaveBeenCalled();
  });

  test.each(["owner", "tenant_admin"])(
    "a store-scoped %s gets the non-disclosing view, no compute, nothing requested",
    async (role) => {
      activeContext.mockReturnValue(asRole(role, { store_access_kind: "specific" }));
      renderAt("/inventory/redistribution");
      expect(
        await screen.findByText(
          "Redistribution proposals are not available for this organization.",
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Compute a new proposal" })).toBeNull();
      expect(listRedistributionProposals).not.toHaveBeenCalled();
    },
  );

  test("the detail page is gated the same way", async () => {
    activeContext.mockReturnValue(asRole("store_manager", { store_access_kind: "specific" }));
    renderAt(`/inventory/redistribution/${PROPOSAL_ID}`);
    expect(await screen.findByText("No assigned access")).toBeTruthy();
    activeContext.mockReturnValue(asRole("owner", { store_access_kind: "specific" }));
    renderAt(`/inventory/redistribution/${PROPOSAL_ID}`);
    expect(await screen.findByText("This proposal or this action is not available.")).toBeTruthy();
    expect(getRedistributionProposal).not.toHaveBeenCalled();
  });

  test("a tenant_admin with every store sees the list and can compute", async () => {
    activeContext.mockReturnValue(asRole("tenant_admin", { store_access_kind: "all" }));
    renderAt("/inventory/redistribution");
    expect(await screen.findByRole("button", { name: /Open the proposal/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compute a new proposal" })).toBeTruthy();
  });

  test("no active tenant: a scope prompt, nothing requested", async () => {
    activeContext.mockReturnValue({ context: { ...asRole("owner").context, active_tenant: null } });
    renderAt("/inventory/redistribution");
    expect(await screen.findByText(/Choose an organization/)).toBeTruthy();
    expect(listRedistributionProposals).not.toHaveBeenCalled();
  });
});

describe("list states", () => {
  test("a row shows the state, the shortfall before and after, and the counts", async () => {
    renderAt("/inventory/redistribution");
    await screen.findByRole("button", { name: /Open the proposal/ });
    const row = screen.getAllByRole("row")[1] as HTMLElement;
    expect(within(row).getByText("Open", { selector: ".badge" })).toBeTruthy();
    expect(within(row).getByText("20.0000")).toBeTruthy();
    expect(within(row).getByText("4.0000")).toBeTruthy();
  });

  test("empty", async () => {
    listRedistributionProposals.mockResolvedValue({
      status: 200,
      data: { items: [], nextCursor: null },
    });
    renderAt("/inventory/redistribution");
    expect(await screen.findByText("No proposals yet.")).toBeTruthy();
  });

  test("feature off (404): not available, no compute, never why", async () => {
    listRedistributionProposals.mockResolvedValue(notFound);
    renderAt("/inventory/redistribution");
    expect(
      await screen.findByText("Redistribution proposals are not available for this organization."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Compute a new proposal" })).toBeNull();
    expect(screen.queryByText("Not Found")).toBeNull();
  });

  test("a failed read shows catalog copy and the request id", async () => {
    listRedistributionProposals.mockResolvedValue({
      status: 500,
      error: { error: { code: "internal_error", message: "boom", request_id: "req-500" } },
    });
    renderAt("/inventory/redistribution");
    expect(await screen.findByText("Redistribution proposals could not be loaded.")).toBeTruthy();
    expect(screen.getByText(/req-500/)).toBeTruthy();
    expect(screen.queryByText("boom")).toBeNull();
  });
});

describe("compute", () => {
  test("201 opens the new proposal, with an Idempotency-Key", async () => {
    createRedistributionProposal.mockResolvedValue({ status: 201, data: proposal() });
    renderAt("/inventory/redistribution");
    fireEvent.click(await screen.findByRole("button", { name: "Compute a new proposal" }));
    expect(await screen.findByText("Redistribution proposal")).toBeTruthy();
    expect(createRedistributionProposal).toHaveBeenCalledWith({}, expect.any(String));
  });

  test("200 nothing_to_move says so and that the open proposal was replaced", async () => {
    createRedistributionProposal.mockResolvedValue({
      status: 200,
      data: {
        result: "nothing_to_move",
        supersededProposalId: PROPOSAL_ID,
        rule: { name: "reorder_gap_greedy", version: "1.0.0" },
        computedAt: "2026-11-26T08:00:00.000Z",
        stores: [],
        warnings: [],
      },
    });
    renderAt("/inventory/redistribution");
    fireEvent.click(await screen.findByRole("button", { name: "Compute a new proposal" }));
    expect(await screen.findByText(/previous open proposal ended/)).toBeTruthy();
  });

  test("422 names the refusal", async () => {
    createRedistributionProposal.mockResolvedValue({
      status: 422,
      error: { error: { code: "redistribution_too_large", message: "m", request_id: "r" } },
    });
    renderAt("/inventory/redistribution");
    fireEvent.click(await screen.findByRole("button", { name: "Compute a new proposal" }));
    expect(await screen.findByText(/Too many stores or products/)).toBeTruthy();
  });
});

describe("proposal: shadow phase", () => {
  test("shows read times, exclusions and warnings; no accept control", async () => {
    renderAt(`/inventory/redistribution/${PROPOSAL_ID}`);
    expect(await screen.findByText(/Trial phase/)).toBeTruthy();
    expect(screen.getByText("A POS has not checked in recently")).toBeTruthy();
    expect(screen.getByText(/Reorder level not set/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Accept/ })).toBeNull();
    expect(await screen.findByText("Mineral water")).toBeTruthy();
  });

  test("review sends one decision per line", async () => {
    const reviewed = proposal({
      state: "reviewed",
      lines: [
        line({
          reviewDecision: {
            decision: "would_accept",
            note: null,
            decidedAt: "2026-11-26T08:05:00.000Z",
            decidedBy: "u",
          },
        }),
        line({ id: LINE_2 }),
      ],
    });
    reviewRedistributionProposal.mockImplementation(async () => {
      // The server now holds the decision: the re-read after the command returns it too.
      getRedistributionProposal.mockResolvedValue({ status: 200, data: reviewed });
      return { status: 200, data: reviewed };
    });
    renderAt(`/inventory/redistribution/${PROPOSAL_ID}`);
    const group = await screen.findByRole("group", { name: /Review the Mineral water line/ });
    fireEvent.click(within(group).getByRole("button", { name: "Would accept" }));
    await waitFor(() =>
      expect(reviewRedistributionProposal).toHaveBeenCalledWith(
        PROPOSAL_ID,
        [{ lineId: LINE_1, decision: "would_accept" }],
        expect.any(String),
      ),
    );
    await waitFor(() =>
      expect(
        within(group).getByRole("button", { name: "Would accept" }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });

  test("a superseded proposal answers with catalog copy and is read again", async () => {
    reviewRedistributionProposal.mockResolvedValue({
      status: 409,
      error: { error: { code: "proposal_superseded", message: "m", request_id: "r9" } },
    });
    renderAt(`/inventory/redistribution/${PROPOSAL_ID}`);
    const group = await screen.findByRole("group", { name: /Review the Mineral water line/ });
    fireEvent.click(within(group).getByRole("button", { name: "Would reject" }));
    expect(await screen.findByText(/A newer proposal replaced this one/)).toBeTruthy();
    await waitFor(() => expect(getRedistributionProposal).toHaveBeenCalledTimes(2));
  });

  test("a terminal proposal offers no decision", async () => {
    getRedistributionProposal.mockResolvedValue({
      status: 200,
      data: proposal({ state: "expired" }),
    });
    renderAt(`/inventory/redistribution/${PROPOSAL_ID}`);
    expect(await screen.findByText("Expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Would accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject proposal" })).toBeNull();
  });

  test("404: this proposal is not available, never why (it may be an unknown id)", async () => {
    getRedistributionProposal.mockResolvedValue(notFound);
    renderAt(`/inventory/redistribution/${PROPOSAL_ID}`);
    expect(await screen.findByText("This proposal or this action is not available.")).toBeTruthy();
    expect(screen.queryByText(/not available for this organization/)).toBeNull();
  });
});

describe("proposal: live phase", () => {
  test("accept the selected line into a draft transfer and show each outcome", async () => {
    getRedistributionProposal.mockResolvedValue({
      status: 200,
      data: proposal({ acceptEnabled: true }),
    });
    const after = proposal({
      acceptEnabled: true,
      state: "accepted",
      lines: [
        line({ acceptOutcome: createdOutcome }),
        line({ id: LINE_2, acceptOutcome: droppedOutcome }),
      ],
    });
    acceptRedistributionProposal.mockImplementation(async () => {
      getRedistributionProposal.mockResolvedValue({ status: 200, data: after });
      return {
        status: 200,
        data: {
          lines: [
            { lineId: LINE_1, outcome: createdOutcome },
            { lineId: LINE_2, outcome: droppedOutcome },
          ],
          transferIds: [TRANSFER_1],
          proposal: after,
        },
      };
    });
    renderAt(`/inventory/redistribution/${PROPOSAL_ID}`);
    const open = await screen.findByRole("button", { name: "Accept selected lines" });
    expect((open as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Mineral water/ }));
    fireEvent.click(screen.getByRole("button", { name: "Accept 1 selected line" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Nothing is approved, dispatched or reserved/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm accepting 1 line" }));
    await waitFor(() =>
      expect(acceptRedistributionProposal).toHaveBeenCalledWith(
        PROPOSAL_ID,
        [LINE_1],
        expect.any(String),
      ),
    );
    expect(await within(dialog).findByText(/Created in full: 1/)).toBeTruthy();
    expect(within(dialog).getByText(TRANSFER_1)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(await screen.findByText(/The source store's data is no longer current/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: new RegExp(TRANSFER_1) }).length).toBeGreaterThan(0);
  });

  test("proposal_stale: nothing created, compute again", async () => {
    getRedistributionProposal.mockResolvedValue({
      status: 200,
      data: proposal({ acceptEnabled: true }),
    });
    acceptRedistributionProposal.mockResolvedValue({
      status: 409,
      error: { error: { code: "proposal_stale", message: "m", request_id: "r" } },
    });
    renderAt(`/inventory/redistribution/${PROPOSAL_ID}`);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Mineral water/ }));
    fireEvent.click(screen.getByRole("button", { name: "Accept 1 selected line" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm accepting 1 line" }));
    expect(await within(dialog).findByText(/No transfer was created/)).toBeTruthy();
  });
});

describe("Idempotency-Key", () => {
  async function openAcceptDialog() {
    fireEvent.click(await screen.findByRole("checkbox", { name: /Mineral water/ }));
    fireEvent.click(screen.getByRole("button", { name: "Accept 1 selected line" }));
    return screen.findByRole("dialog");
  }
  const keyOf = (call: number) => acceptRedistributionProposal.mock.calls[call]?.[2];

  test("an unclear answer keeps the key, so the retry replays; a terminal one mints a new key", async () => {
    getRedistributionProposal.mockResolvedValue({
      status: 200,
      data: proposal({ acceptEnabled: true }),
    });
    acceptRedistributionProposal
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({
        status: 400,
        error: { error: { code: "validation_error", message: "m", request_id: "r" } },
      })
      .mockResolvedValueOnce({ status: 503 });
    renderAt(`/inventory/redistribution/${PROPOSAL_ID}`);
    const dialog = await openAcceptDialog();
    const commit = () =>
      fireEvent.click(within(dialog).getByRole("button", { name: "Confirm accepting 1 line" }));
    commit();
    expect(await within(dialog).findByText(/No clear answer arrived/)).toBeTruthy();
    await waitFor(() => expect(acceptRedistributionProposal).toHaveBeenCalledTimes(1));
    commit();
    await waitFor(() => expect(acceptRedistributionProposal).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).toBe(keyOf(0));
    expect(await within(dialog).findByText(/refused the request data/)).toBeTruthy();
    commit();
    await waitFor(() => expect(acceptRedistributionProposal).toHaveBeenCalledTimes(3));
    expect(keyOf(2)).not.toBe(keyOf(1));
  });
});

describe("warm cache and continuation", () => {
  test("list: a later 404 hides the cached rows and the compute", async () => {
    createRedistributionProposal.mockImplementation(async () => {
      listRedistributionProposals.mockResolvedValue(notFound);
      return {
        status: 200,
        data: {
          result: "nothing_to_move",
          supersededProposalId: null,
          rule: { name: "reorder_gap_greedy", version: "1.0.0" },
          computedAt: "2026-11-26T08:00:00.000Z",
          stores: [],
          warnings: [],
        },
      };
    });
    renderAt("/inventory/redistribution");
    fireEvent.click(await screen.findByRole("button", { name: "Compute a new proposal" }));
    expect(
      await screen.findByText("Redistribution proposals are not available for this organization."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open the proposal/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compute a new proposal" })).toBeNull();
  });

  test("detail: a later 404 hides the cached proposal and its decision controls", async () => {
    reviewRedistributionProposal.mockImplementation(async () => {
      getRedistributionProposal.mockResolvedValue(notFound);
      return {
        status: 409,
        error: { error: { code: "proposal_superseded", message: "m", request_id: "r" } },
      };
    });
    renderAt(`/inventory/redistribution/${PROPOSAL_ID}`);
    const group = await screen.findByRole("group", { name: /Review the Mineral water line/ });
    fireEvent.click(within(group).getByRole("button", { name: "Would accept" }));
    expect(await screen.findByText("This proposal or this action is not available.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Would accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject proposal" })).toBeNull();
  });

  test("a failed Load more keeps the rows, and Retry asks for the next page again", async () => {
    listRedistributionProposals
      .mockResolvedValueOnce({ status: 200, data: { items: [summary()], nextCursor: "c2" } })
      .mockResolvedValueOnce({
        status: 500,
        error: { error: { code: "internal_error", message: "m", request_id: "req-p2" } },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { items: [summary({ id: "p2" })], nextCursor: null },
      });
    renderAt("/inventory/redistribution");
    fireEvent.click(await screen.findByRole("button", { name: "Show older proposals" }));
    expect(await screen.findByText("Redistribution proposals could not be loaded.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Open the proposal/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Retry|Try again/ }));
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /Open the proposal/ })).toHaveLength(2),
    );
    expect(listRedistributionProposals).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "c2" }),
    );
  });

  test("no line review can start while a decision dialog is open", async () => {
    renderAt(`/inventory/redistribution/${PROPOSAL_ID}`);
    const group = await screen.findByRole("group", { name: /Review the Mineral water line/ });
    fireEvent.click(screen.getByRole("button", { name: "Reject proposal" }));
    await screen.findByRole("dialog");
    expect((group as HTMLFieldSetElement).disabled).toBe(true);
    fireEvent.click(within(group).getByRole("button", { name: "Would accept" }));
    expect(reviewRedistributionProposal).not.toHaveBeenCalled();
  });

  test("access narrowed to some stores after a failed read shows the non-disclosing view", async () => {
    listRedistributionProposals.mockResolvedValue({
      status: 500,
      error: { error: { code: "internal_error", message: "m", request_id: "r" } },
    });
    renderAt("/inventory/redistribution");
    expect(await screen.findByText("Redistribution proposals could not be loaded.")).toBeTruthy();
    activeContext.mockReturnValue(asRole("owner", { store_access_kind: "specific" }));
    fireEvent.click(screen.getByRole("button", { name: /Retry|Try again/ }));
    expect(
      await screen.findByText("Redistribution proposals are not available for this organization."),
    ).toBeTruthy();
  });
});

describe("reject", () => {
  test("needs a reason, then rejects", async () => {
    rejectRedistributionProposal.mockResolvedValue({
      status: 200,
      data: proposal({ state: "rejected", rejectReason: "Stock count first" }),
    });
    renderAt(`/inventory/redistribution/${PROPOSAL_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "Reject proposal" }));
    const dialog = await screen.findByRole("dialog");
    const commit = within(dialog).getByRole("button", { name: "Confirm rejecting the proposal" });
    expect((commit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Reason for rejection"), {
      target: { value: "  Stock count first " },
    });
    fireEvent.click(commit);
    await waitFor(() =>
      expect(rejectRedistributionProposal).toHaveBeenCalledWith(
        PROPOSAL_ID,
        "Stock count first",
        expect.any(String),
      ),
    );
    expect(await within(dialog).findByText("Proposal rejected.")).toBeTruthy();
  });
});
