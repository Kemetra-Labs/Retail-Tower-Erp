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

const scope = vi.fn();
vi.mock("@/unknown-items/useUnknownItemScope", () => ({
  useUnknownItemScope: () => scope(),
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
 * RT-1018 (v4.0, D-V9): the review list's Ink band and the inspect drawer's Ink
 * header. Markup only: the band names the tenant and claims no count (the
 * contract serves none for the whole set); the actions follow item state.
 */
describe("Unknown items v4.0 band and drawer header", () => {
  beforeEach(() => {
    listUnknownItems.mockReset();
    inspectUnknownItem.mockReset();
    scope.mockReturnValue({
      activeTenantId: "t1",
      activeTenantName: "Northstar Retail",
      activeStoreId: null,
    });
    setLocale("en");
  });

  test("the band holds the group, the one h1 and a subtitle naming the tenant, and no facts", async () => {
    listUnknownItems.mockResolvedValue({ status: 200, data: { items: [ITEM], next_cursor: "c2" } });
    renderList();
    const container = document.body;
    await screen.findByText("5012345678900");
    const band = container.querySelector(".list-band") as HTMLElement;
    expect(band).not.toBeNull();
    expect(within(band).getByRole("heading", { level: 1 }).textContent).toBe("Unknown items");
    expect(band.textContent).toContain("Operations");
    expect(band.textContent).toContain("POS item references awaiting review in Northstar Retail.");
    // A cursor-paged queue serves no whole-set count: nothing is claimed.
    expect(band.querySelector(".list-band__facts")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  test("the band subtitle falls back to the tenant-neutral line without a tenant name", async () => {
    scope.mockReturnValue({ activeTenantId: "t1", activeTenantName: null, activeStoreId: null });
    listUnknownItems.mockResolvedValue({ status: 200, data: { items: [], next_cursor: null } });
    renderList();
    const container = document.body;
    await screen.findByText(/no unknown items to review/i);
    expect((container.querySelector(".list-band") as HTMLElement).textContent).toContain(
      "POS item references awaiting review in this tenant.",
    );
  });

  test("Arabic: the band names the tenant in Arabic copy", async () => {
    setLocale("ar");
    listUnknownItems.mockResolvedValue({ status: 200, data: { items: [ITEM], next_cursor: null } });
    renderList();
    const container = document.body;
    await screen.findByText("5012345678900");
    expect((container.querySelector(".list-band") as HTMLElement).textContent).toContain(
      "مراجع أصناف من POS بانتظار المراجعة في Northstar Retail.",
    );
  });

  test("the band, then the filters, then one results panel holding the bulk bar and the table", async () => {
    listUnknownItems.mockResolvedValue({ status: 200, data: { items: [ITEM], next_cursor: null } });
    renderList();
    await screen.findByText("5012345678900");
    const band = document.querySelector(".list-band") as HTMLElement;
    const filters = screen.getByRole("form", { name: "Queue filters" });
    const panel = document.querySelector(".unknown-results") as HTMLElement;
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(band, filters)).toBe(true);
    expect(follows(filters, panel)).toBe(true);
    expect(panel.querySelector("table")).not.toBeNull();
    expect(panel.querySelector(".unknown-item-bulk")).not.toBeNull();
    expect(panel.querySelector(".list-band")).toBeNull();
    // The panel's wash is only for an active selection: the bar starts plain.
    expect(panel.querySelector('.data-table__selection[data-active="true"]')).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select 5012345678900" }));
    await waitFor(() =>
      expect(panel.querySelector('.data-table__selection[data-active="true"]')).not.toBeNull(),
    );
  });

  test("an empty queue's state sits inside the results panel", async () => {
    listUnknownItems.mockResolvedValue({ status: 200, data: { items: [], next_cursor: null } });
    renderList();
    const empty = await screen.findByText(/no unknown items to review/i);
    expect((document.querySelector(".unknown-results") as HTMLElement).contains(empty)).toBe(true);
  });

  test("a load failure stays a banner and the results panel is not drawn", async () => {
    listUnknownItems.mockResolvedValue({ status: 503, data: undefined, error: {} });
    renderList();
    const container = document.body;
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(container.querySelector(".unknown-results")).toBeNull();
    expect(container.querySelector(".list-band")).not.toBeNull();
  });

  test("the drawer opens with the tenant scope line and a status pill; pending offers the three actions", async () => {
    listUnknownItems.mockResolvedValue({ status: 200, data: { items: [ITEM], next_cursor: null } });
    inspectUnknownItem.mockResolvedValue({ status: 200, data: ITEM });
    renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Open 5012345678900" }));
    const drawer = await screen.findByRole("dialog", { name: "Unknown item" });
    expect(drawer.querySelector(".drawer__scope")?.textContent).toBe(
      "Review queue · Northstar Retail",
    );
    await waitFor(() => expect(drawer.querySelector(".badge--pending")).not.toBeNull());
    expect(drawer.querySelector(".badge")?.textContent).toBe("Pending");
    for (const name of ["Create product", "Link to a product", "Dismiss"]) {
      expect(within(drawer).getByRole("button", { name })).toBeDefined();
    }
  });

  test.each([
    ["resolved", "Resolved", "badge--success"],
    ["dismissed", "Dismissed", null],
  ])("the drawer's %s status pill reads %s with its colour role", async (status, label, role) => {
    listUnknownItems.mockResolvedValue({ status: 200, data: { items: [ITEM], next_cursor: null } });
    inspectUnknownItem.mockResolvedValue({
      status: 200,
      data: { ...ITEM, resolution_status: status },
    });
    renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Open 5012345678900" }));
    const drawer = await screen.findByRole("dialog", { name: "Unknown item" });
    await waitFor(() => expect(drawer.querySelector(".badge")?.textContent).toBe(label));
    const badge = drawer.querySelector(".badge") as HTMLElement;
    expect(badge.className).toBe(role ? `badge ${role}` : "badge");
  });
});
