/**
 * RT-1069 — unit checks of the low-stock projection (no database).
 *
 * The ratio formatting (`div(sellable * 10^4, reorder)` → `"0.dddd"`) and the
 * band / status mapping. The ordering, the counts and the evaluated-pair
 * rules are computed by the one SQL statement and are proven against real
 * Postgres in `low-stock.http.integration.spec.ts`.
 */
import { levelRatioOf, toLowStockItem, type LowStockItemRow } from "../../../src/inventory/low-stock/low-stock.service";

const ROW: LowStockItemRow = {
  store_id: "0a000000-0000-7000-8000-00000000a5a1",
  store_name: "Store X",
  store_active: true,
  product_id: "0a000000-0000-7000-8000-000010690001",
  product_name: "Water",
  stocking_unit: null,
  sellable: "5.0000",
  reorder_level: "10.0000",
  critical_level: null,
  threshold_source: "tenant",
  critical: false,
  ratio_digits: 5000,
};

describe("RT-1069 levelRatioOf", () => {
  it.each([
    [0, "0.0000"],
    [7, "0.0007"],
    [333, "0.0333"],
    [3333, "0.3333"],
    [9999, "0.9999"],
  ])("%d → %s", (digits, wire) => {
    expect(levelRatioOf(digits)).toBe(wire);
  });

  it.each([-1, 10000, 1.5, Number.NaN])("refuses %d (a low pair's ratio is below 1)", (digits) => {
    expect(() => levelRatioOf(digits)).toThrow(/out of range/);
  });
});

describe("RT-1069 toLowStockItem", () => {
  it("maps a low pair of an active store, quantities passed through as given", () => {
    expect(toLowStockItem(ROW)).toEqual({
      storeId: ROW.store_id,
      storeName: "Store X",
      storeStatus: "active",
      productId: ROW.product_id,
      productName: "Water",
      stockingUnit: null,
      sellableOnHand: "5.0000",
      reorderLevel: "10.0000",
      criticalLevel: null,
      thresholdSource: "tenant",
      band: "low",
      levelRatio: "0.5000",
    });
  });

  it("maps a critical pair of an inactive store", () => {
    const item = toLowStockItem({ ...ROW, store_active: false, critical: true, critical_level: "6.0000", threshold_source: "store" });
    expect(item).toEqual(expect.objectContaining({ storeStatus: "inactive", band: "critical", criticalLevel: "6.0000", thresholdSource: "store" }));
  });
});
