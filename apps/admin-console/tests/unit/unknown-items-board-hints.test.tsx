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
import { t } from "@/i18n/translate";
import { barcodeBars } from "@/unknown-items/UnknownItemBarcodeGlyph";
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
const SKU = { ...ITEM, id: "u2", identifier_type: "sku", identifier_value: "SKU-778" };

async function openDrawer(item: typeof ITEM): Promise<HTMLElement> {
  listUnknownItems.mockResolvedValue({ status: 200, data: { items: [item], next_cursor: null } });
  inspectUnknownItem.mockResolvedValue({ status: 200, data: item });
  renderList();
  fireEvent.click(
    await screen.findByRole("button", {
      name: t("table.selection.openRow", { value: item.identifier_value }),
    }),
  );
  const drawer = await screen.findByRole("dialog", { name: t("unknownItems.drawer.title") });
  await waitFor(() => expect(drawer.querySelector(".badge")).not.toBeNull());
  return drawer;
}

/** The text of the element(s) a control's aria-describedby points at. */
function description(el: HTMLElement): string {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
}

/**
 * RT-1117 (v9 boards `Unknown-items`, `Unknown-items-states`): each drawer
 * action shows its one-line description, wired with aria-describedby so the
 * button's accessible name stays its label; a barcode identifier gets a
 * decorative mark in the list.
 */
describe("Unknown items drawer action descriptions and barcode mark", () => {
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

  test("a pending item's three actions keep their exact names and show their descriptions", async () => {
    const drawer = await openDrawer(ITEM);
    const cases = [
      ["Create product", "A new product from this identifier."],
      ["Link to a product", "The identifier belongs to a product already in the catalog."],
      ["Dismiss", "Takes the item out of the review queue. It can be reopened."],
    ] as const;
    for (const [name, hint] of cases) {
      const button = within(drawer).getByRole("button", { name });
      expect(button.textContent).toBe(name);
      expect(description(button)).toBe(hint);
      // The description is visible text under the button, not inside it.
      expect(within(drawer).getByText(hint).tagName).toBe("P");
      expect(button.contains(within(drawer).getByText(hint))).toBe(false);
    }
  });

  test("Arabic: the descriptions read from the Arabic catalog", async () => {
    setLocale("ar");
    const drawer = await openDrawer(ITEM);
    const cases = [
      ["إنشاء صنف", "صنف جديد من هذا المعرّف."],
      ["ربط بصنف", "المعرّف يعود إلى صنف موجود في الكتالوج."],
      ["استبعاد", "يُخرج الصنف من قائمة المراجعة، ويمكن إعادة فتحه."],
    ] as const;
    for (const [name, hint] of cases) {
      expect(description(within(drawer).getByRole("button", { name }))).toBe(hint);
    }
  });

  test("a dismissed item offers only Reopen, with its description", async () => {
    const drawer = await openDrawer({ ...ITEM, resolution_status: "dismissed" });
    const reopen = within(drawer).getByRole("button", { name: "Reopen" });
    expect(description(reopen)).toBe("Puts the item back in the review queue to be handled again.");
    for (const name of ["Create product", "Link to a product", "Dismiss"]) {
      expect(within(drawer).queryByRole("button", { name })).toBeNull();
    }
  });

  test("Arabic: Reopen's description", async () => {
    setLocale("ar");
    const drawer = await openDrawer({ ...ITEM, resolution_status: "dismissed" });
    expect(description(within(drawer).getByRole("button", { name: "إعادة فتح" }))).toBe(
      "يعيد الصنف إلى قائمة المراجعة ليُعالج من جديد.",
    );
  });

  test("choosing an action still opens its step", async () => {
    const drawer = await openDrawer(ITEM);
    fireEvent.click(within(drawer).getByRole("button", { name: "Dismiss" }));
    expect(within(drawer).queryByText("A new product from this identifier.")).toBeNull();
  });

  test("a barcode row gets a decorative mark; the cell's name stays the value", async () => {
    listUnknownItems.mockResolvedValue({
      status: 200,
      data: { items: [ITEM, SKU], next_cursor: null },
    });
    renderList();
    const barcodeCell = await screen.findByRole("cell", { name: "5012345678900" });
    const mark = barcodeCell.querySelector(".unknown-item-barcode") as HTMLElement;
    expect(mark).not.toBeNull();
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.textContent).toBe("");
    expect(mark.querySelectorAll(".unknown-item-barcode__bar")).toHaveLength(12);
    expect(mark.querySelector("svg")).toBeNull();
    const skuCell = screen.getByRole("cell", { name: "SKU-778" });
    expect(skuCell.querySelector(".unknown-item-barcode")).toBeNull();
  });

  test("the bars come from the digits, every third bar full height", () => {
    const bars = barcodeBars("5012345678900");
    expect(bars).toHaveLength(12);
    expect(bars.filter((_, i) => i % 3 === 0).every((h) => h === 16)).toBe(true);
    expect(bars.every((h) => h > 0 && h <= 16)).toBe(true);
    expect(barcodeBars("5012345678900")).toEqual(bars);
    expect(barcodeBars("no digits")).toEqual([]);
  });
});
