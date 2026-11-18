/**
 * SupportSessionGate — the cross-cutting record of a platform admin acting in a tenant.
 *
 * RT-1468 (owner decision 2026-11-18, RT-1468 comment 17463: "the platform admin is the superior in
 * this system; he does not need permissions or obstacles"): a platform admin is ADMITTED to every
 * covered route of any existing tenant, member or not, with or without a support session, and also
 * on a suspended tenant. RT-414's "an active support session is required" and its suspended-tenant
 * read-only rule no longer apply. The support session stays: it is optional attribution (purpose
 * and ticket) and the banner.
 *
 * What the gate still does, for every platform-admin request on a covered route
 * (platform-support-sessions.openapi.yaml, `x-support-session-enforcement`):
 *   1. the tenant does not exist (or is soft-deleted) → 403 `support_session_required`
 *      (the wire code is kept: it is the existing non-disclosing answer, FR-ISO-4);
 *   2. otherwise admitted.
 * Every decision writes exactly one `platform.cross_tenant.accessed` row, in its own transaction
 * that commits BEFORE a refusal is thrown. A failure to write it fails the request (500): no
 * platform-admin request on a covered route runs unaudited. The row names the caller's live
 * support session when it is `active` and for exactly this tenant; an expired one, or one for
 * another tenant, is absent.
 *
 * `support_session_expired` and `support_session_read_only` are no longer returned. They stay in
 * `CrossTenantRefusal` because audit rows written before RT-1468 carry them.
 *
 * RLS: the lookups and the audit insert run under the support-session context (the same site as
 * before; no new platform-admin site, RT-1389 / RT-1457). The route handler still runs with
 * `isPlatformAdmin: false` inside the tenant (RT-142), which this gate does not touch.
 */
import { ForbiddenException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { withSupportSessionCtx } from "./support-session.lifecycle";
import {
  findLiveSupportSession,
  recordCrossTenantAccess,
  type CrossTenantRefusal,
  type SupportSessionRecord,
} from "./support-session.store";
import { UUID_RE_I } from "../common/ids";

const REFUSAL_MESSAGES: Readonly<Record<CrossTenantRefusal, string>> = {
  support_session_required: "An active support session for this tenant is required",
  support_session_expired: "The support session has expired; open a new one",
  support_session_read_only: "The support session is read-only for this tenant",
  origin_rejected: "Request origin is not allowed",
};

export function supportSessionRefusal(reason: CrossTenantRefusal): ForbiddenException {
  return new ForbiddenException({ code: reason, message: REFUSAL_MESSAGES[reason] });
}

export interface GateRequest {
  readonly authSessionId: string;
  readonly userId: string;
  readonly method: string;
  /** Route template, never the concrete path. */
  readonly route: string;
  readonly requestId: string | null;
}

/** The caller's live support session when it is `active` and for exactly `tenantId`, else null. */
function liveSessionFor(
  found: SupportSessionRecord | null,
  tenantId: string,
): SupportSessionRecord | null {
  return found !== null && found.tenantId === tenantId && found.status === "active" ? found : null;
}

export class SupportSessionGate {
  constructor(private readonly pool: Pool) {}

  /**
   * Admit a platform admin (member or not) in `tenantId` and record the request. Returns the live
   * support session for this tenant, or null; throws 403 `support_session_required` (after
   * recording it) when the tenant does not exist.
   */
  async admit(tenantId: string, request: GateRequest): Promise<SupportSessionRecord | null> {
    const verdict = await this.withPlatformCtx(async (client) => {
      const live = liveSessionFor(await findLiveSupportSession(client, request.authSessionId), tenantId);
      const reason: CrossTenantRefusal | undefined = (await tenantExists(client, tenantId))
        ? undefined
        : "support_session_required";
      await recordCrossTenantAccess(client, {
        tenantId,
        actorUserId: request.userId,
        requestId: request.requestId,
        method: request.method,
        route: request.route,
        session: live,
        ...(reason === undefined ? {} : { reason }),
      });
      return { live, reason };
    });
    if (verdict.reason !== undefined) throw supportSessionRefusal(verdict.reason);
    return verdict.live;
  }

  /**
   * A path tenant that is not a UUID or names no tenant (`listMembers`,
   * `updateTenant`): refused exactly like a missing tenant (FR-ISO-4), with its
   * row platform-scoped (`tenant_id` null).
   */
  async refuseUnresolvable(request: GateRequest): Promise<never> {
    await this.withPlatformCtx((client) =>
      recordCrossTenantAccess(client, {
        tenantId: null,
        actorUserId: request.userId,
        requestId: request.requestId,
        method: request.method,
        route: request.route,
        session: null,
        reason: "support_session_required",
      }),
    );
    throw supportSessionRefusal("support_session_required");
  }

  /**
   * RT-430 refused an unsafe request's `Origin` before any tenant logic ran. Record the row the
   * contract's order would have produced: `support_session_required` when the tenant does not
   * exist, else `origin_rejected`, naming the live support session for this tenant when there is
   * one. Returns the refusal the caller should throw.
   */
  async recordOriginRefusal(tenantId: string, request: GateRequest): Promise<ForbiddenException> {
    const reason = await this.withPlatformCtx(async (client) => {
      const live = liveSessionFor(await findLiveSupportSession(client, request.authSessionId), tenantId);
      const refusal: CrossTenantRefusal = (await tenantExists(client, tenantId))
        ? "origin_rejected"
        : "support_session_required";
      await recordCrossTenantAccess(client, {
        tenantId,
        actorUserId: request.userId,
        requestId: request.requestId,
        method: request.method,
        route: request.route,
        session: live,
        reason: refusal,
      });
      return refusal;
    });
    return supportSessionRefusal(reason);
  }

  /**
   * Whether `tenantId` is a UUID naming a tenant row, soft-deleted or not
   * (the `audit_events.tenant_id` FK target). False means the path tenant is
   * unresolvable and its row must be platform-scoped.
   */
  async tenantRowExists(tenantId: string): Promise<boolean> {
    if (!UUID_RE_I.test(tenantId)) return false;
    return await this.withPlatformCtx(async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM tenants WHERE id = $1`, [tenantId]);
      return rows.length > 0;
    });
  }

  private withPlatformCtx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return withSupportSessionCtx(this.pool, work);
  }
}

/** Whether `tenantId` names a tenant that is not soft-deleted (its status does not matter, RT-1468). */
async function tenantExists(client: PoolClient, tenantId: string): Promise<boolean> {
  if (!UUID_RE_I.test(tenantId)) return false;
  const { rows } = await client.query(`SELECT 1 FROM tenants WHERE id = $1 AND deleted_at IS NULL`, [tenantId]);
  return rows.length > 0;
}
