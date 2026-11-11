/**
 * RT-1288 — the pure DC-4 rules of the ERP-origin stock import (no I/O), and
 * the report DTO's body rules.
 */
import {
  bodyHash,
  STOCK_IMPORT_OVERLAP_SECONDS,
  STOCK_IMPORT_SETTLE_SECONDS,
} from "../../../src/catalog/erpnext-stock-import/erpnext-stock-import.service";
import { StockImportReportSchema } from "../../../src/catalog/erpnext-stock-import/dto/stock-import.dto";
import {
  cancelKey,
  effectKeyBase,
  erpOwnedEventType,
  isNegativeQuantity,
  isZeroQuantity,
  journalQuantity,
} from "../../../src/catalog/erpnext-stock-import/stock-import.rules";

describe("erpOwnedEventType (DC-4 families)", () => {
  const f = (voucherType: string, purpose: string | null = null, correctionRef: string | null = null) =>
    erpOwnedEventType({ voucherType, purpose, correctionRef });

  it("imports the ERP-owned families", () => {
    expect(f("Purchase Receipt")).toBe("erp_procurement_receipt");
    expect(f("Stock Entry", "Manufacture")).toBe("erp_manufacturing");
    expect(f("Stock Entry", "Repack")).toBe("erp_manufacturing");
    expect(f("Stock Reconciliation", "Opening Stock")).toBe("erp_opening_stock");
    expect(f("Stock Reconciliation", "Stock Reconciliation", "BG-1")).toBe("erp_correction");
    expect(f("Stock Entry", "Material Receipt", "BG-2")).toBe("erp_correction");
  });

  it("returns null for every other voucher (an unattributed movement)", () => {
    expect(f("Sales Invoice")).toBeNull();
    expect(f("Delivery Note")).toBeNull();
    expect(f("Stock Entry", "Material Transfer")).toBeNull();
    expect(f("Stock Reconciliation", "Stock Reconciliation")).toBeNull();
    expect(f("Purchase Invoice", null, "BG-3")).toBeNull();
  });
});

describe("effect keys (DC-4 with D1, DC-6)", () => {
  const base = { voucherType: "Stock Entry", voucherNo: "STE-1", voucherDetailNo: "d1", erpnextWarehouseRef: "Stores - RT" };

  it("includes the warehouse, and the Batch when there is one", () => {
    expect(effectKeyBase({ ...base, batch: null })).toBe("Stock%20Entry:STE-1:d1:Stores%20-%20RT");
    expect(effectKeyBase({ ...base, batch: "LOT-1" })).toBe("Stock%20Entry:STE-1:d1:Stores%20-%20RT:LOT-1");
    expect(cancelKey("k")).toBe("k:cancel");
  });

  it("never lets two rows at different warehouses share a key", () => {
    expect(effectKeyBase({ ...base, batch: null })).not.toBe(
      effectKeyBase({ ...base, erpnextWarehouseRef: "Other - RT", batch: null }),
    );
  });

  it("cannot be forged by a ':' inside a name", () => {
    const a = effectKeyBase({ ...base, voucherNo: "A:B", voucherDetailNo: "C", batch: null });
    const b = effectKeyBase({ ...base, voucherNo: "A", voucherDetailNo: "B:C", batch: null });
    expect(a).not.toBe(b);
  });
});

describe("quantities (exact strings, §III)", () => {
  it("keeps up to 4 fractional digits and refuses more", () => {
    expect(journalQuantity("5")).toBe("5");
    expect(journalQuantity("5.250000")).toBe("5.25");
    expect(journalQuantity("-2.000000")).toBe("-2");
    expect(journalQuantity("1.12345")).toBeNull();
    expect(journalQuantity("1.123400")).toBe("1.1234");
  });

  it("recognises zero and negative values", () => {
    expect(isZeroQuantity("0.000000")).toBe(true);
    expect(isZeroQuantity("-0.0")).toBe(true);
    expect(isZeroQuantity("0.000001")).toBe(false);
    expect(isNegativeQuantity("-0.000000")).toBe(false);
    expect(isNegativeQuantity("-1")).toBe(true);
  });
});

describe("settings", () => {
  it("overlaps by at least an hour plus the settle bound (daylight-saving fall-back)", () => {
    expect(STOCK_IMPORT_OVERLAP_SECONDS).toBeGreaterThanOrEqual(3600 + STOCK_IMPORT_SETTLE_SECONDS);
  });

  it("fingerprints a body independently of key order", () => {
    expect(bodyHash({ a: 1, b: [{ x: 1, y: 2 }] })).toBe(bodyHash({ b: [{ y: 2, x: 1 }], a: 1 }));
    expect(bodyHash({ a: 1 })).not.toBe(bodyHash({ a: 2 }));
  });
});

describe("StockImportReportSchema body rules", () => {
  const row = (ledgerEntryRef: string, entryIndex = 0) => ({
    ledgerEntryRef,
    entryIndex,
    voucherType: "Purchase Receipt",
    voucherNo: "PR-1",
    voucherDetailNo: "d1",
    purpose: null,
    isReturn: false,
    returnAgainst: null,
    postingDate: "2026-11-11",
    postingTime: "10:00:00.5",
    creation: "2026-11-11T10:00:00.123456+02:00",
    isCancelled: false,
    actualQty: "-1.5",
    stockUom: "Nos",
    erpnextItemRef: { doctype: "Item", name: "I" },
    erpnextBatchRef: null,
    hasRetailProvenance: false,
    correctionRef: null,
  });
  const rt = (r: ReturnType<typeof row>) => ({ creation: r.creation, ledgerEntryRef: r.ledgerEntryRef, entryIndex: r.entryIndex });
  const ok = (body: unknown) => StockImportReportSchema.safeParse(body).success;

  it("accepts a page, an empty exhausted page and a refusal", () => {
    const r = row("S1");
    expect(ok({ rows: [r], readThrough: rt(r), exhausted: false, readAt: "2026-11-11T10:00:00Z" })).toBe(true);
    expect(ok({ rows: [], readThrough: null, exhausted: true, readAt: "2026-11-11T10:00:00Z", refusal: null })).toBe(true);
    expect(
      ok({ rows: [], readThrough: null, exhausted: false, readAt: "2026-11-11T10:00:00Z", refusal: { reason: "unknown_warehouse" } }),
    ).toBe(true);
  });

  it("refuses the contract's broken shapes", () => {
    const r = row("S1");
    const readAt = "2026-11-11T10:00:00Z";
    expect(ok({ rows: [], readThrough: null, exhausted: false, readAt })).toBe(false);
    expect(ok({ rows: [r, row("S1")], readThrough: rt(r), exhausted: true, readAt })).toBe(false);
    expect(ok({ rows: [r], readThrough: { ...rt(r), entryIndex: 1 }, exhausted: true, readAt })).toBe(false);
    expect(ok({ rows: [r], readThrough: null, exhausted: true, readAt })).toBe(false);
    expect(ok({ rows: [r], readThrough: rt(r), exhausted: false, readAt, refusal: { reason: "unknown_warehouse" } })).toBe(false);
    // A creation without a timezone, with readThrough matching it, so only the
    // timestamp rule can refuse it.
    const missingTimezone = { ...r, creation: "2026-11-11T10:00:00" };
    expect(ok({ rows: [missingTimezone], readThrough: rt(missingTimezone), exhausted: true, readAt })).toBe(false);
    expect(ok({ rows: [{ ...r, unitCost: "1" }], readThrough: rt(r), exhausted: true, readAt })).toBe(false);
    expect(ok({ rows: [], readThrough: null, exhausted: true, readAt, tenant_id: "x" })).toBe(false);
  });
});
