/**
 * RT-189 — the run GET's `summary` projection (pure; no Docker). The stored
 * `bin_view_report` is reduced to its metadata; `entries` never leaves; the
 * pre-RT-175 report shape reads with the `normalizeStored` defaults.
 */
import { boundedSummary } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.service";
import { binViewReportDefaults } from "../../../../src/catalog/erpnext-bin-view/erpnext-bin-view.service";

const entries = (n: number): unknown[] =>
  Array.from({ length: n }, (_, i) => ({
    erpnextItemRef: `ITEM-${i}`,
    productRef: null,
    quantity: "1.000",
    stockUom: "Nos",
  }));

const META_KEYS = ["acceptedEntryCount", "attemptRef", "complete", "readAt", "recordedAt", "windowsRecorded"];

describe("RT-189 boundedSummary", () => {
  it("null summary and a summary without a report pass through", () => {
    expect(boundedSummary(null)).toBeNull();
    expect(boundedSummary({ quantity_divergence: 2 })).toEqual({ quantity_divergence: 2 });
  });

  it("a current (RT-175) report keeps its metadata, drops entries/windows/refs", () => {
    const body = boundedSummary({
      quantity_divergence: 3,
      failure: { code: "x" },
      bin_view_report: {
        requestRef: "req",
        runRef: "run",
        erpnextWarehouseRef: "WH",
        attemptRef: "att-1",
        readAt: "2026-10-29T10:00:00.000Z",
        recordedAt: "2026-10-29T10:00:01.000Z",
        complete: false,
        windowsRecorded: 2,
        acceptedEntryCount: 7,
        windows: [
          { windowSeq: 0, entryCount: 4, isFinal: false, recordedAt: "t" },
          { windowSeq: 1, entryCount: 3, isFinal: false, recordedAt: "t" },
        ],
        entries: entries(7),
        supersededAttemptRefs: ["old"],
      },
    })!;
    expect(body["quantity_divergence"]).toBe(3);
    expect(body["failure"]).toEqual({ code: "x" });
    expect(body["bin_view_report"]).toEqual({
      complete: false,
      windowsRecorded: 2,
      acceptedEntryCount: 7,
      readAt: "2026-10-29T10:00:00.000Z",
      recordedAt: "2026-10-29T10:00:01.000Z",
      attemptRef: "att-1",
    });
  });

  it("a pre-RT-175 report (no complete/attemptRef/windows/acceptedEntryCount) reads with the normalizeStored defaults", () => {
    const body = boundedSummary({
      bin_view_report: {
        requestRef: "req",
        runRef: "run",
        erpnextWarehouseRef: "WH",
        readAt: "r",
        recordedAt: "c",
        entries: entries(5),
      },
    })!;
    expect(body["bin_view_report"]).toEqual({
      complete: true,
      windowsRecorded: 1,
      acceptedEntryCount: 5,
      readAt: "r",
      recordedAt: "c",
      attemptRef: null,
    });
  });

  it("the SQL-projected shape (lengths instead of arrays) gives the same answer", () => {
    const body = boundedSummary({
      bin_view_report: { readAt: "r", recordedAt: "c", entryCount: 5, windowCount: null, complete: null, attemptRef: null },
    })!;
    expect(body["bin_view_report"]).toEqual({
      complete: true,
      windowsRecorded: 1,
      acceptedEntryCount: 5,
      readAt: "r",
      recordedAt: "c",
      attemptRef: null,
    });
  });

  it("is bounded for a full 20 x 500 report and never carries entries", () => {
    const body = boundedSummary({
      bin_view_report: {
        readAt: "r",
        recordedAt: "c",
        windows: Array.from({ length: 20 }, (_, i) => ({ windowSeq: i, entryCount: 500, isFinal: i === 19, recordedAt: "t" })),
        entries: entries(10_000),
      },
    })!;
    const report = body["bin_view_report"] as Record<string, unknown>;
    expect(Object.keys(report).sort()).toEqual(META_KEYS);
    expect(report["windowsRecorded"]).toBe(20);
    expect(report["acceptedEntryCount"]).toBe(10_000);
    expect(JSON.stringify(body).length).toBeLessThan(10_240);
  });

  it("a non-object bin_view_report is left as stored", () => {
    expect(boundedSummary({ bin_view_report: null })).toEqual({ bin_view_report: null });
  });
});

describe("RT-189 binViewReportDefaults", () => {
  it("defaults an empty historical report", () => {
    expect(binViewReportDefaults({}, 3, 0)).toEqual({
      attemptRef: null,
      complete: true,
      windowsRecorded: 1,
      acceptedEntryCount: 3,
    });
  });
  it("keeps stored values", () => {
    expect(binViewReportDefaults({ complete: false, acceptedEntryCount: 9, attemptRef: "a" }, 3, 4)).toEqual({
      attemptRef: "a",
      complete: false,
      windowsRecorded: 4,
      acceptedEntryCount: 9,
    });
  });
});
