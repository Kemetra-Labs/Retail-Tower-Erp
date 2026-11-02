/**
 * RT-1069 — request schema of `consoleListLowStock`
 * (`inventory/low-stock.yaml`, RT-1055 LS-4).
 *
 * Two optional keys: `store_id` (a UUID) and `limit` (an integer 1..50,
 * default 10). `.strict()` makes any other key a 400, `cursor` and
 * `page_size` included; a repeated key arrives as an array and is a 400.
 * Every refusal here is a 400 `validation_error`, raised by the pipe after
 * the guards and before any read.
 */
import { z } from "zod";

export const LOW_STOCK_LIMIT_DEFAULT = 10;
export const LOW_STOCK_LIMIT_MAX = 50;

export const ConsoleLowStockQuerySchema = z
  .object({
    store_id: z
      .string()
      .uuid("store_id must be a valid UUID")
      .transform((id) => id.toLowerCase())
      .optional(),
    // A digit string, never `z.coerce`: an array (`limit[]=5`) must not coerce.
    limit: z
      .string()
      .regex(/^\d{1,3}$/, "limit must be an integer")
      .transform(Number)
      .pipe(z.number().int().min(1).max(LOW_STOCK_LIMIT_MAX))
      .optional(),
  })
  .strict();

export type ConsoleLowStockQuery = z.infer<typeof ConsoleLowStockQuerySchema>;
