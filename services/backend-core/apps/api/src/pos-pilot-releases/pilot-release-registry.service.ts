/**
 * PilotReleaseRegistryService: the runtime of `platformRegisterPilotRelease`,
 * `platformWithdrawPilotRelease` and `platformActivatePilotRelease` (RT-1298;
 * `pos-pilot-releases.openapi.yaml`).
 *
 * Every operation is ONE transaction under `{ tenantId: null, isPlatformAdmin:
 * true }`, the context the migration's insert and update policies require, and
 * every effective change writes ONE platform-scoped audit row in it. A replay
 * that changes nothing writes nothing:
 *
 *   - register: a new row is 201; a body equal to the stored row is 200; the same
 *     version, sha256 or object key with any other value is `release_conflict`;
 *     a lab or production class or a lab-marked publisher is `release_not_pilot`.
 *     The object key is derived here from the version, never taken from a body;
 *   - withdraw: sets `approved` to false for good (a withdrawn release is never
 *     re-approved); withdrawing a withdrawn release is a no-op;
 *   - activate: makes one approved release the current one. At most one is
 *     current (a unique index), so another current release, or a withdrawn
 *     target, is refused; activating the current release again is a no-op;
 *   - supersedeCurrent (RT-1418): the promotion run that registered a release
 *     (the keeper) withdraws the release that is current at that moment, never
 *     the keeper, so a platform admin can then activate the keeper. Only a
 *     keeper of the token's own run, still approved, and strictly newer than
 *     the current release; nothing current (or the keeper itself current) is a
 *     no-op. It never activates anything: roll-forward only.
 *
 * `list` (RT-1328, `platformListPilotReleases`) reads every row, newest
 * `registeredAt` first, in the same platform context; it writes nothing.
 *
 * Backend-Core does not verify the attestation or download the object: the
 * promotion workflow did that before it called (D-5).
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../database";
import type { PilotReleaseRegistration } from "./dto";
import {
  PilotReleaseActivationRefusedError,
  PilotReleaseConflictError,
  PilotReleaseNotFoundError,
  PilotReleaseNotOwnedError,
  PilotReleaseSupersedeRefusedError,
  RELEASE_COLUMNS,
  artifactKeyOf,
  assertPilotRelease,
  auditRegistryChange,
  holdsRegistration,
  isNewerVersion,
  isRunOf,
  isUniqueViolation,
  toReleaseBody,
  workflowActor,
  type PilotReleaseBody,
  type ReleaseRow,
} from "./pilot-release-registry.rows";

const PLATFORM = { tenantId: null, isPlatformAdmin: true } as const;

export interface RegisterInput {
  readonly body: PilotReleaseRegistration;
  /** The verified workflow's GitHub login. */
  readonly actor: string;
  readonly requestId: string | null;
}

export interface WithdrawInput {
  readonly releaseId: string;
  readonly actor: string;
  /** The verified workflow run, as its url (for the audit row). */
  readonly runUrl: string;
  readonly requestId: string | null;
}

export interface SupersedeInput {
  /** The keeper: the release the calling run registered; it is never withdrawn here. */
  readonly releaseId: string;
  readonly actor: string;
  /** The verified workflow run, as its url: the keeper must name it, and the audit row records it. */
  readonly runUrl: string;
  readonly requestId: string | null;
}

/** RT-1418: the keeper as it stands, and the release withdrawn for it (null when none was current). */
export interface SupersedeResult {
  readonly keeper: PilotReleaseBody;
  readonly withdrawn: PilotReleaseBody | null;
}

export interface ActivateInput {
  readonly releaseId: string;
  /** The platform admin (`users.id`). */
  readonly userId: string;
  readonly requestId: string | null;
}

/** Read and lock one release row, or throw not-found. */
async function lockRelease(client: PoolClient, releaseId: string): Promise<ReleaseRow> {
  const res = await client.query<ReleaseRow>(`SELECT ${RELEASE_COLUMNS} FROM pos_pilot_release_registry WHERE id = $1::uuid FOR UPDATE`, [
    releaseId,
  ]);
  const row = res.rows[0];
  if (row === undefined) throw new PilotReleaseNotFoundError();
  return row;
}

/** Withdraw one approved, locked row and write its audit row; `extra` is added to the audit metadata. */
async function withdrawLocked(
  client: PoolClient,
  row: ReleaseRow,
  who: { readonly actor: string; readonly runUrl: string; readonly requestId: string | null },
  extra: Record<string, unknown> = {},
): Promise<PilotReleaseBody> {
  const updated = await client.query<ReleaseRow>(
    `UPDATE pos_pilot_release_registry
        SET approved = false, withdrawn_at = now(), withdrawn_by = $2
      WHERE id = $1::uuid
      RETURNING ${RELEASE_COLUMNS}`,
    [row.id, who.actor],
  );
  const withdrawn = updated.rows[0] as ReleaseRow;
  await auditRegistryChange(client, {
    action: "pos.pilot_release.withdrawn",
    releaseId: withdrawn.id,
    actor: workflowActor(who.actor),
    requestId: who.requestId,
    metadata: { releaseId: withdrawn.id, version: withdrawn.version, withdrawnBy: who.actor, promotionRunUrl: who.runUrl, ...extra },
  });
  return toReleaseBody(withdrawn);
}

/** Insert the release, or return null when its version, sha256 or object key already exists. */
async function insertRelease(client: PoolClient, id: string, body: PilotReleaseRegistration): Promise<ReleaseRow | null> {
  const res = await client.query<ReleaseRow>(
    `INSERT INTO pos_pilot_release_registry
       (id, version, sha256, size_bytes, publisher, signing_class, attestation_ref, source_sha, artifact_key,
        artifact_version_id, approved_at, approved_by, promotion_run_url)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13)
     ON CONFLICT DO NOTHING
     RETURNING ${RELEASE_COLUMNS}`,
    [
      id,
      body.version,
      body.sha256,
      body.sizeBytes,
      body.publisher,
      body.signingClass,
      body.attestationRef,
      body.sourceSha,
      artifactKeyOf(body.version),
      body.artifactVersionId,
      // Millisecond precision on both sides: the stored value is what an equal replay is compared with.
      new Date(body.approvedAt).toISOString(),
      body.approvedBy,
      body.promotionRunUrl,
    ],
  );
  return res.rows[0] ?? null;
}

/** The stored rows that clash with the body on version, sha256 or object key. */
async function findClashing(client: PoolClient, body: PilotReleaseRegistration): Promise<ReleaseRow[]> {
  const res = await client.query<ReleaseRow>(
    `SELECT ${RELEASE_COLUMNS} FROM pos_pilot_release_registry
      WHERE version = $1 OR sha256 = $2 OR artifact_key = $3`,
    [body.version, body.sha256, artifactKeyOf(body.version)],
  );
  return res.rows;
}

/** Registers, withdraws and activates pilot releases; see the file comment. */
@Injectable()
export class PilotReleaseRegistryService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Register a release: `created` is false when the body equals the stored row (nothing written). */
  async register(input: RegisterInput): Promise<{ created: boolean; release: PilotReleaseBody }> {
    assertPilotRelease(input.body);
    return await runWithTenantContext(this.pool, PLATFORM, async (client) => {
      const inserted = await insertRelease(client, newId(), input.body);
      if (inserted !== null) {
        await auditRegistryChange(client, {
          action: "pos.pilot_release.registered",
          releaseId: inserted.id,
          actor: workflowActor(input.actor),
          requestId: input.requestId,
          metadata: { releaseId: inserted.id, ...input.body },
        });
        return { created: true, release: toReleaseBody(inserted) };
      }
      const clashing = await findClashing(client, input.body);
      const stored = clashing.length === 1 ? clashing[0] : undefined;
      if (stored === undefined || !holdsRegistration(stored, input.body)) throw new PilotReleaseConflictError();
      return { created: false, release: toReleaseBody(stored) };
    });
  }

  /** Withdraw a release for good; withdrawing a withdrawn release writes nothing. */
  async withdraw(input: WithdrawInput): Promise<PilotReleaseBody> {
    return await runWithTenantContext(this.pool, PLATFORM, async (client) => {
      const row = await lockRelease(client, input.releaseId);
      if (!row.approved) return toReleaseBody(row);
      return await withdrawLocked(client, row, input);
    });
  }

  /**
   * RT-1418: withdraw the release that is current, other than the keeper, for the keeper's own run. One transaction:
   * the keeper and the current row are locked, so a racing activation waits or is refused by the unique index.
   */
  async supersedeCurrent(input: SupersedeInput): Promise<SupersedeResult> {
    return await runWithTenantContext(this.pool, PLATFORM, async (client) => {
      const keeper = await lockRelease(client, input.releaseId);
      if (!isRunOf(keeper.promotion_run_url, input.runUrl)) throw new PilotReleaseNotOwnedError();
      if (!keeper.approved) throw new PilotReleaseSupersedeRefusedError("release_withdrawn");
      const current = await client.query<ReleaseRow>(
        `SELECT ${RELEASE_COLUMNS} FROM pos_pilot_release_registry
          WHERE approved AND activated_at IS NOT NULL AND id <> $1::uuid
          FOR UPDATE`,
        [keeper.id],
      );
      const row = current.rows[0];
      if (row === undefined) return { keeper: toReleaseBody(keeper), withdrawn: null };
      if (!isNewerVersion(keeper.version, row.version)) throw new PilotReleaseSupersedeRefusedError("release_not_newer");
      const withdrawn = await withdrawLocked(client, row, input, { supersededBy: keeper.id });
      return { keeper: toReleaseBody(keeper), withdrawn };
    });
  }

  /** Every registry row, newest `registeredAt` first (RT-1328); a read, no audit row. */
  async list(): Promise<PilotReleaseBody[]> {
    return await runWithTenantContext(this.pool, PLATFORM, async (client) => {
      const res = await client.query<ReleaseRow>(
        `SELECT ${RELEASE_COLUMNS} FROM pos_pilot_release_registry ORDER BY registered_at DESC, id DESC`,
      );
      return res.rows.map(toReleaseBody);
    });
  }

  /** Make the release the current one; activating the current release again writes nothing. */
  async activate(input: ActivateInput): Promise<PilotReleaseBody> {
    try {
      return await runWithTenantContext(this.pool, PLATFORM, (client) => this.activateIn(client, input));
    } catch (err) {
      // Two activations racing: the unique index lets one win and refuses the other.
      if (isUniqueViolation(err)) throw new PilotReleaseActivationRefusedError("release_current_exists");
      throw err;
    }
  }

  /** The activation, inside the caller's transaction. */
  private async activateIn(client: PoolClient, input: ActivateInput): Promise<PilotReleaseBody> {
    const row = await lockRelease(client, input.releaseId);
    if (!row.approved) throw new PilotReleaseActivationRefusedError("release_withdrawn");
    if (row.activated_at !== null) return toReleaseBody(row);
    const other = await client.query(
      `SELECT 1 FROM pos_pilot_release_registry WHERE approved AND activated_at IS NOT NULL AND id <> $1::uuid`,
      [input.releaseId],
    );
    if ((other.rowCount ?? 0) > 0) throw new PilotReleaseActivationRefusedError("release_current_exists");
    const updated = await client.query<ReleaseRow>(
      `UPDATE pos_pilot_release_registry
          SET activated_at = now(), activated_by_user_id = $2::uuid
        WHERE id = $1::uuid
        RETURNING ${RELEASE_COLUMNS}`,
      [input.releaseId, input.userId],
    );
    const activated = updated.rows[0] as ReleaseRow;
    await auditRegistryChange(client, {
      action: "pos.pilot_release.activated",
      releaseId: activated.id,
      actor: { kind: "user", userId: input.userId },
      requestId: input.requestId,
      metadata: { releaseId: activated.id, version: activated.version },
    });
    return toReleaseBody(activated);
  }
}
