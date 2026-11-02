/**
 * RT-1066 — request bodies of the console stock-levels writes
 * (`catalog/stock-levels.yaml`; decision record RT-1064 TH-2, TH-4).
 *
 * Every body is `.strict()`: an unknown or server-owned key (a tenant, a
 * store, an actor, a timestamp, a unit) is a 400 `validation_error`, so
 * nothing server-owned can be mass-assigned (§III, §XII). Every refusal here
 * is a 400, raised after the guards (and, on a set, the `Idempotency-Key`
 * check) and before any read.
 *
 * A level is an exact-decimal STRING (`LevelQuantity`): strictly positive, up
 * to 15 integer and 4 fractional digits (`numeric(19,4)`), never a JSON
 * number, so it is never a float and never rounded. The cross-field rule
 * `criticalLevel <= reorderLevel` is NOT checked here: the contract answers it
 * with 422 `critical_above_reorder` after the product and store checks, which
 * the service does (`criticalAboveReorder`).
 */
import { z } from "zod";

import { InstantMillisSchema } from "../console-catalog/console-catalog.write-bodies";

/** The contract's `LevelQuantity` pattern (also `inventory/low-stock.yaml`). */
export const LEVEL_QUANTITY = /^(?!0+(?:\.0+)?$)[0-9]{1,15}(\.[0-9]{1,4})?$/;

const LevelQuantitySchema = z.string().regex(LEVEL_QUANTITY, "must be a positive decimal string, up to 15.4 digits");

export const SetStockLevelBodySchema = z
  .object({
    // Required key: the active level's `updatedAt`, or null when the caller saw none.
    expectedUpdatedAt: InstantMillisSchema.nullable(),
    reorderLevel: LevelQuantitySchema,
    criticalLevel: LevelQuantitySchema.nullable().optional(),
  })
  .strict();
export type SetStockLevelBody = z.infer<typeof SetStockLevelBodySchema>;

export const RetireStockLevelBodySchema = z.object({ expectedUpdatedAt: InstantMillisSchema }).strict();
export type RetireStockLevelBody = z.infer<typeof RetireStockLevelBodySchema>;

/** `value` (a `LevelQuantity`) in ten-thousandths, exact. */
function scaled(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, "0"));
}

/** TH-2: `criticalLevel` above `reorderLevel` (equal is allowed). Exact decimal compare. */
export function criticalAboveReorder(reorderLevel: string, criticalLevel: string | null): boolean {
  return criticalLevel !== null && scaled(criticalLevel) > scaled(reorderLevel);
}
