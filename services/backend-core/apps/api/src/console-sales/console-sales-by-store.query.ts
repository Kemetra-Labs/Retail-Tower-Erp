/**
 * RT-1053 — request schema and the baseline bounds of the console sales by
 * store (`console-sales-by-store.openapi.yaml`, RT-1008).
 *
 * `from`, `to` and `currency` are REQUIRED; `from` and `to` are inclusive,
 * `to >= from` and `to - from <= 30` (the summary's bound). `compare` is
 * `previous_period` (default) or `none`. There is no `store_id`, no cursor
 * and no page size: `.strict()` makes each of them, and any other unknown
 * key, a 400. A repeated key arrives as an array and is a 400. Every refusal
 * here is a 400 `validation_error`, raised after the guards and before any
 * read.
 */
import { z } from "zod";

import { BusinessDateSchema, refineBusinessRange } from "./console-sales.query";

const DAY_MS = 86_400_000;

/** At most this many stores in scope; more is 400 `scope_too_large` (D-9). */
export const BY_STORE_MAX_STORES = 500;

export const COMPARE_VALUES = ["previous_period", "none"] as const;
export type Compare = (typeof COMPARE_VALUES)[number];

export const ConsoleSalesByStoreQuerySchema = z
  .object({
    from: BusinessDateSchema,
    to: BusinessDateSchema,
    currency: z.string().regex(/^[A-Z]{3}$/, "currency must be an ISO-4217 code in upper case"),
    compare: z.enum(COMPARE_VALUES).default("previous_period"),
  })
  .strict()
  .superRefine(refineBusinessRange);

export type ConsoleSalesByStoreQuery = z.infer<typeof ConsoleSalesByStoreQuerySchema>;

/** The caller's scope holds more than `BY_STORE_MAX_STORES` stores → 400 `scope_too_large`. */
export class ScopeTooLargeError extends Error {
  constructor() {
    super(`the scope holds more than ${BY_STORE_MAX_STORES} stores`);
    this.name = "ScopeTooLargeError";
  }
}

export interface BaselineBounds {
  readonly rule: "previous_equal_length";
  readonly from: string;
  readonly to: string;
  readonly dayCount: number;
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** D-2: the equal-length period immediately before `[from, to]`. */
export function baselineOf(from: string, to: string): BaselineBounds {
  const dayCount = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
  return {
    rule: "previous_equal_length",
    from: addDays(from, -dayCount),
    to: addDays(from, -1),
    dayCount,
  };
}
