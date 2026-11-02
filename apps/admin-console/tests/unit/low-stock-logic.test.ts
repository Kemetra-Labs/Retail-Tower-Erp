import {
  asLowStock,
  canReadLowStock,
  fillPercent,
  toneOf,
  trimQuantity,
  uncheckedCount,
  viewOf,
} from "@/overview/lowStockLogic";
import { describe, expect, test } from "vitest";

const base = {
  asOf: "2026-11-02T10:00:00Z",
  completeness: "received_only",
  storeId: null,
  limit: 10,
  evaluatedCount: 3,
  belowReorderCount: 0,
  criticalCount: 0,
  unknownOnHandCount: 0,
  negativeOnHandCount: 0,
  truncated: false,
  items: [],
};

describe("RT-1073 low-stock logic", () => {
  test("red only for critical", () => {
    expect(toneOf({ band: "critical" })).toBe("critical");
    expect(toneOf({ band: "low" })).toBe("low");
  });
  test("trims trailing zeros without computing", () => {
    expect(trimQuantity("12.5000")).toBe("12.5");
    expect(trimQuantity("3.0000")).toBe("3");
    expect(trimQuantity("0.0000")).toBe("0");
    expect(trimQuantity("10")).toBe("10");
  });
  test("fill comes from the contract ratio, clamped", () => {
    expect(fillPercent("0.2500")).toBe(25);
    expect(fillPercent("0.0000")).toBe(0);
    expect(fillPercent("abc")).toBe(0);
    expect(fillPercent("1.5")).toBe(100);
  });
  test("views: unconfigured vs none vs list", () => {
    expect(viewOf({ ...base, evaluatedCount: 0 } as never).kind).toBe("unconfigured");
    expect(viewOf(base as never).kind).toBe("none");
    expect(viewOf({ ...base, items: [{}] } as never).kind).toBe("list");
  });
  test("unchecked pairs never read as plain 'none'", () => {
    const unknown = { ...base, evaluatedCount: 3, unknownOnHandCount: 1 };
    expect(viewOf(unknown as never).kind).toBe("noneChecked");
    expect(viewOf({ ...base, negativeOnHandCount: 2 } as never).kind).toBe("noneChecked");
    // every evaluated pair unchecked: no low-stock claim at all
    expect(viewOf({ ...base, evaluatedCount: 3, unknownOnHandCount: 3 } as never).kind).toBe(
      "unchecked",
    );
    expect(
      viewOf({ ...base, evaluatedCount: 3, unknownOnHandCount: 1, negativeOnHandCount: 2 } as never)
        .kind,
    ).toBe("unchecked");
    expect(
      uncheckedCount({ ...base, unknownOnHandCount: 1, negativeOnHandCount: 2 } as never),
    ).toBe(3);
    expect(viewOf(base as never).kind).toBe("none");
  });
  test("malformed bodies are rejected", () => {
    expect(asLowStock(undefined)).toBeUndefined();
    expect(asLowStock({})).toBeUndefined();
    expect(asLowStock({ items: [], belowReorderCount: "1" })).toBeUndefined();
    expect(asLowStock({ ...base, unknownOnHandCount: undefined })).toBeUndefined();
    expect(asLowStock(base)).toBeDefined();
  });
  test("role gate mirrors the contract", () => {
    expect(canReadLowStock("owner")).toBe(true);
    expect(canReadLowStock("store_manager")).toBe(true);
    expect(canReadLowStock("cashier")).toBe(false);
    expect(canReadLowStock(null)).toBe(false);
  });
});
