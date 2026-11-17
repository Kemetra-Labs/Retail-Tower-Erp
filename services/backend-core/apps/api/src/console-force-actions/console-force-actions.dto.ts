/**
 * Request schemas of the Console force-action routes (RT-1445;
 * `console-force-actions.openapi.yaml`). Strict: an unknown key (a total, a
 * user id, a scope field) is a 400. The actor, the time, the tenant and the
 * store come from the session and the shift, never from the body.
 */
import { z } from "zod";

import { ForceCloseShiftRequestSchema, ShiftIdParamSchema } from "../pos-shifts/shift-cash-up.dto";

export { ShiftIdParamSchema };

/** `store_id` path parameter: a malformed id is a 400, never a database error. */
export const StoreIdParamSchema = z.string().uuid();

/** `ConsoleForceCloseRequest`: the reason (the POS rule: 1 to 200 characters) and the previewed state's digest. */
export const ConsoleForceCloseRequestSchema = z
  .object({
    forcedReason: ForceCloseShiftRequestSchema.shape.forcedReason,
    previewFingerprint: z.string().regex(/^[0-9a-f]{16,128}$/),
  })
  .strict();

export type ConsoleForceCloseRequestDto = z.infer<typeof ConsoleForceCloseRequestSchema>;
