/**
 * ConnectorAdoptionService — RT-1557 (RT-1433 slice S1).
 *
 * `platformAdoptConnectorRegistration` of `erpnext-connector/provisioning-feed.yaml`
 * (1.1.0-draft): a platform admin sets `connector_registration.managed_by` to
 * `provisioner` on ONE existing registration, so a registration that was made by hand
 * can be managed by the provisioner without re-provisioning its site.
 *
 * One transaction, in the path tenant's context (the registration table's RLS has no
 * platform-admin branch; the platform-admin check is the `PlatformAdminGuard` on the
 * route): lock the row, decide, write, audit. It never issues, rotates or revokes a
 * credential and never touches the site. Reversible by setting `managed_by` back to NULL.
 *
 * Audit: one `connector.registration.adopted` row in the same transaction, ids and
 * labels only (§XIV). `adopted_by_user_id` in its metadata is the marker that makes a
 * repeat by the same admin a no-op (the metadata key is written by this operation only).
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { insertAuditRowInTransaction, readLatestAuditMetadataWithKey } from "../audit";
import { PG_POOL } from "../database";
import { recordConnectorLifecycle } from "../observability/metrics/api.metrics";

export const ADOPTED_AUDIT_ACTION = "connector.registration.adopted";
const AUDIT_TARGET_TYPE = "connector_registration";
const ADOPTED_BY_KEY = "adopted_by_user_id";

export interface AdoptInput {
  readonly tenantId: string;
  readonly instanceId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
}

export interface AdoptedRegistrationBody {
  readonly outcome: "adopted" | "already_adopted";
  readonly tenantId: string;
  readonly instanceId: string;
  readonly managedBy: "provisioner";
  readonly environment: string;
  readonly erpnextSiteRef: string;
}

export type AdoptResult =
  | { readonly kind: "ok"; readonly body: AdoptedRegistrationBody }
  | { readonly kind: "not_found" }
  | { readonly kind: "disabled" }
  | { readonly kind: "already_managed" };

interface LockedRegistration {
  readonly environment: string;
  readonly erpnext_site_ref: string;
  readonly managed_by: string | null;
  readonly disabled_at: Date | null;
}

export type AdoptionDecision = "adopt" | "already_adopted" | "disabled" | "already_managed";

/**
 * The decision table, pure. A disabled registration is refused first. An unmanaged one is
 * adopted. A managed one is a no-op only for a repeat by the admin that adopted it through
 * this operation; any other managed registration (provisioned, or adopted by someone else)
 * is refused.
 */
export function decideAdoption(input: {
  readonly managedBy: string | null;
  readonly disabled: boolean;
  readonly actorUserId: string;
  readonly adoptedByUserId: string | null;
}): AdoptionDecision {
  if (input.disabled) return "disabled";
  if (input.managedBy === null) return "adopt";
  if (input.managedBy === "provisioner" && input.adoptedByUserId !== null && input.adoptedByUserId === input.actorUserId) {
    return "already_adopted";
  }
  return "already_managed";
}

@Injectable()
export class ConnectorAdoptionService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  adopt(input: AdoptInput): Promise<AdoptResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<AdoptResult> => {
        const row = await lockRegistration(client, input);
        if (row === null) return { kind: "not_found" };

        const decision = decideAdoption({
          managedBy: row.managed_by,
          disabled: row.disabled_at !== null,
          actorUserId: input.actorUserId,
          adoptedByUserId: row.managed_by === null ? null : await priorAdopter(client, input),
        });
        if (decision === "disabled") return { kind: "disabled" };
        if (decision === "already_managed") return { kind: "already_managed" };

        if (decision === "adopt") {
          await client.query(
            `UPDATE connector_registration SET managed_by = 'provisioner'
              WHERE id = $1::uuid AND tenant_id = $2::uuid AND managed_by IS NULL AND disabled_at IS NULL`,
            [input.instanceId, input.tenantId],
          );
          await insertAuditRowInTransaction(client, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            storeId: null,
            action: ADOPTED_AUDIT_ACTION,
            targetType: AUDIT_TARGET_TYPE,
            targetId: input.instanceId,
            requestId: input.requestId,
            metadata: { actor_kind: "platform_admin", [ADOPTED_BY_KEY]: input.actorUserId, managed_by: "provisioner" },
          });
          // Same operational signal as every other connector lifecycle action (never alters the outcome).
          recordConnectorLifecycle();
        }
        return { kind: "ok", body: bodyOf(input, row, decision === "adopt" ? "adopted" : "already_adopted") };
      },
    );
  }
}

async function lockRegistration(client: PoolClient, input: AdoptInput): Promise<LockedRegistration | null> {
  const r = await client.query<LockedRegistration>(
    `SELECT environment, erpnext_site_ref, managed_by, disabled_at
       FROM connector_registration
      WHERE id = $1::uuid AND tenant_id = $2::uuid
        FOR UPDATE`,
    [input.instanceId, input.tenantId],
  );
  return r.rows[0] ?? null;
}

/** The admin recorded by the newest adoption audit row of this registration, or null when none was written. */
async function priorAdopter(client: PoolClient, input: AdoptInput): Promise<string | null> {
  const metadata = await readLatestAuditMetadataWithKey(client, {
    tenantId: input.tenantId,
    targetType: AUDIT_TARGET_TYPE,
    targetId: input.instanceId,
    metadataKey: ADOPTED_BY_KEY,
  });
  const adopter = metadata?.[ADOPTED_BY_KEY];
  return typeof adopter === "string" ? adopter : null;
}

function bodyOf(input: AdoptInput, row: LockedRegistration, outcome: "adopted" | "already_adopted"): AdoptedRegistrationBody {
  return {
    outcome,
    tenantId: input.tenantId,
    instanceId: input.instanceId,
    managedBy: "provisioner",
    environment: row.environment,
    erpnextSiteRef: row.erpnext_site_ref,
  };
}
