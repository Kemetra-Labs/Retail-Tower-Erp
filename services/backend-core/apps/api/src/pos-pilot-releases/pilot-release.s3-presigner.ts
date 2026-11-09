/**
 * RT-1297: the S3 adapter of the pilot release presigner port
 * (`pilot-release.presigner.ts`).
 *
 * Posture:
 *   - presigning is a LOCAL signature computation: no request goes to S3;
 *   - the lifetime is checked (an integer, 1 to 900 seconds) BEFORE anything is
 *     signed, so a bad value never reaches the SDK;
 *   - the URL pins the verified object `VersionId` and asks S3 to answer with an
 *     attachment content disposition; the file name is reduced to safe
 *     characters, so it cannot add a header parameter;
 *   - the key is given to the SDK explicitly (`pilot-release.s3-settings.ts`):
 *     no profile, no instance role, no ambient `AWS_*` variable can sign;
 *   - a failure is re-thrown as `PilotReleasePresignError` carrying only the SDK
 *     error name: the SDK message and `cause` can quote a credential.
 *
 * The URL is a bearer capability: it is never logged, stored or audited.
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { PilotReleasePresigner, PilotReleasePresignRequest } from "./pilot-release.presigner";
import { resolvePilotReleaseS3Settings, type PilotReleaseS3Refusal } from "./pilot-release.s3-settings";

const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 900;

/** A presign refusal or failure. The message holds a closed description or an SDK error name, never a value. */
export class PilotReleasePresignError extends Error {
  constructor(detail: string) {
    super(`Pilot release presign failed: ${detail}`);
    this.name = "PilotReleasePresignError";
  }
}

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/** The name of a thrown Error when it is a plain identifier, else `UnknownError`; its message (which could quote a secret) is dropped. */
function errorNameOf(err: unknown): string {
  return err instanceof Error && ERROR_NAME.test(err.name) ? err.name : "UnknownError";
}

/** True for an integer lifetime of 1 to 900 seconds. */
function isValidTtl(ttlSeconds: number): boolean {
  return Number.isInteger(ttlSeconds) && ttlSeconds >= MIN_TTL_SECONDS && ttlSeconds <= MAX_TTL_SECONDS;
}

/** The lifetime when valid; anything else is refused, never clamped. */
function checkedTtl(ttlSeconds: number): number {
  if (!isValidTtl(ttlSeconds)) {
    throw new PilotReleasePresignError("the lifetime must be an integer of 1 to 900 seconds");
  }
  return ttlSeconds;
}

/** An RFC 6266 attachment disposition: a plain-ASCII fallback name and the same name as an RFC 5987 value. */
function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Presigns pilot release downloads through an S3 client that holds the explicit pilot key. */
export class S3PilotReleasePresigner implements PilotReleasePresigner {
  constructor(
    private readonly client: S3Client,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A presigned GET for the exact object version; the reported expiry is exactly the signed one. */
  async presignGet(request: PilotReleasePresignRequest): Promise<{ url: string; expiresAt: Date }> {
    const ttlSeconds = checkedTtl(request.ttlSeconds);
    // SigV4 dates have whole-second precision, so the signing date is passed in and the expiry is that
    // instant cut to the second plus the lifetime: the same moment S3 enforces, never a later one.
    const signingDate = this.now();
    const expiresAt = new Date(Math.floor(signingDate.getTime() / 1000) * 1000 + ttlSeconds * 1000);
    try {
      const command = new GetObjectCommand({
        Bucket: request.bucket,
        Key: request.key,
        VersionId: request.versionId,
        ResponseContentDisposition: attachmentDisposition(request.fileName),
      });
      const url = await getSignedUrl(this.client, command, { expiresIn: ttlSeconds, signingDate });
      return { url, expiresAt };
    } catch (err: unknown) {
      throw new PilotReleasePresignError(errorNameOf(err));
    }
  }
}

/** The presigner for the environment, or null with the closed reason it is not bound. */
export function createPilotReleasePresigner(env: Readonly<Record<string, string | undefined>>):
  | { readonly presigner: PilotReleasePresigner; readonly reason: null }
  | { readonly presigner: null; readonly reason: PilotReleaseS3Refusal } {
  const settings = resolvePilotReleaseS3Settings(env);
  if (!settings.ok) return { presigner: null, reason: settings.reason };
  const client = new S3Client({ region: settings.region, credentials: settings.credentials, maxAttempts: 1 });
  return { presigner: new S3PilotReleasePresigner(client), reason: null };
}
