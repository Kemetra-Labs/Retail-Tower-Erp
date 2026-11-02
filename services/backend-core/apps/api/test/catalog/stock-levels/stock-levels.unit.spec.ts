/**
 * RT-1066 — the stock-levels request bodies and the TH-2 cross-field rule,
 * without a database.
 */
import {
  criticalAboveReorder,
  RetireStockLevelBodySchema,
  SetStockLevelBodySchema,
} from "../../../src/catalog/stock-levels/stock-levels.bodies";

describe("criticalAboveReorder (TH-2: 0 < critical <= reorder, equal allowed)", () => {
  it.each([
    ["10", null, false],
    ["10", "10", false],
    ["10", "10.0000", false],
    ["10.5", "10.4999", false],
    ["10.5", "10.5001", true],
    ["9.5", "10", true],
    ["0.0001", "0.0002", true],
    ["999999999999999.9999", "999999999999999.9999", false],
    ["100", "99.9999", false],
    ["2", "10", true],
  ])("reorder %s, critical %s → %s (exact, not lexical or float)", (reorder, critical, above) => {
    expect(criticalAboveReorder(reorder, critical)).toBe(above);
  });
});

describe("SetStockLevelBodySchema", () => {
  it("parses expectedUpdatedAt to epoch milliseconds and keeps the levels as sent", () => {
    const body = SetStockLevelBodySchema.parse({
      expectedUpdatedAt: "2026-11-02T10:00:00.123Z",
      reorderLevel: "12.50",
      criticalLevel: null,
    });
    expect(body).toEqual({ expectedUpdatedAt: Date.parse("2026-11-02T10:00:00.123Z"), reorderLevel: "12.50", criticalLevel: null });
  });

  it("accepts a null precondition and an absent criticalLevel", () => {
    expect(SetStockLevelBodySchema.parse({ expectedUpdatedAt: null, reorderLevel: "1" })).toEqual({
      expectedUpdatedAt: null,
      reorderLevel: "1",
    });
  });

  it.each([
    [{ reorderLevel: "1" }],
    [{ expectedUpdatedAt: null }],
    [{ expectedUpdatedAt: null, reorderLevel: 1 }],
    [{ expectedUpdatedAt: null, reorderLevel: "0" }],
    [{ expectedUpdatedAt: null, reorderLevel: "1", criticalLevel: "0" }],
    [{ expectedUpdatedAt: null, reorderLevel: "1", tenantId: "x" }],
  ])("refuses %j", (body) => {
    expect(SetStockLevelBodySchema.safeParse(body).success).toBe(false);
  });
});

describe("RetireStockLevelBodySchema", () => {
  it("requires a non-null instant and nothing else", () => {
    expect(RetireStockLevelBodySchema.safeParse({ expectedUpdatedAt: "2026-11-02T10:00:00Z" }).success).toBe(true);
    expect(RetireStockLevelBodySchema.safeParse({ expectedUpdatedAt: null }).success).toBe(false);
    expect(RetireStockLevelBodySchema.safeParse({}).success).toBe(false);
    expect(RetireStockLevelBodySchema.safeParse({ expectedUpdatedAt: "2026-11-02T10:00:00Z", x: 1 }).success).toBe(false);
  });
});
