/**
 * RT-1292: the pilot release resolver's decision, free of Nest and the
 * database so the rules are testable on their own.
 *
 * A release is returned only when every condition holds, checked in this
 * order: the lane is configured and a presigner is wired · the tenant is
 * allowlisted · a current release exists (approved and activated) · its stored
 * class is `pilot` · its publisher equals the configured pilot pin. Anything
 * else is `{ available: false }` with no reason and no other key; the reason
 * goes to a bounded metric label only. There is no fallback to another version.
 *
 * A presign or audit failure is an error, never `available:false`: that would
 * hide a broken bucket or audit write as "no release". The audit row is written
 * only after the URL exists, and the URL is returned only after that row is
 * written.
 */
import type { PilotReleaseConfig } from "./pilot-release.config";
import type { PilotReleasePresigner } from "./pilot-release.presigner";

export type PilotReleaseOutcome =
  | "issued"
  | "none_not_configured"
  | "none_not_allowlisted"
  | "none_no_current_release"
  | "none_class_mismatch"
  | "none_pin_mismatch";

/** The one current pilot release (approved and activated), as stored. */
export interface CurrentPilotRelease {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly publisher: string;
  readonly signingClass: string;
  readonly artifactKey: string;
  readonly artifactVersionId: string;
}

export interface PilotReleaseState {
  readonly allowlisted: boolean;
  readonly release: CurrentPilotRelease | null;
}

export interface PilotReleaseDeps {
  readonly config: PilotReleaseConfig;
  readonly presigner: PilotReleasePresigner | null;
  /** One read of the allowlist and the current release, in the caller's tenant context. */
  readState(): Promise<PilotReleaseState>;
  /** Writes the tenant-scoped audit row of an issued link; never given the URL. */
  recordIssued(release: CurrentPilotRelease): Promise<void>;
  /** Increments `pos_pilot_release_resolve_total{outcome}`. */
  recordOutcome(outcome: PilotReleaseOutcome): void;
  now(): Date;
}

interface PilotReleaseDownload {
  readonly available: true;
  readonly version: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly fileName: string;
  readonly expectedPublisher: string;
  readonly downloadUrl: string;
  readonly expiresAt: string;
}

export type LatestPilotRelease = { readonly available: false } | PilotReleaseDownload;

const UNAVAILABLE: LatestPilotRelease = Object.freeze({ available: false });

/** The file name derived from the version on the server; never a stored URL. */
function pilotFileName(version: string): string {
  return `POS-Pulse-Setup-${version}.exe`;
}

/** Record the outcome and answer the one closed `available: false` body. */
function none(deps: PilotReleaseDeps, outcome: PilotReleaseOutcome): LatestPilotRelease {
  deps.recordOutcome(outcome);
  return UNAVAILABLE;
}

/** The first failing condition on the stored release, or null when it is eligible. */
function ineligibility(release: CurrentPilotRelease | null, publisher: string): PilotReleaseOutcome | null {
  if (release === null) return "none_no_current_release";
  if (release.signingClass !== "pilot") return "none_class_mismatch";
  if (release.publisher !== publisher) return "none_pin_mismatch";
  return null;
}

/** Decide whether the caller may download the current pilot release; the module comment gives the order of the checks. */
export async function resolveLatestPilotRelease(deps: PilotReleaseDeps): Promise<LatestPilotRelease> {
  const { config, presigner } = deps;
  if (!config.enabled || presigner === null) return none(deps, "none_not_configured");

  const state = await deps.readState();
  if (!state.allowlisted) return none(deps, "none_not_allowlisted");
  const refusal = ineligibility(state.release, config.publisher);
  if (refusal !== null || state.release === null) return none(deps, refusal ?? "none_no_current_release");

  const release = state.release;
  const fileName = pilotFileName(release.version);
  const presigned = await presigner.presignGet({
    bucket: config.bucket,
    key: release.artifactKey,
    versionId: release.artifactVersionId,
    fileName,
    ttlSeconds: config.urlTtlSeconds,
  });
  await deps.recordIssued(release);
  deps.recordOutcome("issued");
  return {
    available: true,
    version: release.version,
    sha256: release.sha256,
    sizeBytes: release.sizeBytes,
    fileName,
    expectedPublisher: config.publisher,
    downloadUrl: presigned.url,
    expiresAt: presigned.expiresAt.toISOString(),
  };
}
