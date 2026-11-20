/**
 * RT-1484 (RT-282 PR-08b) — query shapes of `pricing/price-inquiry.yaml` 1.0.0-draft.
 *
 * `ReadValidationFailure` / `TimelineValidationFailure`: a `sell_unit` other than `each`, an `at`,
 * `from` or `to` without an offset, an `as_of_revision` below 1, an unknown parameter, and for the
 * timeline a missing bound, `to` not after `from` or a window over 366 days are 400
 * `validation_error`, checked before any database read. A failed parse throws the `ZodError` the
 * global filter answers as 400 `validation_error`.
 */
import { z } from "zod";

import { AsOfRevisionSchema, AtSchema } from "../pricing-query";

/** The longest timeline window (decision 511). */
export const MAX_TIMELINE_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

const SellUnitSchema = z.enum(["each"]);

export const PriceInquiryQuerySchema = z
  .object({
    sell_unit: SellUnitSchema.optional(),
    at: AtSchema.optional(),
    as_of_revision: AsOfRevisionSchema.optional(),
  })
  .strict();
export type PriceInquiryQuery = z.infer<typeof PriceInquiryQuerySchema>;

export const PriceTimelineQuerySchema = z
  .object({
    sell_unit: SellUnitSchema.optional(),
    from: AtSchema,
    to: AtSchema,
    as_of_revision: AsOfRevisionSchema.optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    const span = Date.parse(q.to) - Date.parse(q.from);
    if (!(span > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "must be after from" });
    else if (span > MAX_TIMELINE_WINDOW_MS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "must be at most 366 days after from" });
    }
  });
export type PriceTimelineQuery = z.infer<typeof PriceTimelineQuerySchema>;
