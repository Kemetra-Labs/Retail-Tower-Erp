/**
 * Jira RT-451 slice S2 — the TLV request body (`ValidateTrackedLineRequest`,
 * `pos-sales/tracked-lines.yaml` 1.0.0-draft).
 *
 * Strict at every level (`additionalProperties: false`): an unknown key, a
 * body-supplied tenant, store, terminal or actor, or a malformed `identity` is
 * the 400 `validation_error`, and no validation record is written. Whether
 * `operatorUserId` may be present is NOT checked here: its presence selects the
 * device path (`TrackedLineValidationAuthGuard`), so a wrong-path claim is the
 * generic 401, never a 400.
 */
import { z } from "zod";

import { TRACKED_LINE_SELECTIONS } from "@data-pulse-2/db/schema";

import { hasNoNul, maxCodePoints, NO_NUL_MESSAGE, wellFormedText } from "../../../common/text-validation";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when `YYYY-MM-DD` names a day that exists (no 2027-02-30), years 0001–9999. */
export function isRealDay(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC maps years 0–99 to 1900–1999; set the full year explicitly.
  parsed.setUTCFullYear(year);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

const calendarDate = z.string().refine(isRealDay, "must be a real YYYY-MM-DD date");

/**
 * Text bounded in code points (JSON Schema `maxLength` and the column's
 * `char_length`), with no NUL (RT-612: Postgres refuses it) and no lone
 * surrogate, so a bad value is the 400 before anything is read.
 */
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .refine(hasNoNul, NO_NUL_MESSAGE)
    .superRefine(wellFormedText)
    .superRefine(maxCodePoints(max));

/**
 * `TrackedLineIdentityRef`: exactly one of `identityId` and `code`, and
 * `expiryDate` only with `code`.
 */
const IdentityRefSchema = z
  .object({
    identityId: z.string().uuid().optional(),
    code: boundedText(128).optional(),
    expiryDate: calendarDate.optional(),
  })
  .strict()
  .superRefine((ref, ctx) => {
    if ((ref.identityId === undefined) === (ref.code === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "exactly one of identityId and code is required" });
    }
    if (ref.expiryDate !== undefined && ref.code === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expiryDate"], message: "expiryDate is allowed only with code" });
    }
  });

export const ValidateTrackedLineRequestSchema = z
  .object({
    productId: z.string().uuid(),
    identity: IdentityRefSchema,
    // Strictly positive, at most 13 integer and 6 fractional digits (numeric(19,6)).
    quantity: z
      .string()
      .regex(/^(?!0+(?:\.0+)?$)[0-9]{1,13}(\.[0-9]{1,6})?$/, "must be a strictly positive decimal string"),
    selection: z.enum(TRACKED_LINE_SELECTIONS),
    draftLineRef: boundedText(100),
    operatorUserId: z.string().uuid().optional(),
  })
  .strict();

export type ValidateTrackedLineRequest = z.infer<typeof ValidateTrackedLineRequestSchema>;
