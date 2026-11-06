/**
 * RT-919 — SnapshotReportBodySchema accepts the stock-view 1.4.0-draft
 * `BinEntry.tracking` evidence (Docker-free).
 *
 * The contract (`erpnext-connector/stock-view.yaml` `BinEntryTracking`,
 * `BinEntryBatch`, `ErpnextBatchRef`): strict objects; three required Item
 * flags; optional `batches` (at most 200, a Batch at most once), each
 * `{batchRef {doctype "Batch", name}, quantity (exact-decimal), expiryDate
 * (date or null, required), disabled}`. Both shapes are accepted: a batch Item
 * with its Batches, and an untracked Item (three false flags, no `batches`).
 * An entry without `tracking` validates exactly as before; a malformed
 * `tracking` fails the whole body (400 `validation_error` at the route).
 */
import {
  BIN_VIEW_MAX_BATCHES_PER_ENTRY,
  SnapshotReportBodySchema,
} from "../../../../src/catalog/erpnext-bin-view/dto/snapshot-report.dto";

const READ_AT = "2026-11-06T08:00:00.000Z";
const ATTEMPT = "0a000000-0000-4000-8000-0000000a9190";

const ENTRY = {
  erpnextItemRef: { doctype: "Item", name: "ITEM-1" },
  quantity: "10",
  stockUom: "Nos",
};
const BATCH = {
  batchRef: { doctype: "Batch", name: "BATCH-0001" },
  quantity: "6",
  expiryDate: "2027-03-31",
  disabled: false,
};
const BATCH_FLAGS = { hasBatchNo: true, hasSerialNo: false, hasExpiryDate: true };
const UNTRACKED = { hasBatchNo: false, hasSerialNo: false, hasExpiryDate: false };

/** One `it.each` row of the malformed-tracking table. */
interface MalformedCase {
  readonly label: string;
  readonly tracking: unknown;
}

const withTracking = (tracking: unknown) => ({ ...ENTRY, tracking });
const withBatches = (batches: unknown[]) => withTracking({ ...BATCH_FLAGS, batches });
const body = (entries: unknown[]) => ({ entries, readAt: READ_AT });
const ok = (b: object): boolean => SnapshotReportBodySchema.safeParse(b).success;

const { expiryDate: _omitted, ...BATCH_NO_EXPIRY_KEY } = BATCH;

const MALFORMED: MalformedCase[] = [
  { label: "a missing Item flag", tracking: { hasBatchNo: true, hasSerialNo: false } },
  { label: "a non-boolean flag", tracking: { ...UNTRACKED, hasBatchNo: "yes" } },
  { label: "an unknown key in tracking", tracking: { ...UNTRACKED, serials: [] } },
  { label: "tracking that is not an object", tracking: "batch" },
  { label: "batches that is not an array", tracking: { ...BATCH_FLAGS, batches: BATCH } },
  { label: "an unknown key in a Batch", tracking: { ...BATCH_FLAGS, batches: [{ ...BATCH, price: "1" }] } },
  { label: "a float-style quantity", tracking: { ...BATCH_FLAGS, batches: [{ ...BATCH, quantity: "1e3" }] } },
  { label: "a numeric quantity", tracking: { ...BATCH_FLAGS, batches: [{ ...BATCH, quantity: 6 }] } },
  { label: "a quantity with 7 fractional digits", tracking: { ...BATCH_FLAGS, batches: [{ ...BATCH, quantity: "1.1234567" }] } },
  { label: "an Item batchRef doctype", tracking: { ...BATCH_FLAGS, batches: [{ ...BATCH, batchRef: { doctype: "Item", name: "X" } }] } },
  { label: "an empty Batch name", tracking: { ...BATCH_FLAGS, batches: [{ ...BATCH, batchRef: { doctype: "Batch", name: "" } }] } },
  { label: "a Batch name over 140 characters", tracking: { ...BATCH_FLAGS, batches: [{ ...BATCH, batchRef: { doctype: "Batch", name: "B".repeat(141) } }] } },
  { label: "an unknown key in batchRef", tracking: { ...BATCH_FLAGS, batches: [{ ...BATCH, batchRef: { ...BATCH.batchRef, item: "ITEM-1" } }] } },
  { label: "a datetime expiryDate", tracking: { ...BATCH_FLAGS, batches: [{ ...BATCH, expiryDate: "2027-03-31T00:00:00Z" }] } },
  { label: "an impossible expiryDate", tracking: { ...BATCH_FLAGS, batches: [{ ...BATCH, expiryDate: "2027-02-30" }] } },
  { label: "an omitted expiryDate (required, nullable)", tracking: { ...BATCH_FLAGS, batches: [BATCH_NO_EXPIRY_KEY] } },
  { label: "a missing disabled flag", tracking: { ...BATCH_FLAGS, batches: [{ ...BATCH, disabled: undefined }] } },
  { label: "the same Batch twice", tracking: { ...BATCH_FLAGS, batches: [BATCH, { ...BATCH, quantity: "1" }] } },
  {
    label: "more than 200 Batches",
    tracking: {
      ...BATCH_FLAGS,
      batches: Array.from({ length: 201 }, (_, i) => ({ ...BATCH, batchRef: { doctype: "Batch", name: `B-${i}` } })),
    },
  },
];

describe("RT-919 SnapshotReportBodySchema — v1.4 BinEntry.tracking evidence", () => {
  it("the Batch ceiling matches the contract's maxItems (200)", () => {
    expect(BIN_VIEW_MAX_BATCHES_PER_ENTRY).toBe(200);
  });

  it("an entry without tracking validates exactly as before", () => {
    expect(ok(body([ENTRY]))).toBe(true);
    expect(SnapshotReportBodySchema.parse(body([ENTRY])).entries[0]).toEqual(ENTRY);
  });

  it("accepts a batch Item with its Batches (an expiry, a null expiry, disabled, a negative quantity)", () => {
    const noExpiry = { ...BATCH, batchRef: { doctype: "Batch", name: "BATCH-0002" }, quantity: "-1.500000", expiryDate: null, disabled: true };
    const parsed = SnapshotReportBodySchema.parse(body([withBatches([BATCH, noExpiry])]));
    expect(parsed.entries[0]?.tracking).toEqual({ ...BATCH_FLAGS, batches: [BATCH, noExpiry] });
  });

  it("accepts an untracked Item: three false flags and no batches", () => {
    const parsed = SnapshotReportBodySchema.parse(body([withTracking(UNTRACKED)]));
    expect(parsed.entries[0]?.tracking).toEqual(UNTRACKED);
    expect(parsed.entries[0]?.tracking).not.toHaveProperty("batches");
  });

  it("accepts a serial Item reported with its flag only, and exactly 200 Batches", () => {
    const serial = { hasBatchNo: false, hasSerialNo: true, hasExpiryDate: false };
    const many = Array.from({ length: 200 }, (_, i) => ({ ...BATCH, batchRef: { doctype: "Batch", name: `B-${i}` } }));
    expect(ok(body([withTracking(serial)]))).toBe(true);
    expect(ok(body([withBatches(many)]))).toBe(true);
  });

  it("accepts a window mixing tracked and untracked-unknown entries", () => {
    const second = { ...ENTRY, erpnextItemRef: { doctype: "Item", name: "ITEM-2" } };
    const window = { attemptRef: ATTEMPT, windowSeq: 0, isFinal: true };
    expect(ok({ ...body([withBatches([BATCH]), second]), window })).toBe(true);
  });

  it.each(MALFORMED)("$label → invalid body", ({ tracking }) => {
    expect(ok(body([withTracking(tracking)]))).toBe(false);
  });

  it("one malformed tracking fails the whole window", () => {
    expect(ok(body([withTracking(UNTRACKED), withTracking({ hasBatchNo: true })]))).toBe(false);
  });
});
