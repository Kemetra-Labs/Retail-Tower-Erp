/**
 * RT-1292: the port through which the pilot resolver obtains a short-lived
 * download URL. RT-1297 binds the S3 adapter (`pilot-release.s3-presigner.ts`)
 * when the pilot S3 key is complete; otherwise the module provides `null` and
 * the resolver answers `available:false`.
 *
 * A presigned URL is a bearer capability: callers never log it, store it or
 * write it to an audit row.
 */

export interface PilotReleasePresignRequest {
  readonly bucket: string;
  /** The object key from the registry row; never taken from a request. */
  readonly key: string;
  /** The verified S3 object version the URL must serve. */
  readonly versionId: string;
  /** The file name the browser saves the object under. */
  readonly fileName: string;
  /** Lifetime in seconds, already bounded by the configuration (1 … 900). */
  readonly ttlSeconds: number;
}

interface PilotReleasePresigned {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface PilotReleasePresigner {
  presignGet(request: PilotReleasePresignRequest): Promise<PilotReleasePresigned>;
}

/** DI token of the presigner; `null` unless the pilot S3 key is complete (RT-1297). */
export const PILOT_RELEASE_PRESIGNER = Symbol("PILOT_RELEASE_PRESIGNER");
/** DI token of the resolved lane configuration. */
export const PILOT_RELEASE_CONFIG = Symbol("PILOT_RELEASE_CONFIG");
