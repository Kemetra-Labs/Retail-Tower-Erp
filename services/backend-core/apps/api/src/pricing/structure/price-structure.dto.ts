/**
 * RT-1484 (RT-282 PR-09a) — request shapes of `pricing/price-structure.yaml` 1.0.0-draft.
 *
 * Each schema mirrors the contract and the 0121 CHECKs it lands in: codes
 * `^[A-Z0-9][A-Z0-9_-]{0,31}$`, names 1..120, a retire reason 1..500, a currency with a known
 * ISO-4217 minor unit (`validation_error` otherwise). Bodies are strict (an unknown key is a 400).
 * A failed parse throws the `ZodError` the global filter answers as 400 `validation_error`.
 */
import { z } from "zod";

import { minorUnitExponent } from "../../common/money/iso4217-minor-units";
import { AsOfRevisionSchema, AtSchema } from "../pricing-query";

const CodeSchema = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/, "must be an upper-case code of 1 to 32 characters");
// The DB counts characters (code points), Zod UTF-16 units: Zod is the stricter of the two.
const NameSchema = z.string().min(1).max(120);

export const CreatePriceBookBodySchema = z
  .object({
    code: CodeSchema,
    name: NameSchema,
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/, "must be an ISO-4217 alphabetic code")
      .refine((code) => minorUnitExponent(code) !== null, "has no minor unit known to Backend-Core"),
    taxPriceBasis: z.enum(["inclusive", "exclusive"]),
    defaultZoneName: NameSchema.optional(),
  })
  .strict();
export type CreatePriceBookBody = z.infer<typeof CreatePriceBookBodySchema>;

export const CreatePriceZoneBodySchema = z.object({ code: CodeSchema, name: NameSchema }).strict();
export type CreatePriceZoneBody = z.infer<typeof CreatePriceZoneBodySchema>;

export const RetirePriceZoneBodySchema = z.object({ reason: z.string().min(1).max(500) }).strict();
export type RetirePriceZoneBody = z.infer<typeof RetirePriceZoneBodySchema>;

// The instant and revision rules are shared with price inquiry (RT-1484 PR-08b); so is the path
// id rule (`parsePathId` in `../pricing-query`).
export { isRfc3339Instant } from "../pricing-query";

const CursorSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
const PageSizeSchema = z
  .string()
  .regex(/^\d{1,3}$/, "must be an integer from 1 to 200")
  .transform((v) => Number(v))
  .refine((v) => v >= 1 && v <= 200, "must be an integer from 1 to 200");

export const ZoneStoresQuerySchema = z.object({
  at: AtSchema.optional(),
  as_of_revision: AsOfRevisionSchema.optional(),
  cursor: CursorSchema.optional(),
  page_size: PageSizeSchema.optional(),
});
export type ZoneStoresQuery = z.infer<typeof ZoneStoresQuerySchema>;

export const StoreMembershipsQuerySchema = z.object({ as_of_revision: AsOfRevisionSchema.optional() });
export type StoreMembershipsQuery = z.infer<typeof StoreMembershipsQuerySchema>;
