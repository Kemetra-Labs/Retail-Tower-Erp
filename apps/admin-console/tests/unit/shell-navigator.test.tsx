import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
import { AppShell } from "@/shell/AppShell";
import { foldForSearch } from "@/shell/Navigator";
import { DirtyGuardProvider } from "@/shell/dirty-guard";

/**
 * RT-969 AC 3: the Ctrl K navigator opens with Ctrl+K and with its visible
 * button, filters the role's destinations and the stores in scope, works by
 * keyboard only (combobox + listbox, aria-activedescendant) and returns focus
 * on close. Choosing a store runs the same guarded scope change as the
 * switcher (RT-268), never a silent one.
 */

const switchStore = vi.fn().mockResolvedValue(undefined);
const clearStore = vi.fn().mockResolvedValue(undefined);

function contextFor(role: string, extra: Record<string, unknown> = {}) {
  return {
    switchStore,
    clearStore,
    context: {
      user: { id: "u1", email: "amal@northstar.eg", display_name: "Amal Saleh" },
      active_tenant: { id: "t1", name: "Northstar Retail" },
      active_store: null,
      active_role_code: role,
      memberships: [{ tenant_id: "t1", tenant_name: "Northstar Retail", store_access_kind: "all" }],
      ...extra,
    },
  };
}

const stores = {
  status: 200,
  data: [
    { id: "s1", code: "CFC", name: "Cairo Festival City" },
    { id: "s2", code: "NCM", name: "New Cairo Mall" },
  ],
};

function Where(): React.JSX.Element {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function DirtyForm(): React.JSX.Element {
  return (
    <form>
      <label>
        Tenant name
        <input name="name" />
      </label>
    </form>
  );
}

function renderShell(role = "tenant_admin", extra: Record<string, unknown> = {}): void {
  activeContext.mockReturnValue(contextFor(role, extra));
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/"]}>
        <DirtyGuardProvider>
          <AppShell onSignOut={vi.fn()}>
            <Routes>
              <Route path="*" element={<DirtyForm />} />
            </Routes>
            <Where />
          </AppShell>
        </DirtyGuardProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const trigger = () => screen.getByRole("button", { name: "Go to a page or store Ctrl K" });
const dialog = () => screen.getByRole("dialog", { name: "Go to" });
const combobox = () => screen.getByRole("combobox", { name: "Page or store name" });
const optionNames = () =>
  within(screen.getByRole("listbox"))
    .queryAllByRole("option")
    .map((o) => o.textContent ?? "");

function pressCtrlK(): void {
  act(() => {
    fireEvent.keyDown(document, { key: "k", code: "KeyK", ctrlKey: true });
  });
}

function type(text: string): void {
  fireEvent.change(combobox(), { target: { value: text } });
}

beforeEach(() => {
  listStores.mockReset();
  listStores.mockResolvedValue(stores);
  activeContext.mockReset();
  switchStore.mockClear();
  clearStore.mockClear();
});

afterEach(cleanup);

describe("opening and closing", () => {
  test("the top-bar button opens it, names its shortcut and focuses the combobox", () => {
    renderShell();
    expect(trigger().getAttribute("aria-keyshortcuts")).toContain("Control+K");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger());
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(combobox());
  });

  test("Ctrl+K opens it from anywhere; Escape closes it and returns focus", () => {
    renderShell();
    const field = screen.getByLabelText("Tenant name");
    field.focus();
    pressCtrlK();
    expect(document.activeElement).toBe(combobox());
    fireEvent.keyDown(combobox(), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Go to" })).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  test("⌘K opens it too", () => {
    renderShell();
    act(() => {
      fireEvent.keyDown(document, { key: "k", code: "KeyK", metaKey: true });
    });
    expect(dialog()).toBeDefined();
  });

  test("Ctrl+K does nothing while another modal owns the keyboard", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    pressCtrlK();
    expect(screen.queryByRole("dialog", { name: "Go to" })).toBeNull();
  });

  test("a keydown without a key (browser autofill) neither throws nor opens it", () => {
    renderShell();
    const event = new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true });
    Object.defineProperty(event, "key", { value: undefined });
    expect(() => document.dispatchEvent(event)).not.toThrow();
    expect(screen.queryByRole("dialog", { name: "Go to" })).toBeNull();
  });

  test("Tab stays on the combobox (the dialog's only stop)", () => {
    renderShell();
    fireEvent.click(trigger());
    const tab = fireEvent.keyDown(combobox(), { key: "Tab" });
    expect(tab).toBe(false); // default prevented
  });
});

describe("what it offers", () => {
  test("lists the role's destinations, then All stores and the stores in scope", async () => {
    renderShell("tenant_admin");
    fireEvent.click(trigger());
    await screen.findByRole("option", { name: /New Cairo Mall/ });
    const names = optionNames();
    expect(names.slice(0, 3)).toEqual(["Overview", "Sales", "Items"]);
    expect(names).toContain("Connection & sync");
    expect(names.slice(-3)).toEqual([
      "All stores(current)",
      "Cairo Festival City",
      "New Cairo Mall",
    ]);
    const groups = within(screen.getByRole("listbox")).getAllByRole("group");
    expect(groups).toHaveLength(2);
    expect(within(groups[0] as HTMLElement).getByText("Pages")).toBeDefined();
    expect(within(groups[1] as HTMLElement).getByText("Stores")).toBeDefined();
  });

  test("never offers a destination the role cannot open", () => {
    renderShell("cashier");
    fireEvent.click(trigger());
    type("conn");
    expect(optionNames()).toEqual([]);
  });

  test("inside a support session it offers the platform link and no store", () => {
    renderShell("owner", {
      support_session: {
        id: "11111111-1111-4111-8111-111111111111",
        tenant_id: "t1",
        purpose: "incident",
        ticket_ref: "SUP-1",
        status: "active",
        expires_at: new Date(Date.now() + 40 * 60_000).toISOString(),
        renewal_cap_at: new Date(Date.now() + 8 * 3_600_000).toISOString(),
      },
    });
    fireEvent.click(trigger());
    expect(optionNames()).toEqual(["Organizations"]);
    expect(listStores).not.toHaveBeenCalled();
  });

  test("filters pages and stores as the query changes, and says when nothing matches", async () => {
    renderShell();
    fireEvent.click(trigger());
    await screen.findByRole("option", { name: /New Cairo Mall/ });
    type("cairo");
    expect(optionNames()).toEqual(["Cairo Festival City", "New Cairo Mall"]);
    type("sales");
    expect(optionNames()).toEqual(["Sales", "Sales needing repair"]);
    type("zzz");
    expect(optionNames()).toEqual([]);
    expect(screen.getByText("No page or store matches “zzz”.")).toBeDefined();
    expect(combobox().getAttribute("aria-expanded")).toBe("false");
  });

  test("a failed store list says so and offers a retry, never 'no stores'", async () => {
    listStores.mockResolvedValue({ status: 500, error: { error: { code: "internal" } } });
    renderShell();
    fireEvent.click(trigger());
    const retry = await screen.findByRole("button", { name: "Try again" });
    // Announced once, in the dialog's polite status region.
    const status = within(dialog()).getByRole("status");
    expect(status.textContent).toBe("Couldn't load stores.");
    expect(screen.getAllByText("Couldn't load stores.")).toHaveLength(1);
    // Pages still work, and All stores stays a valid choice.
    expect(optionNames()).toContain("Overview");
    expect(optionNames()).toContain("All stores(current)");
    // The retry is the dialog's second Tab stop; Tab cycles input <-> retry.
    fireEvent.keyDown(combobox(), { key: "Tab" });
    expect(document.activeElement).toBe(retry);
    fireEvent.keyDown(retry, { key: "Tab" });
    expect(document.activeElement).toBe(combobox());
    listStores.mockResolvedValue(stores);
    const calls = listStores.mock.calls.length;
    fireEvent.click(retry);
    await screen.findByRole("option", { name: /New Cairo Mall/ });
    expect(listStores.mock.calls.length).toBeGreaterThan(calls);
    expect(screen.queryByText("Couldn't load stores.")).toBeNull();
    // The retry went away with the failure; focus is back on the combobox.
    expect(document.activeElement).toBe(combobox());
  });

  test("folds case, Arabic marks and letter variants", () => {
    expect(foldForSearch("المَبيعات")).toBe(foldForSearch("المبيعات"));
    expect(foldForSearch("إقفالات")).toBe(foldForSearch("اقفالات"));
    expect(foldForSearch("Café")).toBe("cafe");
  });
});

describe("keyboard and choice", () => {
  test("arrows move the active option (aria-activedescendant) and wrap", () => {
    renderShell("cashier");
    fireEvent.click(trigger());
    const first = screen.getAllByRole("option")[0] as HTMLElement;
    expect(combobox().getAttribute("aria-activedescendant")).toBe(first.id);
    expect(first.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    const second = screen.getAllByRole("option")[1] as HTMLElement;
    expect(combobox().getAttribute("aria-activedescendant")).toBe(second.id);
    fireEvent.keyDown(combobox(), { key: "ArrowUp" });
    fireEvent.keyDown(combobox(), { key: "ArrowUp" });
    const options = screen.getAllByRole("option");
    expect(combobox().getAttribute("aria-activedescendant")).toBe(options.at(-1)?.id);
  });

  test("keys that confirm an IME composition do not move or choose", () => {
    renderShell();
    fireEvent.click(trigger());
    type("stores");
    const before = combobox().getAttribute("aria-activedescendant");
    fireEvent.keyDown(combobox(), { key: "ArrowDown", isComposing: true });
    fireEvent.keyDown(combobox(), { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(combobox(), { key: "Enter", isComposing: true });
    expect(combobox().getAttribute("aria-activedescendant")).toBe(before);
    expect(screen.getByTestId("where").textContent).toBe("/");
    expect(dialog()).toBeDefined();
  });

  test("Enter on a page navigates there and closes", () => {
    renderShell();
    fireEvent.click(trigger());
    type("stores");
    fireEvent.keyDown(combobox(), { key: "Enter" });
    expect(screen.getByTestId("where").textContent).toBe("/stores");
    expect(screen.queryByRole("dialog", { name: "Go to" })).toBeNull();
  });

  test("a click on an option chooses it", () => {
    renderShell();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("option", { name: "Audit" }));
    expect(screen.getByTestId("where").textContent).toBe("/audit");
  });

  test("choosing a store switches scope through the context mutator", async () => {
    renderShell();
    fireEvent.click(trigger());
    type("new cairo");
    await screen.findByRole("option", { name: /New Cairo Mall/ });
    fireEvent.keyDown(combobox(), { key: "Enter" });
    await waitFor(() => expect(switchStore).toHaveBeenCalledWith("s2"));
  });

  test("a store choice over unsaved work asks first (RT-268); Stay keeps the scope", async () => {
    renderShell();
    fireEvent.input(screen.getByLabelText("Tenant name"), { target: { value: "draft" } });
    fireEvent.click(trigger());
    type("new cairo");
    await screen.findByRole("option", { name: /New Cairo Mall/ });
    fireEvent.keyDown(combobox(), { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: "Stay on this page" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(switchStore).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Tenant name") as HTMLInputElement).value).toBe("draft");
  });

  test("choosing the current scope changes nothing", async () => {
    renderShell();
    fireEvent.click(trigger());
    type("all stores");
    fireEvent.keyDown(combobox(), { key: "Enter" });
    await act(async () => {});
    expect(clearStore).not.toHaveBeenCalled();
    expect(switchStore).not.toHaveBeenCalled();
  });
});
