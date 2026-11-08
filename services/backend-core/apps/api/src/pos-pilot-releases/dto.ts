/**
 * Zod schemas of the RT-1292 pilot release surface
 * (`pos-pilot-releases.openapi.yaml`).
 *
 *   - the console read takes NO query parameter: any key is a 400 (`.strict()`),
 *     checked after the guards and before any read;
 *   - the allowlist routes take a tenant id path parameter and no body.
 *
 * Tenant, user and release identity are never read from a body (§XII).
 */
import { z } from "zod";

export const NoQuerySchema = z.object({}).strict();

export const TenantIdParamSchema = z.string().uuid();
