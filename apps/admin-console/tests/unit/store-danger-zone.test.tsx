import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, test, vi } from "vitest";

const readStore = vi.fn();
const updateStore = vi.fn();
vi.mock("@/lib/rf2-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rf2-queries")>();
  return {
    ...actual,
    readStore: (...a: unknown[]) => readStore(...a),
    updateStore: (...a: unknown[]) => updateStore(...a),
  };
});
const previewStoreDeletion = vi.fn();
const consoleReauthenticate = vi.fn();
const consoleDeleteStore = vi.fn();
vi.mock("@/lib/store-deletion-queries", () => ({
  previewStoreDeletion: (...a: unknown[]) => previewStoreDeletion(...a),
  consoleReauthenticate: (...a: unknown[]) => consoleReauthenticate(...a),
  consoleDeleteStore: (...a: unknown[]) => consoleDeleteStore(...a),
}));
let context: Record<string, unknown> = {};
vi.mock("@/context/ActiveContextProvider", () => ({
  useActiveContextValue: () => ({ context }),
}));
// The other sections of the page read their own data; they are not under test here.
vi.mock("@/cash-policy/StorePolicySection", () => ({ StorePolicySection: () => null }));
vi.mock("@/force-actions/OpenShiftsLink", () => ({ OpenShiftsLink: () => null }));

import { setLocale } from "@/i18n/locale";
import { createQueryClient } from "@/lib/query";
import { StoreDetail } from "@/stores/StoreDetail";

/**
 * RT-1441 (U2) AC1 and AC4: the store «danger zone» on the detail page. Suspend is offered first;
 * «Delete store…» opens the dialog, and only then is the preview read. The owner sees it; a
 * tenant_admin, any other role and an owner inside a support session do not (the server stays
 * authoritative). After the delete the owner returns to the store list.
 */

const STORE = "0198a0c4-0000-7000-8000-000000000a01";

function ctx(role: string | undefined, supportSession: unknown = null): Record<string, unknown> {
  return {
    active_tenant: { id: "t1", name: "Northstar Retail" },
    active_role_code: role,
    support_session: supportSession,
  };
}

function storeBody(isActive = true) {
  return { status: 200, data: { id: STORE, code: "DXB", name: "Dubai Mall", is_active: isActive } };
}

function renderPage(): void {
  const qc = createQueryClient();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/stores/${STORE}`]}>
        <Routes>
          <Route path="/stores/:storeId" element={<StoreDetail />} />
          <Route path="/stores" element={<p>THE STORE LIST</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const deleteButton = () => screen.queryByRole("button", { name: "Delete store…" });

describe("StoreDangerZone", () => {
  beforeEach(() => {
    for (const fn of [
      readStore,
      updateStore,
      previewStoreDeletion,
      consoleReauthenticate,
      consoleDeleteStore,
    ]) {
      fn.mockReset();
    }
    setLocale("en");
  });

  test("the owner sees the zone, with suspend offered before delete, and nothing is read until the dialog opens", async () => {
    context = ctx("owner");
    readStore.mockResolvedValue(storeBody());
    renderPage();
    const zone = await screen.findByRole("region", { name: "Delete the store" });
    expect(zone.textContent).toContain(
      "Suspending the store instead of deleting it can be undone.",
    );
    const buttons = Array.from(zone.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(["Suspend store", "Delete store…"]);
    expect(previewStoreDeletion).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("Delete store… opens the dialog and reads the preview once, as the dialog mounts", async () => {
    context = ctx("owner");
    readStore.mockResolvedValue(storeBody());
    previewStoreDeletion.mockReturnValue(new Promise(() => undefined));
    renderPage();
    await screen.findByRole("region", { name: "Delete the store" });
    fireEvent.click(deleteButton() as HTMLElement);
    expect(await screen.findByRole("dialog", { name: "Delete the store" })).toBeTruthy();
    expect(previewStoreDeletion).toHaveBeenCalledTimes(1);
    expect(previewStoreDeletion).toHaveBeenCalledWith(STORE);
  });

  test("a suspended store says so instead of offering suspend, and delete stays", async () => {
    context = ctx("owner");
    readStore.mockResolvedValue(storeBody(false));
    renderPage();
    const zone = await screen.findByRole("region", { name: "Delete the store" });
    expect(zone.textContent).toContain("already suspended");
    expect(screen.queryByRole("button", { name: "Suspend store" })).toBeNull();
    expect(deleteButton()).not.toBeNull();
  });

  test("suspend asks first, naming the store, then sends is_active=false and the zone follows", async () => {
    context = ctx("owner");
    readStore.mockResolvedValue(storeBody());
    updateStore.mockResolvedValue({
      status: 200,
      data: { id: STORE, code: "DXB", name: "Dubai Mall", is_active: false },
    });
    renderPage();
    await screen.findByRole("region", { name: "Delete the store" });
    fireEvent.click(screen.getByRole("button", { name: "Suspend store" }));
    expect(document.querySelector(".surface__confirm-msg")?.textContent).toContain(
      "Suspend Dubai Mall?",
    );
    expect(updateStore).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Suspend store" })[0]);
    await waitFor(() => expect(updateStore).toHaveBeenCalledWith(STORE, { is_active: false }));
    expect(await screen.findByText(/already suspended/)).toBeTruthy();
  });

  test("a refused suspend (4xx) says nothing changed", async () => {
    context = ctx("owner");
    readStore.mockResolvedValue(storeBody());
    updateStore.mockResolvedValue({ status: 403 });
    renderPage();
    await screen.findByRole("region", { name: "Delete the store" });
    fireEvent.click(screen.getByRole("button", { name: "Suspend store" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Suspend store" })[0]);
    expect(await screen.findByText("Could not suspend the store. Nothing changed.")).toBeTruthy();
  });

  test.each([
    ["a 5xx", { status: 500 }],
    ["a 408", { status: 408 }],
    ["no answer", new Error("network")],
  ])("%s on suspend does not claim nothing changed", async (_name, answer) => {
    context = ctx("owner");
    readStore.mockResolvedValue(storeBody());
    if (answer instanceof Error) updateStore.mockRejectedValue(answer);
    else updateStore.mockResolvedValue(answer);
    renderPage();
    await screen.findByRole("region", { name: "Delete the store" });
    fireEvent.click(screen.getByRole("button", { name: "Suspend store" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Suspend store" })[0]);
    expect(await screen.findByText(/could not confirm whether the store was suspended/)).toBeTruthy();
    expect(screen.queryByText(/Nothing changed/)).toBeNull();
  });

  test.each([["tenant_admin"], ["store_manager"], ["cashier"], [undefined]])(
    "role %s sees no delete and no suspend here",
    async (role) => {
      context = ctx(role);
      readStore.mockResolvedValue(storeBody());
      renderPage();
      await screen.findByRole("heading", { name: "Dubai Mall", level: 1 });
      expect(screen.queryByRole("region", { name: "Delete the store" })).toBeNull();
      expect(deleteButton()).toBeNull();
      expect(screen.queryByRole("button", { name: /delete|حذف/i })).toBeNull();
    },
  );

  test("an owner inside a support session sees no delete (read-only)", async () => {
    context = ctx("owner", { id: "ss-1" });
    readStore.mockResolvedValue(storeBody());
    renderPage();
    await screen.findByRole("heading", { name: "Dubai Mall", level: 1 });
    expect(deleteButton()).toBeNull();
    expect(previewStoreDeletion).not.toHaveBeenCalled();
  });

  test("after the delete, Back to stores returns to the store list and the store is not read again", async () => {
    context = ctx("owner");
    readStore.mockResolvedValue(storeBody());
    previewStoreDeletion.mockResolvedValue({
      status: 200,
      data: {
        store: { storeId: STORE, code: "DXB", name: "Dubai Mall", isActive: true },
        openShifts: [],
        devices: [],
        openCountSessions: [],
        warehouseMappings: [],
        singleStoreMembers: [],
        offersRebuiltCount: 0,
        effects: { willChange: ["store_hidden_from_lists"], willNotChange: [] },
        blockers: [],
        canDelete: true,
        reversible: false,
        reversibleAlternative: "suspend_store",
        caveats: [],
        previewFingerprint: "fp-1",
        evaluatedAt: "2026-11-17T10:00:00Z",
      },
    });
    consoleReauthenticate.mockResolvedValue({ status: 200, data: { reauthToken: "g1" } });
    consoleDeleteStore.mockResolvedValue({
      status: 200,
      data: { storeId: STORE },
      replayed: false,
    });
    renderPage();
    await screen.findByRole("region", { name: "Delete the store" });
    fireEvent.click(deleteButton() as HTMLElement);
    fireEvent.change(await screen.findByLabelText(/Reason for deleting/), {
      target: { value: "Closed for good" },
    });
    fireEvent.change(screen.getByLabelText("Your current password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm deleting the store" }));
    await screen.findByText("The store is deleted.");
    expect(screen.queryByText("THE STORE LIST")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to stores" }));
    expect(await screen.findByText("THE STORE LIST")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Nothing read the deleted store again (a refetch would be a 404 behind the list).
    expect(readStore).toHaveBeenCalledTimes(1);
  });
});
