/**
 * RT-1298: row shape, mapping, errors and audit helper of the pilot release
 * registry writes (`pilot-release-registry.service.ts`). Kept apart so the
 * service reads as the three operations only.
 */
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import type { PilotReleaseRegistration } from "./dto";

/** A pilot release as the contract's `PilotRelease` schema shows it. */
export interface PilotReleaseBody {
  readonly releaseId: string;
  readonly version: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly publisher: string;
  readonly signingClass: "pilot";
  readonly attestationRef: string;
  readonly sourceSha: string;
  readonly approved: boolean;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly promotionRunUrl: string;
  readonly artifactVersionId: string;
  readonly registeredAt: string;
  readonly withdrawnAt: string | null;
  readonly withdrawnBy: string | null;
  readonly activatedAt: string | null;
  readonly activatedByUserId: string | null;
}

/** The registry row as `pg` returns it. */
export interface ReleaseRow {
  id: string;
  version: string;
  sha256: string;
  size_bytes: string;
  publisher: string;
  signing_class: string;
  attestation_ref: string;
  source_sha: string;
  artifact_key: string;
  artifact_version_id: string;
  approved: boolean;
  approved_at: Date;
  approved_by: string;
  promotion_run_url: string;
  registered_at: Date;
  withdrawn_at: Date | null;
  withdrawn_by: string | null;
  activated_at: Date | null;
  activated_by_user_id: string | null;
}

export const RELEASE_COLUMNS = `id, version, sha256, size_bytes, publisher, signing_class, attestation_ref, source_sha,
  artifact_key, artifact_version_id, approved, approved_at, approved_by, promotion_run_url, registered_at,
  withdrawn_at, withdrawn_by, activated_at, activated_by_user_id`;

/** The release does not exist: 404 `not_found`. */
export class PilotReleaseNotFoundError extends Error {
  constructor() {
    super("pilot release not found");
    this.name = "PilotReleaseNotFoundError";
  }
}

/** The same version, sha256 or object key exists with other values: 409 `release_conflict`. */
export class PilotReleaseConflictError extends Error {
  constructor() {
    super("pilot release conflict");
    this.name = "PilotReleaseConflictError";
  }
}

/** The signing class is not `pilot`, or the publisher carries a lab marker: 422 `release_not_pilot`. */
export class PilotReleaseNotPilotError extends Error {
  constructor() {
    super("release is not a pilot release");
    this.name = "PilotReleaseNotPilotError";
  }
}

/** Activation refused: 409 with this code. */
export class PilotReleaseActivationRefusedError extends Error {
  constructor(readonly code: "release_withdrawn" | "release_current_exists") {
    super(`pilot release activation refused: ${code}`);
    this.name = "PilotReleaseActivationRefusedError";
  }
}

const UNIQUE_VIOLATION = "23505";
const LAB_MARKER = /LAB TEST|NOT FOR PRODUCTION/i;

/** True when `err`, or a `cause` below it, is a PostgreSQL unique violation. */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Refuse a body that is not a pilot release: the class is not `pilot`, or the publisher carries a lab marker. */
export function assertPilotRelease(body: PilotReleaseRegistration): void {
  if (body.signingClass !== "pilot" || LAB_MARKER.test(body.publisher)) throw new PilotReleaseNotPilotError();
}

/** The object key the server derives from the version (the migration's CHECK pins the same shape). */
export function artifactKeyOf(version: string): string {
  return `pos/pilot/${version}/POS-Pulse-Setup-${version}.exe`;
}

/** An ISO string, or null. */
function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** Map a registry row to the contract's `PilotRelease`. */
export function toReleaseBody(row: ReleaseRow): PilotReleaseBody {
  return {
    releaseId: row.id,
    version: row.version,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    publisher: row.publisher,
    signingClass: "pilot",
    attestationRef: row.attestation_ref,
    sourceSha: row.source_sha,
    approved: row.approved,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at.toISOString(),
    promotionRunUrl: row.promotion_run_url,
    artifactVersionId: row.artifact_version_id,
    registeredAt: row.registered_at.toISOString(),
    withdrawnAt: iso(row.withdrawn_at),
    withdrawnBy: row.withdrawn_by,
    activatedAt: iso(row.activated_at),
    activatedByUserId: row.activated_by_user_id,
  };
}

/** True when the stored row holds exactly the values the registration body carries. */
export function holdsRegistration(row: ReleaseRow, body: PilotReleaseRegistration): boolean {
  return [
    row.version === body.version,
    row.sha256 === body.sha256,
    Number(row.size_bytes) === body.sizeBytes,
    row.publisher === body.publisher,
    row.signing_class === body.signingClass,
    row.attestation_ref === body.attestationRef,
    row.source_sha === body.sourceSha,
    row.approved_by === body.approvedBy,
    row.approved_at.getTime() === Date.parse(body.approvedAt),
    row.promotion_run_url === body.promotionRunUrl,
    row.artifact_version_id === body.artifactVersionId,
  ].every(Boolean);
}

/** Who made a registry change: a verified workflow run, or a platform admin. */
export type RegistryActor =
  | { readonly kind: "workflow"; readonly label: string }
  | { readonly kind: "user"; readonly userId: string };

/** The workflow's audit label: its GitHub login only, never a token or a claim set. */
export function workflowActor(actor: string): RegistryActor {
  return { kind: "workflow", label: `github-oidc:${actor}` };
}

/** Write one platform-scoped audit row for an effective registry change, in the caller's transaction. */
export async function auditRegistryChange(
  client: PoolClient,
  change: {
    readonly action: string;
    readonly releaseId: string;
    readonly actor: RegistryActor;
    readonly requestId: string | null;
    readonly metadata: Record<string, unknown>;
  },
): Promise<void> {
  const userId = change.actor.kind === "user" ? change.actor.userId : null;
  const label = change.actor.kind === "workflow" ? change.actor.label : null;
  await client.query(
    `INSERT INTO audit_events (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, $3, NULL, NULL, $4, 'pos_pilot_release', $5, $6, $7::jsonb)`,
    [newId(), userId, label, change.action, change.releaseId, change.requestId, JSON.stringify(change.metadata)],
  );
}
