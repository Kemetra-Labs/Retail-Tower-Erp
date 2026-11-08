/**
 * PilotReleaseService: `consolePilotGetLatestPosRelease` (RT-1292;
 * `pos-pilot-releases.openapi.yaml`).
 *
 * The decision itself is `resolveLatestPilotRelease` (pure). This class binds
 * it to the database: ONE transaction under the caller's tenant context
 * (`isPlatformAdmin: false`, the tenant is the session's, never the request's)
 * that reads the tenant's allowlist row and the current pilot release, presigns,
 * and writes the tenant-scoped audit row of an issued link. The read is RLS-
 * scoped (the allowlist shows a tenant only its own row) and the allowlist
 * predicate is explicit as well.
 *
 * The audit row holds `releaseId` and `version` only: never the URL, the object
 * key, a token or an email. It is written in the same transaction, before the
 * URL leaves this class.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import type { ScopedInput } from "../devices/device-caller";
import { recordPosPilotReleaseResolve } from "../observability/metrics/api.metrics";
import type { PilotReleaseConfig } from "./pilot-release.config";
import { PILOT_RELEASE_CONFIG, PILOT_RELEASE_PRESIGNER, type PilotReleasePresigner } from "./pilot-release.presigner";
import {
  resolveLatestPilotRelease,
  type CurrentPilotRelease,
  type LatestPilotRelease,
  type PilotReleaseState,
} from "./pilot-release.resolver";

const DOWNLOAD_LINK_ISSUED_ACTION = "pos.pilot_release.download_link_issued";

export interface ResolvePilotReleaseInput extends ScopedInput {
  readonly requestId: string | null;
}

interface StateRow {
  allowlisted: boolean;
  id: string | null;
  version: string | null;
  sha256: string | null;
  size_bytes: string | null;
  publisher: string | null;
  signing_class: string | null;
  artifact_key: string | null;
  artifact_version_id: string | null;
}

/** The allowlist verdict and the one current (approved and activated) release, in one read. */
const STATE_SQL = `
  SELECT EXISTS (SELECT 1 FROM pos_pilot_tenant_allowlist WHERE tenant_id = $1::uuid) AS allowlisted,
         r.id, r.version, r.sha256, r.size_bytes, r.publisher, r.signing_class,
         r.artifact_key, r.artifact_version_id
    FROM (SELECT 1) AS one
    LEFT JOIN pos_pilot_release_registry r ON r.approved AND r.activated_at IS NOT NULL
   LIMIT 1`;

function toState(row: StateRow | undefined): PilotReleaseState {
  if (row === undefined) return { allowlisted: false, release: null };
  const release: CurrentPilotRelease | null =
    row.id === null ||
    row.version === null ||
    row.sha256 === null ||
    row.size_bytes === null ||
    row.publisher === null ||
    row.signing_class === null ||
    row.artifact_key === null ||
    row.artifact_version_id === null
      ? null
      : {
          id: row.id,
          version: row.version,
          sha256: row.sha256,
          sizeBytes: Number(row.size_bytes),
          publisher: row.publisher,
          signingClass: row.signing_class,
          artifactKey: row.artifact_key,
          artifactVersionId: row.artifact_version_id,
        };
  return { allowlisted: row.allowlisted, release };
}

async function readState(client: PoolClient, tenantId: string): Promise<PilotReleaseState> {
  const res = await client.query<StateRow>(STATE_SQL, [tenantId]);
  return toState(res.rows[0]);
}

async function insertIssuedAudit(
  client: PoolClient,
  input: ResolvePilotReleaseInput,
  release: CurrentPilotRelease,
): Promise<void> {
  const metadata = { releaseId: release.id, version: release.version };
  await client.query(
    `INSERT INTO audit_events (id, actor_user_id, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, $3, NULL, $4, 'pos_pilot_release', $5, $6, $7::jsonb)`,
    [
      newId(),
      input.context.userId,
      input.tenantId,
      DOWNLOAD_LINK_ISSUED_ACTION,
      release.id,
      input.requestId,
      JSON.stringify(metadata),
    ],
  );
}

@Injectable()
export class PilotReleaseService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PILOT_RELEASE_CONFIG) private readonly config: PilotReleaseConfig,
    @Inject(PILOT_RELEASE_PRESIGNER) private readonly presigner: PilotReleasePresigner | null,
  ) {}

  /** The current pilot release and a short-lived URL, or `{ available: false }`. */
  async latest(input: ResolvePilotReleaseInput): Promise<LatestPilotRelease> {
    return await runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) =>
      resolveLatestPilotRelease({
        config: this.config,
        presigner: this.presigner,
        readState: () => readState(client, input.tenantId),
        recordIssued: (release) => insertIssuedAudit(client, input, release),
        recordOutcome: recordPosPilotReleaseResolve,
        now: () => new Date(),
      }),
    );
  }
}
