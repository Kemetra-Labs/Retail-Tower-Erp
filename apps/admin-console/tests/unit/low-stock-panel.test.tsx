import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const consoleListLowStock = vi.fn();
vi.mock("@/lib/low-stock-queries", () => ({
  consoleListLowStock: (...a: unknown[]) => consoleListLowStock(...a),
  LOW_STOCK_LIMIT: 10,
}));

import { createQueryClient } from "@/lib/query";
import { LowStockPanel } from "@/overview/LowStockPanel";

const S = "0190f000-0000-7000-8000-0000000000a1";
const session: { tenantId: string; activeStoreId: string | null; role: string } = {
  tenantId: "t1",
  activeStoreId: null,
  role: "owner",
};

function item(n: number, band: "critical" | "low", ratio: string) {
  return {
    storeId: S,
    storeName: "Cairo",
    storeStatus: "active",
    productId: `p${n}`,
    productName: `Product ${n}`,
    stockingUnit: "box",
    sellableOnHand: "2.0000",
    reorderLevel: "10.0000",
    criticalLevel: "3.0000",
    thresholdSource: "tenant",
    band,
    levelRatio: ratio,
  };
}
function list(over: Record<string, unknown> = {}) {
  return {
    asOf: "2026-11-02T10:00:00Z",
    completeness: "received_only",
    storeId: null,
    limit: 10,
    evaluatedCount: 5,
    belowReorderCount: 2,
    criticalCount: 1,
    unknownOnHandCount: 0,
    negativeOnHandCount: 0,
    truncated: false,
    items: [item(2, "critical", "0.2000"), item(1, "low", "0.1000")],
    ...over,
  };
}
const ok = (data: unknown) => Promise.resolve({ status: 200, data });
const fail = (status: number) =>
  Promise.resolve({ status, error: { error: { code: "x", request_id: "req-9" } } });

function renderPanel(s = session) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <LowStockPanel session={s} />
    </QueryClientProvider>,
  );
}

beforeEach(() => consoleListLowStock.mockReset());

describe("RT-1073 low-stock panel", () => {
  test("keeps server order and colours only critical", async () => {
    consoleListLowStock.mockImplementation(() => ok(list()));
    const { container } = renderPanel();
    await screen.findByText("Product 2");
    const names = [...container.querySelectorAll(".low-stock__product")].map((e) => e.textContent);
    expect(names).toEqual(["Product 2", "Product 1"]); // not re-sorted by ratio
    const items = container.querySelectorAll(".low-stock__item");
    expect(items[0].className).toContain("--critical");
    expect(items[1].className).not.toContain("--critical");
    expect(items[0].textContent).toContain("2 box on hand, reorder level 10 box (critical)");
    expect((container.querySelector(".low-stock__fill") as HTMLElement).style.width).toBe("20%");
    expect(container.querySelector(".low-stock__bar")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("shows count hints and truncation", async () => {
    consoleListLowStock.mockImplementation(() =>
      ok(list({ belowReorderCount: 12, criticalCount: 4, truncated: true })),
    );
    renderPanel();
    await screen.findByText("12 below reorder level, 4 critical.");
    expect(screen.getByText("Showing 2 of 12.")).toBeTruthy();
  });

  test("empty: nothing below vs no thresholds configured", async () => {
    consoleListLowStock.mockImplementation(() => ok(list({ items: [], belowReorderCount: 0 })));
    const first = renderPanel();
    await screen.findByText("No item is below its reorder level.");
    first.unmount();
    consoleListLowStock.mockImplementation(() =>
      ok(list({ items: [], belowReorderCount: 0, evaluatedCount: 0 })),
    );
    renderPanel();
    await screen.findByText(/No reorder levels are set yet/);
    expect(screen.queryByText("No item is below its reorder level.")).toBeNull();
  });

  test("unknown on-hand is its own line, never 'no low stock' or zero", async () => {
    consoleListLowStock.mockImplementation(() =>
      ok(list({ items: [], belowReorderCount: 0, evaluatedCount: 3, unknownOnHandCount: 3 })),
    );
    renderPanel();
    await screen.findByText("3 items have no recorded stock yet, so they can't be checked.");
    expect(screen.queryByText("No item is below its reorder level.")).toBeNull();
    expect(
      screen.queryByText("No item with recorded stock is below its reorder level."),
    ).toBeNull();
  });

  test("some unchecked: the 'none' claim covers only pairs with recorded stock", async () => {
    consoleListLowStock.mockImplementation(() =>
      ok(list({ items: [], belowReorderCount: 0, evaluatedCount: 5, unknownOnHandCount: 1 })),
    );
    renderPanel();
    await screen.findByText("No item with recorded stock is below its reorder level.");
    expect(
      screen.getByText("1 item has no recorded stock yet, so it can't be checked."),
    ).toBeTruthy();
    expect(screen.queryByText("No item is below its reorder level.")).toBeNull();
  });

  test("negative on-hand renders its line, with or without a list", async () => {
    consoleListLowStock.mockImplementation(() => ok(list({ negativeOnHandCount: 2 })));
    renderPanel();
    await screen.findByText("2 items show negative stock and are not ranked.");
    expect(screen.getByText("Product 2")).toBeTruthy();
  });

  test("both counts zero: no unchecked line", async () => {
    consoleListLowStock.mockImplementation(() => ok(list()));
    const { container } = renderPanel();
    await screen.findByText("Product 2");
    expect(container.querySelector(".low-stock__unchecked")).toBeNull();
  });

  test("names its freshness and completeness", async () => {
    consoleListLowStock.mockImplementation(() => ok(list()));
    const { container } = renderPanel();
    await screen.findByText("Product 2");
    const fresh = container.querySelector(".low-stock__fresh") as HTMLElement;
    expect(fresh.textContent).toContain("As of");
    expect(fresh.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-02T10:00:00Z");
    expect(fresh.textContent).toContain("Received facts only");
  });

  test("error is never rendered as empty, and retry reads again", async () => {
    consoleListLowStock.mockImplementationOnce(() => fail(500));
    renderPanel();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("req-9");
    expect(screen.queryByText("No item is below its reorder level.")).toBeNull();
    consoleListLowStock.mockImplementation(() => ok(list()));
    fireEvent.click(within(alert).getByRole("button"));
    await screen.findByText("Product 2");
  });

  test("a malformed answer is an error", async () => {
    consoleListLowStock.mockImplementation(() => ok({}));
    renderPanel();
    await screen.findByRole("alert");
  });

  test("404 hides the block; a role outside the contract never reads", async () => {
    consoleListLowStock.mockImplementation(() => Promise.resolve({ status: 404 }));
    const { container } = renderPanel();
    await waitFor(() => expect(consoleListLowStock).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector("section")).toBeNull());
    consoleListLowStock.mockClear();
    const other = renderPanel({ ...session, role: "cashier" });
    expect(other.container.querySelector("section")).toBeNull();
    expect(consoleListLowStock).not.toHaveBeenCalled();
  });

  test("the active store narrows the read", async () => {
    consoleListLowStock.mockImplementation(() => ok(list()));
    renderPanel({ ...session, activeStoreId: S });
    await screen.findByText("Product 2");
    expect(consoleListLowStock).toHaveBeenCalledWith({ store_id: S });
  });
});
