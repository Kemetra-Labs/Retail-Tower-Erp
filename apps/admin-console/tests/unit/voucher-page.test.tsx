import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";

const consoleListVouchers = vi.fn();
const consoleGetVoucher = vi.fn();
const consoleIssueVouchers = vi.fn();
const consoleCancelVoucher = vi.fn();
vi.mock("@/lib/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client")>();
  return {
    ...actual,
    consoleListVouchers: (...a: unknown[]) => consoleListVouchers(...a),
    consoleGetVoucher: (...a: unknown[]) => consoleGetVoucher(...a),
    consoleIssueVouchers: (...a: unknown[]) => consoleIssueVouchers(...a),
    consoleCancelVoucher: (...a: unknown[]) => consoleCancelVoucher(...a),
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
            { id: "s1", name: "Maadi" },
            { id: "s2", name: "Zamalek" },
          ],
        }
      : undefined,
    isLoading: false,
  }),
}));

import { createQueryClient } from "@/lib/query";
import { VoucherList } from "@/vouchers/VoucherList";

/**
 * RT-1109 vouchers page. Owner / tenant_admin only; the list never shows a
 * code; issue sends a NEW Idempotency-Key per attempt and never retries; the
 * 201 codes show once, in the drawer only, never in browser storage or the
 * query cache; a lost answer is "uncertain" and stops offering Issue; cancel
 * confirms first, and a redeemed voucher's 409 is explained.
 */

const CODE = "ABCD-EFGH-JKMN-PQRS";

const asRole = (role: string) => ({
  context: {
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_store: null,
    active_role_code: role,
    memberships: [{ tenant_id: "t1" }],
  },
});

function voucher(over: Record<string, unknown> = {}) {
  return {
    voucher_id: "11111111-1111-4111-8111-111111111111",
    batch_id: "22222222-2222-4222-8222-222222222222",
    amount_minor: 5000,
    currency_code: "EGP",
    status: "active",
    expires_at: null,
    applies_to_all_stores: false,
    eligible_store_ids: ["s1"],
    note: null,
    created_at: "2026-11-11T10:00:00Z",
    cancelled_at: null,
    redemption: null,
    ...over,
  };
}

function issued() {
  return {
    status: 201,
    data: {
      batch_id: "22222222-2222-4222-8222-222222222222",
      vouchers: [
        {
          voucher_id: "33333333-3333-4333-8333-333333333333",
          code: CODE,
          amount_minor: 5000,
          currency_code: "EGP",
          expires_at: null,
        },
      ],
    },
  };
}

let queryClient: ReturnType<typeof createQueryClient>;

function renderPage(): void {
  queryClient = createQueryClient();
  function Tree({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  render(
    <Tree>
      <VoucherList />
    </Tree>,
  );
}

async function openIssueAndFill(amount = "50"): Promise<HTMLElement> {
  fireEvent.click((await screen.findAllByRole("button", { name: "Issue vouchers" }))[0]);
  const drawer = await screen.findByRole("dialog", { name: "Issue vouchers" });
  fireEvent.change(within(drawer).getByLabelText(/Number of vouchers/), { target: { value: "1" } });
  fireEvent.change(within(drawer).getByLabelText(/Value of each voucher/), {
    target: { value: amount },
  });
  return drawer;
}

function submit(drawer: HTMLElement): void {
  fireEvent.click(within(drawer).getByRole("button", { name: "Issue the vouchers" }));
}

function cacheHolds(text: string): boolean {
  return JSON.stringify(
    queryClient
      .getQueryCache()
      .getAll()
      .map((q) => q.state.data),
  ).includes(text);
}

describe("VoucherList", () => {
  beforeEach(() => {
    for (const fn of [
      consoleListVouchers,
      consoleGetVoucher,
      consoleIssueVouchers,
      consoleCancelVoucher,
    ]) {
      fn.mockReset();
    }
    activeContext.mockReset();
    activeContext.mockReturnValue(asRole("tenant_admin"));
    consoleListVouchers.mockResolvedValue({
      status: 200,
      data: { items: [voucher()], next_cursor: null },
    });
    localStorage.clear();
    sessionStorage.clear();
  });

  test.each(["store_manager", "store_staff", "cashier", "auditor"])(
    "%s sees no voucher surface and nothing is requested",
    async (role) => {
      activeContext.mockReturnValue(asRole(role));
      renderPage();
      expect(await screen.findByText("No assigned access")).toBeDefined();
      expect(consoleListVouchers).not.toHaveBeenCalled();
    },
  );

  test("no active tenant: a scope prompt, no request", () => {
    activeContext.mockReturnValue({ context: { active_tenant: null, active_role_code: null } });
    renderPage();
    expect(screen.getByText("Select a tenant to manage its vouchers.")).toBeDefined();
    expect(consoleListVouchers).not.toHaveBeenCalled();
  });

  test("the list shows value, status and stores, and never a code", async () => {
    renderPage();
    const row = (await screen.findByText("50.00 EGP")).closest("tr") as HTMLElement;
    expect(within(row).getByText("Active")).toBeDefined();
    expect(within(row).getByText("Maadi")).toBeDefined();
    expect(within(row).getByText("Never")).toBeDefined();
    expect(document.body.textContent).not.toMatch(
      /[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/,
    );
  });

  test("a status filter re-queries with that filter", async () => {
    renderPage();
    await screen.findByText("50.00 EGP");
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "expired" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(consoleListVouchers).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "expired" }),
      ),
    );
  });

  test("a 403 list shows the forbidden banner with the request id, not the server words", async () => {
    consoleListVouchers.mockResolvedValue({
      status: 403,
      error: { error: { code: "forbidden", message: "secret words", request_id: "req-403" } },
    });
    renderPage();
    expect(
      await screen.findByText("You do not have access to vouchers in this tenant."),
    ).toBeDefined();
    expect(screen.getByText(/req-403/)).toBeDefined();
    expect(screen.queryByText(/secret words/)).toBeNull();
  });
});

describe("issue: codes shown once", () => {
  beforeEach(() => {
    for (const fn of [consoleListVouchers, consoleIssueVouchers]) fn.mockReset();
    activeContext.mockReturnValue(asRole("owner"));
    consoleListVouchers.mockResolvedValue({ status: 200, data: { items: [], next_cursor: null } });
    localStorage.clear();
    sessionStorage.clear();
  });

  test("an invalid draft is refused locally; nothing is sent", async () => {
    renderPage();
    const drawer = await openIssueAndFill("");
    submit(drawer);
    expect(await within(drawer).findByText("Enter the voucher value.")).toBeDefined();
    expect(consoleIssueVouchers).not.toHaveBeenCalled();
  });

  test("201: the codes show in the drawer, in no storage and no cache; closing drops them", async () => {
    consoleIssueVouchers.mockResolvedValue(issued());
    renderPage();
    submit(await openIssueAndFill());
    const codes = await screen.findByRole("dialog", { name: "Issued voucher codes" });
    expect(within(codes).getByText(CODE)).toBeDefined();
    expect(consoleIssueVouchers).toHaveBeenCalledWith(
      { count: 1, amount_minor: 5000, expires_at: null, applies_to_all_stores: true, note: null },
      expect.stringMatching(/^[\x21-\x7E]{16,128}$/),
    );

    // Escape does not dismiss the codes: only the explicit "saved" button does.
    fireEvent.keyDown(codes, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Issued voucher codes" })).toBeDefined();

    const stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(stored).not.toContain(CODE);
    expect(cacheHolds(CODE)).toBe(false);

    fireEvent.click(within(codes).getByRole("button", { name: "I saved the codes, close" }));
    await waitFor(() => expect(screen.queryByText(CODE)).toBeNull());
    // The list refreshes so the new batch is visible (without its codes).
    await waitFor(() => expect(consoleListVouchers.mock.calls.length).toBeGreaterThan(1));
    expect(document.body.textContent).not.toContain(CODE);
  });

  test("each attempt sends a NEW key; a refusal never retries", async () => {
    consoleIssueVouchers.mockResolvedValueOnce({
      status: 400,
      error: { error: { code: "validation_failure", message: "x", request_id: "req-400" } },
    });
    consoleIssueVouchers.mockResolvedValueOnce(issued());
    renderPage();
    const drawer = await openIssueAndFill();
    submit(drawer);
    expect(
      await within(drawer).findByText(
        "Check the voucher details and try again. No voucher was issued.",
      ),
    ).toBeDefined();
    expect(consoleIssueVouchers).toHaveBeenCalledTimes(1);
    submit(drawer);
    await screen.findByRole("dialog", { name: "Issued voucher codes" });
    const [first, second] = consoleIssueVouchers.mock.calls.map((c) => c[1]);
    expect(first).not.toBe(second);
  });

  test.each([
    ["a 500", () => consoleIssueVouchers.mockResolvedValue({ status: 500 })],
    [
      "a key conflict",
      () =>
        consoleIssueVouchers.mockResolvedValue({
          status: 409,
          error: { error: { code: "idempotency_key_conflict", message: "x", request_id: "r" } },
        }),
    ],
    ["a network failure", () => consoleIssueVouchers.mockRejectedValue(new TypeError("fetch"))],
  ])("%s is uncertain: no second issue is offered, the list is", async (_label, arrange) => {
    arrange();
    renderPage();
    submit(await openIssueAndFill());
    expect(await screen.findByText(/The issue result is not confirmed/)).toBeDefined();
    const drawer = screen.getByRole("dialog", { name: "Issue vouchers" });
    expect(within(drawer).queryByRole("button", { name: "Issue the vouchers" })).toBeNull();
    expect(consoleIssueVouchers).toHaveBeenCalledTimes(1);
    fireEvent.click(within(drawer).getByRole("button", { name: "Open the voucher list" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("issue: scope and loss guards", () => {
  beforeEach(() => {
    for (const fn of [consoleListVouchers, consoleIssueVouchers]) fn.mockReset();
    consoleListVouchers.mockResolvedValue({ status: 200, data: { items: [], next_cursor: null } });
  });

  test("a store-specific membership starts on selected stores; all stores is off", async () => {
    activeContext.mockReturnValue({
      context: {
        ...asRole("tenant_admin").context,
        memberships: [
          { tenant_id: "t1", store_access_kind: "specific", accessible_store_ids: ["s1"] },
        ],
      },
    });
    renderPage();
    const drawer = await openIssueAndFill();
    const all = within(drawer).getByRole("radio", { name: /All stores/ }) as HTMLInputElement;
    const subset = within(drawer).getByRole("radio", {
      name: "Selected stores only",
    }) as HTMLInputElement;
    expect(all.disabled).toBe(true);
    expect(subset.checked).toBe(true);
    submit(drawer);
    expect(await within(drawer).findByText("Choose at least one store.")).toBeDefined();
    expect(consoleIssueVouchers).not.toHaveBeenCalled();
    fireEvent.click(within(drawer).getByRole("checkbox", { name: "Maadi" }));
    consoleIssueVouchers.mockResolvedValue(issued());
    submit(drawer);
    await screen.findByRole("dialog", { name: "Issued voucher codes" });
    expect(consoleIssueVouchers.mock.calls[0][0]).toMatchObject({
      applies_to_all_stores: false,
      eligible_store_ids: ["s1"],
    });
  });

  test("an uncertain issue names the lost attempt so its vouchers can be found", async () => {
    activeContext.mockReturnValue(asRole("owner"));
    consoleIssueVouchers.mockResolvedValue({ status: 502 });
    renderPage();
    submit(await openIssueAndFill("75"));
    expect(
      await screen.findByText(/The unconfirmed attempt: 1 voucher of 75.00 EGP, at /),
    ).toBeDefined();
  });

  test("leaving the page while the codes are on screen asks first", async () => {
    activeContext.mockReturnValue(asRole("owner"));
    consoleIssueVouchers.mockResolvedValue(issued());
    renderPage();
    submit(await openIssueAndFill());
    const codes = await screen.findByRole("dialog", { name: "Issued voucher codes" });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(within(codes).getByRole("button", { name: "I saved the codes, close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});

describe("detail and cancel", () => {
  beforeEach(() => {
    for (const fn of [consoleListVouchers, consoleGetVoucher, consoleCancelVoucher]) fn.mockReset();
    activeContext.mockReturnValue(asRole("tenant_admin"));
    consoleListVouchers.mockResolvedValue({
      status: 200,
      data: { items: [voucher()], next_cursor: null },
    });
    consoleGetVoucher.mockResolvedValue({ status: 200, data: voucher() });
  });

  async function openDetail(): Promise<HTMLElement> {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Open the 50.00 EGP voucher/ }));
    const drawer = await screen.findByRole("dialog", { name: "Voucher details" });
    await within(drawer).findByText("A voucher code is never shown after it is issued.");
    return drawer;
  }

  test("cancel asks first, then sends one keyed request and refreshes", async () => {
    consoleCancelVoucher.mockResolvedValue({
      status: 200,
      data: {
        voucher_id: voucher().voucher_id,
        status: "cancelled",
        cancelled_at: "2026-11-11T11:00:00Z",
        already_cancelled: false,
      },
    });
    const drawer = await openDetail();
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel voucher" }));
    expect(consoleCancelVoucher).not.toHaveBeenCalled();
    fireEvent.click(within(drawer).getByRole("button", { name: "Confirm cancelling the voucher" }));
    expect(await within(drawer).findByText("The voucher was cancelled.")).toBeDefined();
    expect(consoleCancelVoucher).toHaveBeenCalledWith(
      voucher().voucher_id,
      expect.stringMatching(/^[\x21-\x7E]{16,128}$/),
    );
    await waitFor(() => expect(consoleGetVoucher.mock.calls.length).toBeGreaterThan(1));
  });

  test("a 5xx keeps the key: confirming again replays with the same key", async () => {
    consoleCancelVoucher.mockResolvedValueOnce({ status: 503 });
    consoleCancelVoucher.mockResolvedValueOnce({
      status: 200,
      data: { voucher_id: "v", status: "cancelled", cancelled_at: "x", already_cancelled: true },
    });
    const drawer = await openDetail();
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel voucher" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Confirm cancelling the voucher" }));
    expect(
      await within(drawer).findByText("The voucher could not be cancelled. Try again."),
    ).toBeDefined();
    fireEvent.click(within(drawer).getByRole("button", { name: "Confirm cancelling the voucher" }));
    expect(await within(drawer).findByText("The voucher was already cancelled.")).toBeDefined();
    const [first, second] = consoleCancelVoucher.mock.calls.map((c) => c[1]);
    expect(second).toBe(first);
  });

  test("a redeemed voucher's 409 is explained", async () => {
    consoleCancelVoucher.mockResolvedValue({
      status: 409,
      error: { error: { code: "voucher_already_redeemed", message: "x", request_id: "req-409" } },
    });
    const drawer = await openDetail();
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel voucher" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Confirm cancelling the voucher" }));
    expect(
      await within(drawer).findByText("This voucher was redeemed, so it cannot be cancelled."),
    ).toBeDefined();
  });

  test("a redeemed voucher offers no cancel and shows its redemption", async () => {
    consoleGetVoucher.mockResolvedValue({
      status: 200,
      data: voucher({
        status: "redeemed",
        redemption: {
          redeemed_at: "2026-11-11T12:00:00Z",
          applied_amount_minor: 3000,
          forfeited_amount_minor: 2000,
        },
      }),
    });
    const drawer = await openDetail();
    expect(within(drawer).queryByRole("button", { name: "Cancel voucher" })).toBeNull();
    expect(within(drawer).getByText("30.00 EGP")).toBeDefined();
    expect(within(drawer).getByText("20.00 EGP")).toBeDefined();
  });

  test("a 404 detail is non-disclosing", async () => {
    consoleGetVoucher.mockResolvedValue({
      status: 404,
      error: { error: { code: "voucher_not_found", message: "x", request_id: "req-404" } },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Open the 50.00 EGP voucher/ }));
    expect(
      await screen.findByText("This voucher does not exist or is outside your access."),
    ).toBeDefined();
  });
});
