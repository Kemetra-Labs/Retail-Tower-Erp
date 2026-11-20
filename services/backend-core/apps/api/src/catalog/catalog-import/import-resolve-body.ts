/**
 * RT-1507 (contract `consoleResolveCatalogImportRow`, `consolePublishCatalogImport`): the request bodies and the
 * `rowNumber` path parameter of the review decision and the publish. Every body is `.strict()`: an unknown key is a 400
 * `validation_error`, raised after the guards and before any read.
 */
import { z } from "zod";

import { ExpectedVersionSchema } from "./import-mapping";

/** `update_product` names a product; no other action may. */
export const ResolveBodySchema = z.union([
  z.object({ expectedVersion: ExpectedVersionSchema, action: z.literal("update_product"), productId: z.string().uuid().transform((id) => id.toLowerCase()) }).strict(),
  z.object({ expectedVersion: ExpectedVersionSchema, action: z.enum(["create_new", "exclude", "clear"]) }).strict(),
]);
export type ResolveBody = z.infer<typeof ResolveBodySchema>;

/** The publish body: the version and the `previewHash` the merchant saw. */
export const PublishBodySchema = z
  .object({ expectedVersion: ExpectedVersionSchema, previewHash: z.string().regex(/^sha256:[0-9a-f]{64}$/) })
  .strict();
export type PublishBody = z.infer<typeof PublishBodySchema>;

/** The source row number: an integer from 2 (row 1 is the header) to the sheet maximum, as digits. */
export const RowNumberSchema = z
  .string()
  .regex(/^\d{1,7}$/)
  .transform((digits) => Number.parseInt(digits, 10))
  .refine((n) => n >= 2 && n <= 1_048_576);
