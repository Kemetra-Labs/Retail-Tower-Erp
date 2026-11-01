/**
 * Membership role hierarchy (Jira RT-1028; owner-ratified RT-132 D1–D5a,
 * RT-132 comment 10674; owner decision 2026-11-01 "RT-132 D2").
 *
 *   D1  rank: owner > tenant_admin > store_manager > store_staff.
 *       `platform_admin` is never a membership role (refused as 400 earlier).
 *   D2  an owner may grant, change or revoke anyone, other owners included.
 *       A tenant_admin may manage tenant_admin peers and lower roles, but may
 *       never invite an owner, promote anyone to owner, or change or revoke an
 *       owner. No other role manages memberships.
 *   D3  a tenant keeps at least one active owner: revoking or demoting the
 *       last one is refused, even when that owner does it.
 *   D4  no actor changes its own role or store access (any self PATCH is
 *       refused). Self-revoke is allowed, subject to D3.
 *   D5a an owner membership is always `store_access_kind='all'`.
 *
 * A platform-admin session (break-glass) skips the actor checks (D2, D4) but
 * not the tenant invariants (D3, D5a): those hold for every actor.
 *
 * Every refusal is a 403 (`forbidden` envelope, the status the contract
 * already declares) and writes ONE `audit_events` row in its own
 * transaction, after the refused one has ended (`auditRefusal`). A failed
 * audit write is logged and the 403 still stands. `@Auditable` runs only on
 * success, so the sale-history `outcome: "refused"` precedent is followed.
 */
import { ForbiddenException, Injectable } from "@nestjs/common";
import { newId } from "@data-pulse-2/shared";
import type { Logger } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import { createApiLogger } from "../common/api-logger";
import { MembershipRepository } from "../context/membership.repository";
import type { ResolvedContext } from "../context/types";

export const OWNER_ROLE_CODE = "owner";
const TENANT_ADMIN_ROLE_CODE = "tenant_admin";

/** D1. Higher is more senior. Only owner and tenant_admin manage memberships. */
export const MEMBERSHIP_ROLE_RANK: Readonly<Record<string, number>> = {
  owner: 4,
  tenant_admin: 3,
  store_manager: 2,
  store_staff: 1,
};

export const MEMBERSHIP_REFUSED_AUDIT_ACTION = "membership.change_refused";

export type MembershipRefusalReason =
  | "actor_not_authorized"
  | "owner_managed_by_owner_only"
  | "self_change"
  | "owner_requires_all_stores"
  | "last_owner";

export type MembershipOperation = "membership.update" | "membership.revoke" | "invitation.create";

const REFUSAL_MESSAGES: Readonly<Record<MembershipRefusalReason, string>> = {
  actor_not_authorized: "Insufficient role.",
  owner_managed_by_owner_only: "Only an owner can grant, change or revoke the owner role.",
  self_change: "You cannot change your own role or store access.",
  owner_requires_all_stores: "An owner membership must have access to all stores.",
  last_owner: "A tenant must keep at least one active owner.",
};


export interface MembershipActor {
  readonly userId: string | null;
  /** The actor's active role code in the tenant; null when it has none. */
  readonly roleCode: string | null;
  readonly isPlatformAdmin: boolean;
}

export interface MembershipTarget {
  readonly userId: string;
  readonly roleCode: string;
}

/** The grant a change would leave behind (effective role and store-access kind). */
export interface MembershipGrant {
  readonly roleCode: string;
  readonly storeAccessKind: string;
}

/** D2: may this actor manage memberships at all, and owner memberships in particular? */
function actorRefusal(actor: MembershipActor, touchesOwner: boolean): MembershipRefusalReason | null {
  if (actor.isPlatformAdmin) return null;
  if (actor.roleCode === OWNER_ROLE_CODE) return null;
  if (actor.roleCode !== TENANT_ADMIN_ROLE_CODE) return "actor_not_authorized";
  return touchesOwner ? "owner_managed_by_owner_only" : null;
}

function isSelf(actor: MembershipActor, target: MembershipTarget): boolean {
  return !actor.isPlatformAdmin && actor.userId !== null && actor.userId === target.userId;
}

/** PATCH: `next` is the post-change grant (`dto ?? existing`). */
export function membershipUpdateRefusal(
  actor: MembershipActor,
  target: MembershipTarget,
  next: MembershipGrant,
  activeOwnerCount: number,
): MembershipRefusalReason | null {
  const touchesOwner = target.roleCode === OWNER_ROLE_CODE || next.roleCode === OWNER_ROLE_CODE;
  const byActor = actorRefusal(actor, touchesOwner);
  if (byActor) return byActor;
  if (isSelf(actor, target)) return "self_change";
  if (next.roleCode === OWNER_ROLE_CODE && next.storeAccessKind !== "all") return "owner_requires_all_stores";
  const demotesOwner = target.roleCode === OWNER_ROLE_CODE && next.roleCode !== OWNER_ROLE_CODE;
  if (demotesOwner && activeOwnerCount <= 1) return "last_owner";
  return null;
}

/** DELETE: self-revoke is allowed (D4), subject to the last-owner rule (D3). */
export function membershipRevokeRefusal(
  actor: MembershipActor,
  target: MembershipTarget,
  activeOwnerCount: number,
): MembershipRefusalReason | null {
  const isOwner = target.roleCode === OWNER_ROLE_CODE;
  const byActor = isSelf(actor, target) ? null : actorRefusal(actor, isOwner);
  if (byActor) return byActor;
  if (isOwner && activeOwnerCount <= 1) return "last_owner";
  return null;
}

/** Invite: the grant the invitation would create on acceptance. */
export function invitationRefusal(actor: MembershipActor, grant: MembershipGrant): MembershipRefusalReason | null {
  const byActor = actorRefusal(actor, grant.roleCode === OWNER_ROLE_CODE);
  if (byActor) return byActor;
  if (grant.roleCode === OWNER_ROLE_CODE && grant.storeAccessKind !== "all") return "owner_requires_all_stores";
  return null;
}

/** One refusal's audit payload: identifiers and categories only, never an email (Constitution §XIV). */
export interface MembershipRefusalAudit {
  readonly operation: MembershipOperation;
  readonly reason: MembershipRefusalReason;
  readonly targetMembershipId: string | null;
  readonly targetRoleCode: string | null;
  readonly requestedRoleCode: string | null;
  readonly requestedStoreAccessKind: string | null;
}

let logger: Logger | null = null;
function log(): Logger {
  logger ??= createApiLogger("memberships");
  return logger;
}

/**
 * Write a refusal's audit row through `run` (a fresh tenant transaction).
 * A failed write is logged with categories only and swallowed: the caller
 * rethrows the refusal, so the client still gets the 403 and nothing changed.
 */
export async function auditRefusal(
  run: (work: (client: PoolClient) => Promise<void>) => Promise<void>,
  hierarchy: MembershipHierarchy,
  ctx: ResolvedContext,
  refusal: MembershipChangeRefusedError,
): Promise<void> {
  try {
    await run((client) => hierarchy.recordRefusal(client, ctx, refusal.audit));
  } catch (err: unknown) {
    const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
    log().error(
      { operation: refusal.audit.operation, reason: refusal.audit.reason, tenant_id: ctx.tenantId, code },
      "membership.refusal_audit_failed",
    );
  }
}

/** A 403 carrying its audit payload, so the caller can audit it after the rollback. */
export class MembershipChangeRefusedError extends ForbiddenException {
  constructor(readonly audit: MembershipRefusalAudit) {
    super(REFUSAL_MESSAGES[audit.reason]);
  }
}

/** The DB side of the hierarchy: actor role, the owner-set lock, refusal audit. */
@Injectable()
export class MembershipHierarchy {
  constructor(private readonly contextMemberships: MembershipRepository) {}

  /** The actor's active role code in the request's tenant, read in the caller's transaction. */
  async actorFor(client: PoolClient, ctx: ResolvedContext): Promise<MembershipActor> {
    const roleCode =
      ctx.userId && ctx.tenantId
        ? await this.contextMemberships.findRoleCodeForUserInTenant(ctx.userId, ctx.tenantId, client)
        : null;
    return { userId: ctx.userId, roleCode, isPlatformAdmin: ctx.isPlatformAdmin };
  }

  /**
   * Lock the tenant's active owner memberships `FOR UPDATE` and return how
   * many there are. Every membership writer (PATCH, DELETE) takes this lock
   * first, in id order, and only then locks its target row, so two writers
   * never deadlock. A concurrent revoke or demotion of another owner waits
   * here, and Postgres re-checks the row against the WHERE once it is
   * released, so the second caller counts the first one's result (READ
   * COMMITTED, the server default).
   */
  async lockActiveOwnerCount(client: PoolClient, tenantId: string): Promise<number> {
    const res = await client.query<{ id: string }>(
      `SELECT m.id
         FROM memberships m
        WHERE m.tenant_id = $1
          AND m.revoked_at IS NULL
          AND m.deleted_at IS NULL
          AND m.role_id IN (SELECT r.id FROM roles r WHERE r.tenant_id = $1 AND r.code = $2)
        ORDER BY m.id
          FOR UPDATE OF m`,
      [tenantId, OWNER_ROLE_CODE],
    );
    return res.rows.length;
  }

  /** Write the refusal's audit row; run in its own transaction after the refused one rolled back. */
  async recordRefusal(client: PoolClient, ctx: ResolvedContext, event: MembershipRefusalAudit): Promise<void> {
    const metadata = {
      outcome: "refused",
      operation: event.operation,
      reason: event.reason,
      target_role_code: event.targetRoleCode,
      requested_role_code: event.requestedRoleCode,
      requested_store_access_kind: event.requestedStoreAccessKind,
      platform_admin: ctx.isPlatformAdmin,
    };
    await client.query(
      `INSERT INTO audit_events
         (id, actor_user_id, actor_label, tenant_id, store_id, action,
          target_type, target_id, request_id, metadata)
       VALUES ($1, $2, NULL, $3, NULL, $4, $5, $6, NULL, $7::jsonb)`,
      [
        newId(),
        ctx.userId,
        ctx.tenantId,
        MEMBERSHIP_REFUSED_AUDIT_ACTION,
        event.targetMembershipId ? "membership" : "invitation",
        event.targetMembershipId,
        JSON.stringify(metadata),
      ],
    );
  }
}
