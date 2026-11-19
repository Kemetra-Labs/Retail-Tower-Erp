/**
 * sale-quarantine-ops.dto.ts — Zod schemas for the Console quarantine routes
 * (`sale-sync-ops/sale-sync-ops.yaml` 1.3.0-draft, RT-1312 Phase 3(b)).
 *
 * Scope (tenant) is NEVER read here: it comes from the dashboard session
 * principal (§XII). `.strict()` rejects unknown keys (mass-assignment ban), so
 * a smuggled `tenant_id` or `state` on the write-off body is a 400.
 */
import { z } from "zod";

import { codePointLength, hasNoNul, isWellFormedText, NO_NUL_MESSAGE } from "../../../common/text-validation";

// The cursor is the last page's last quarantine `id`, a UUIDv7 (the runtime
// issues it, `SaleQuarantineService`). Any other version is a 400, so a v1/v4
// value cannot drive an arbitrary page boundary.
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** `QuarantineState` (contract). */
export const QUARANTINE_STATES = ["open", "captured", "already-captured", "written-off"] as const;
export type QuarantineStateValue = (typeof QUARANTINE_STATES)[number];

/** `consoleListQuarantinedSales` query: store filter, state (default `open`), keyset cursor, page size. */
export const QuarantineListQuerySchema = z
  .object({
    store_id: z.string().uuid().optional(),
    state: z.enum(QUARANTINE_STATES).optional(),
    cursor: z
      .string()
      .min(1)
      .max(36, "cursor exceeds the maximum length")
      .regex(UUID_V7_RE, "cursor must be a UUIDv7 quarantine-reference token")
      .optional(),
    page_size: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type QuarantineListQuery = z.infer<typeof QuarantineListQuerySchema>;

/** The `quarantineRef` path parameter: a malformed one is a 400 before any DB hit. */
export const QuarantineRefSchema = z.string().uuid();

/** Maximum write-off note length in code points (contract `QuarantineWriteOffRequest.note`, DB CHECK). */
export const WRITE_OFF_NOTE_MAX = 500;

/**
 * `consoleWriteOffQuarantinedSale` body (decision C3): one required note, 1 to
 * 500 code points (the OpenAPI `maxLength` counts code points, not UTF-16
 * units), no NUL (Postgres refuses it in `text`, 22021) and no lone surrogate.
 * The note is stored as entered.
 */
export const QuarantineWriteOffBodySchema = z
  .object({
    note: z
      .string()
      .min(1)
      .refine(hasNoNul, { message: NO_NUL_MESSAGE })
      .refine(isWellFormedText, { message: "must be well-formed text (no lone surrogate)" })
      .refine((note) => codePointLength(note) <= WRITE_OFF_NOTE_MAX, {
        message: `must be at most ${WRITE_OFF_NOTE_MAX} characters`,
      }),
  })
  .strict();

export type QuarantineWriteOffBody = z.infer<typeof QuarantineWriteOffBodySchema>;
