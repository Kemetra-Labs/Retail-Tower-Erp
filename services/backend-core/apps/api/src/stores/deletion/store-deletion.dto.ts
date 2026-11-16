/**
 * Request schemas of the store deletion surface — RT-1439 (`stores.openapi.yaml`,
 * `console-force-actions.openapi.yaml`). `.strict()`: an unknown key (a `tenant_id`, say) is a 400,
 * and the tenant always comes from the session, never the body. A 400 names the failing keys,
 * never the submitted values, so a password cannot come back in an error.
 */
import { z } from "zod";

const FINGERPRINT = /^[0-9a-f]{16,128}$/;
const REAUTH_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;

export const ReauthRequestSchema = z
  .object({
    purpose: z.literal("store_deletion"),
    storeId: z.string().uuid(),
    password: z.string().min(1).max(1024),
  })
  .strict();
export type ReauthRequest = z.infer<typeof ReauthRequestSchema>;

export const StoreDeletionRequestSchema = z
  .object({
    reason: z.string().min(1).max(200),
    previewFingerprint: z.string().regex(FINGERPRINT),
    reauthToken: z.string().regex(REAUTH_TOKEN),
  })
  .strict();
export type StoreDeletionRequest = z.infer<typeof StoreDeletionRequestSchema>;
