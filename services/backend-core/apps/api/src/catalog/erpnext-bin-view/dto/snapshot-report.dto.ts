/**
 * snapshot-report.dto.ts — Zod body schema for `binViewReportSnapshot`.
 *
 * Mirrors the 019 contract `BinViewSnapshotReport` (strict wire projection,
 * stock-view.yaml 1.4.0-draft; the `window` rules were introduced in 1.2, the
 * entry `tracking` evidence in 1.4):
 *   - `entries`: 0..`BIN_VIEW_WINDOW_MAX_ITEMS` (the request's
 *     `itemWindow.maxItems`, 500) BinEntry (empty is a valid, non-failing report);
 *   - each entry: `erpnextItemRef {doctype:"Item", name}`, exact-decimal `quantity`
 *     STRING (the contract pattern — NEVER a float, §III), required `stockUom`;
 *   - `window` (v1.2, optional, strict): `{attemptRef, windowSeq, isFinal}` of a
 *     connector-paged read. Absent = a v1 report, treated as
 *     `{windowSeq 0, isFinal true}`;
 *   - `readAt`: connector-reported ISO timestamp (preserved; never a security clock);
 *   - each entry's `tracking` (v1.4, RT-919, optional, strict): the ERPNext Item
 *     flags `hasBatchNo`/`hasSerialNo`/`hasExpiryDate` and, for a batch Item, up
 *     to `BIN_VIEW_MAX_BATCHES_PER_ENTRY` (200) `batches`
 *     `{batchRef {doctype:"Batch", name}, quantity, expiryDate (date|null), disabled}`,
 *     a Batch at most once. Evidence only: it is recorded with the entry and
 *     moves nothing. Absent = an older Connector, tracking UNKNOWN.
 *
 * v1.2 body rules enforced here (400 `validation_error`, deterministic, no record):
 *   - `window.windowSeq` ≥ the request's `itemWindow.maxWindows`
 *     (`BIN_VIEW_MAX_WINDOWS`);
 *   - a window that is NOT `{windowSeq 0, isFinal true}` with zero entries (a
 *     non-final window carries 1..maxItems entries; zero entries is valid only as
 *     the single empty-warehouse window or as a v1 report).
 * The sequencing / attempt / disjointness / `readAt` rules need the recorded
 * attempt, so they live in the service (409 `window_sequence_conflict`).
 *
 * §XII strict boundary: `.strict()` everywhere rejects unknown keys, and there is
 * NO `tenant_id`/`storeId`/scope field — scope is the connector principal's;
 * `requestRef` is a PATH param (un-forgeable). A body that smuggles scope or an
 * unknown key is a 400 validation_error.
 */
import { z } from "zod";

import { boundedArray } from "../../../common/bounded-array";

/**
 * Per-window entry cap advertised on every `BinViewRequest` as
 * `itemWindow.maxItems` — equals the report `entries` ceiling (contract invariant).
 */
export const BIN_VIEW_WINDOW_MAX_ITEMS = 500;

/**
 * Most report windows the connector may send for one request, advertised as
 * `itemWindow.maxWindows` (RT-21 §4: 20 × 500 = 10,000 items). Owner-tunable.
 */
export const BIN_VIEW_MAX_WINDOWS = 20;

/** The contract's exact-decimal quantity pattern (no float). */
const QUANTITY_PATTERN = /^-?\d{1,15}(\.\d{1,6})?$/;

const ErpnextItemRefSchema = z
  .object({
    doctype: z.literal("Item"),
    name: z.string().min(1).max(140),
  })
  .strict();

/**
 * v1.4 `BinEntryTracking.batches` ceiling (`maxItems: 200`): more Batches for one
 * Item in one warehouse is outside this contract version (400).
 */
export const BIN_VIEW_MAX_BATCHES_PER_ENTRY = 200;

const QuantitySchema = z
  .string()
  .regex(QUANTITY_PATTERN, "quantity must be an exact-decimal string");

/** v1.4 `ErpnextBatchRef` — an ERPNext Batch, doctype fixed to "Batch". */
const ErpnextBatchRefSchema = z
  .object({
    doctype: z.literal("Batch"),
    name: z.string().min(1).max(140),
  })
  .strict();

/** v1.4 `BinEntryBatch` — one Batch of the entry's Item and its book quantity. */
const BinEntryBatchSchema = z
  .object({
    batchRef: ErpnextBatchRefSchema,
    quantity: QuantitySchema,
    // Required but nullable: null = the Batch has no expiry date.
    expiryDate: z.string().date().nullable(),
    disabled: z.boolean(),
  })
  .strict();

/** v1.4 `BinEntryTracking` — the Item's tracking flags and its Batches here. */
const BinEntryTrackingSchema = z
  .object({
    hasBatchNo: z.boolean(),
    hasSerialNo: z.boolean(),
    hasExpiryDate: z.boolean(),
    batches: boundedArray(
      BIN_VIEW_MAX_BATCHES_PER_ENTRY,
      z.array(BinEntryBatchSchema),
    ).optional(),
  })
  .strict()
  .superRefine((tracking, ctx) => {
    // The contract: "one entry per Batch, a Batch at most once".
    const seen = new Set<string>();
    (tracking.batches ?? []).forEach((batch, i) => {
      const name = batch.batchRef.name;
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["batches", i, "batchRef", "name"],
          message: "a Batch is reported at most once per entry",
        });
      }
      seen.add(name);
    });
  });

const BinEntrySchema = z
  .object({
    erpnextItemRef: ErpnextItemRefSchema,
    quantity: QuantitySchema,
    stockUom: z.string().min(1).max(140),
    tracking: BinEntryTrackingSchema.optional(),
  })
  .strict();

/** v1.2 `BinViewReportWindow` — one window of a connector-paged read. */
const BinViewReportWindowSchema = z
  .object({
    attemptRef: z.string().uuid(),
    windowSeq: z.number().int().min(0),
    isFinal: z.boolean(),
  })
  .strict();

export const SnapshotReportBodySchema = z
  .object({
    // RT-1051: length-first, so an oversized report never validates each entry.
    entries: boundedArray(BIN_VIEW_WINDOW_MAX_ITEMS, z.array(BinEntrySchema)),
    window: BinViewReportWindowSchema.optional(),
    readAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((body, ctx) => {
    const w = body.window;
    if (w === undefined) return;
    if (w.windowSeq >= BIN_VIEW_MAX_WINDOWS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["window", "windowSeq"],
        message: `window.windowSeq must be less than the request's maxWindows (${BIN_VIEW_MAX_WINDOWS})`,
      });
    }
    const emptyAllowed = w.windowSeq === 0 && w.isFinal;
    if (body.entries.length === 0 && !emptyAllowed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message:
          "a window other than {windowSeq 0, isFinal true} must carry at least one entry",
      });
    }
  });

export type SnapshotReportBody = z.infer<typeof SnapshotReportBodySchema>;
