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

/** RT-1298: the release id path parameter of withdraw and activate. */
export const ReleaseIdParamSchema = z.string().uuid();

/** RT-1298: the `Idempotency-Key` header of register (16 to 128 characters of the contract's alphabet). */
export const IdempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const GITHUB_LOGIN = /^[A-Za-z0-9](-?[A-Za-z0-9])*$/;
const ATTESTATION_REF = /^https:\/\/github\.com\/Kemetra-Labs\/Retail-Tower-Erp\/attestations\/[0-9]+$/;
const PROMOTION_RUN_URL = /^https:\/\/github\.com\/Kemetra-Labs\/Retail-Tower-Erp\/actions\/runs\/[0-9]+(\/attempts\/[0-9]+)?$/;
const APP_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

/**
 * RT-1298: the registration body of `platformRegisterPilotRelease`
 * (`PilotReleaseRegistration`). Strict: an unknown key is a 400. `lab` and
 * `production` pass here on purpose: the route refuses them as 422
 * `release_not_pilot`, which is a different answer from a malformed body.
 */
export const PilotReleaseRegistrationSchema = z
  .object({
    version: z.string().min(5).max(32).regex(APP_VERSION),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().min(1).max(2147483648),
    publisher: z.string().min(1).max(200),
    signingClass: z.enum(["lab", "pilot", "production"]),
    attestationRef: z.string().max(200).regex(ATTESTATION_REF),
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
    approvedBy: z.string().min(1).max(39).regex(GITHUB_LOGIN),
    approvedAt: z.string().datetime({ offset: true }),
    promotionRunUrl: z.string().max(200).regex(PROMOTION_RUN_URL),
    artifactVersionId: z.string().min(1).max(1024),
  })
  .strict();

export type PilotReleaseRegistration = z.infer<typeof PilotReleaseRegistrationSchema>;
