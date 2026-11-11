/**
 * Zod schemas for the RT-367 Console pairing codes (`devices.openapi.yaml`:
 * `consoleIssuePairingCode`, `consoleListPairingCodes`,
 * `consoleCancelPairingCode`).
 *
 * Mirrors the contract. The tenant, the actor and the kind (pair / replace /
 * move) are NEVER read here: the tenant and actor come from the session
 * (§XII), the kind from the stores. `.strict()` rejects an unknown key (400).
 * Ids are normalised to lower case.
 */
import { z } from "zod";

const UuidSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

/** Not blank, no NUL (Postgres `text` refuses U+0000; the 0024 CHECKs refuse blanks). */
const text = (max: number): z.ZodType<string> =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/\S/, "must not be blank")
    .refine((value) => !value.includes("\u0000"), "must not contain a NUL character");

/**
 * 24 h, the maximum (RT-1316): a code is often issued at the office and typed
 * at the till hours later, so the former 60-minute default expired too often.
 * Mirrors `ttlMinutes.default` in `devices.openapi.yaml`.
 */
export const TTL_MINUTES_DEFAULT = 1440;

export const PairingCodeIssueBodySchema = z
  .object({
    storeId: UuidSchema,
    terminalLabel: text(64).optional(),
    ttlMinutes: z.number().int().min(1).max(1440).optional(),
    replacesDeviceId: UuidSchema.optional(),
    branchName: text(256),
    branchAddress: text(512),
    taxRegistrationId: text(64),
  })
  .strict();

export type PairingCodeIssueBody = z.infer<typeof PairingCodeIssueBodySchema>;

export const PairingCodeListQuerySchema = z
  .object({
    store_id: UuidSchema.optional(),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/, "cursor must be an opaque continuation token")
      .optional(),
    page_size: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type PairingCodeListQuery = z.infer<typeof PairingCodeListQuerySchema>;

export const PairingCodeIdParamSchema = UuidSchema;
