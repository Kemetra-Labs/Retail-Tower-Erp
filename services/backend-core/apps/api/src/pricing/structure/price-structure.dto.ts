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

/** A path id (bookId, zoneId, storeId): a UUID, any case; else 400 before any read. */
export const PathIdSchema = z.string().uuid();

const AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/;

/** RFC 3339 with an offset, and a real calendar instant (Postgres refuses "02-31", JS rolls it over). */
export function isRfc3339Instant(value: string): boolean {
  const m = AT_PATTERN.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [
    number, number, number, number, number, number,
  ];
  const offsetOk = m[8] === "Z" || (Number(m[9]) <= 23 && Number(m[10]) <= 59);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth &&
    hour <= 23 && minute <= 59 && second <= 59 && offsetOk
  );
}

const AtSchema = z.string().refine(isRfc3339Instant, "must be an RFC 3339 date-time with an offset");
// int64 >= 1, kept within the JS safe range so the response can carry it as a number.
const AsOfRevisionSchema = z
  .string()
  .regex(/^[1-9]\d{0,14}$/, "must be a positive integer")
  .transform((v) => Number(v));
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
