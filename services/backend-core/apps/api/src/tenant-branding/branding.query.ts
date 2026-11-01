/**
 * Zod schemas for the tenant branding operations (tenant-branding.openapi.yaml).
 * Strict: the tenant comes from the session or the device row, never the query
 * (§XII), so an unknown key is a 400 `validation_error` before any work.
 */
import { z } from "zod";

export const PathIdSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

/** `LogoVersion`. */
const VersionSchema = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256");

/** `expected_revision`: an integer ≥ 0, as a query string. */
const RevisionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,14})$/, "must be an integer >= 0")
  .transform(Number);

/** Reads and the preview take no query parameter. */
export const NoQuerySchema = z.object({}).strict();

export const SaveQuerySchema = z.object({ preview_version: VersionSchema, expected_revision: RevisionSchema }).strict();

export const RemoveQuerySchema = z.object({ expected_revision: RevisionSchema }).strict();

/** `If-None-Match`: one strong ETag as this API issues it. */
export const IfNoneMatchSchema = z.string().regex(/^"[0-9a-f]{64}"$/).optional();

export type SaveQuery = z.infer<typeof SaveQuerySchema>;
export type RemoveQuery = z.infer<typeof RemoveQuerySchema>;
