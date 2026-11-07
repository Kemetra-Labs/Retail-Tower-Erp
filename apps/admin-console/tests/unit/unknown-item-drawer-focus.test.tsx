import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const listUnknownItems = vi.fn();
const inspectUnknownItem = vi.fn();
vi.mock("@/lib/unknown-items-queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/unknown-items-queries")>();
  return {
    ...actual,
    listUnknownItems: (...a: unknown[]) => listUnknownItems(...a),
    inspectUnknownItem: (...a: unknown[]) => inspectUnknownItem(...a),
  };
});

vi.mock("@/unknown-items/useUnknownItemScope", () => ({
  useUnknownItemScope: () => ({
    activeTenantId: "t1",
    activeTenantName: "Northstar Retail",
    activeStoreId: null,
  }),
}));

import { setLocale } from "@/i18n/locale";
import { renderList } from "./renderUnknownItemList";

const ITEM = {
  id: "u1",
  tenant_id: "t1",
  store_id: "s1",
  identifier_type: "barcode",
  identifier_value: "5012345678900",
  source_system: null,
  resolution_status: "pending",
  resolution_action: null,
  resolved_at: null,
  resolved_by: null,
  encountered_at: "2026-06-10T10:00:00Z",
};

/**
 * RT-1234: a step swaps in and the button that was clicked unmounts, which
 * dropped focus to <body>, outside the dialog. Focus must stay inside the
 * drawer after every step change, so Tab and Escape keep working.
 */
async function openDrawer(): Promise<HTMLElement> {
  renderList();
  fireEvent.click(await screen.findByRole("button", { name: "Open 5012345678900" }));
  const drawer = await screen.findByRole("dialog", { name: "Unknown item" });
  await within(drawer).findByRole("button", { name: "Create product" });
  return drawer;
}

describe("Unknown items drawer keeps keyboard focus inside after a step swaps in", () => {
  beforeEach(() => {
    listUnknownItems.mockReset();
    inspectUnknownItem.mockReset();
    listUnknownItems.mockResolvedValue({ status: 200, data: { items: [ITEM], next_cursor: null } });
    inspectUnknownItem.mockResolvedValue({ status: 200, data: ITEM });
    setLocale("en");
  });

  test("Create product: focus lands on the first field", async () => {
    const drawer = await openDrawer();
    const create = within(drawer).getByRole("button", { name: "Create product" });
    create.focus();
    fireEvent.click(create);
    const name = await within(drawer).findByLabelText(/Product name|Name/);
    await waitFor(() => expect(document.activeElement).toBe(name));
  });

  test("Dismiss: focus stays inside the drawer, on the confirm step", async () => {
    const drawer = await openDrawer();
    const dismiss = within(drawer).getByRole("button", { name: "Dismiss" });
    dismiss.focus();
    fireEvent.click(dismiss);
    await within(drawer).findByRole("region");
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(document.body);
    // The destructive confirm is never focused by the swap itself.
    expect(document.activeElement).not.toBe(
      within(drawer).getByRole("button", { name: /^Dismiss$/ }),
    );
  });

  test("Link: focus stays inside the drawer", async () => {
    const drawer = await openDrawer();
    const link = within(drawer).getByRole("button", { name: "Link to a product" });
    link.focus();
    fireEvent.click(link);
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(document.body);
  });

  test("Cancel back to the actions keeps focus inside the drawer", async () => {
    const drawer = await openDrawer();
    const dismiss = within(drawer).getByRole("button", { name: "Dismiss" });
    dismiss.focus();
    fireEvent.click(dismiss);
    const cancel = await within(drawer).findByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.click(cancel);
    await within(drawer).findByRole("button", { name: "Create product" });
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(document.body);
  });

  test("Escape from the step still closes the drawer", async () => {
    const drawer = await openDrawer();
    const dismiss = within(drawer).getByRole("button", { name: "Dismiss" });
    dismiss.focus();
    fireEvent.click(dismiss);
    await within(drawer).findByRole("region");
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unknown item" })).toBeNull());
  });
});
