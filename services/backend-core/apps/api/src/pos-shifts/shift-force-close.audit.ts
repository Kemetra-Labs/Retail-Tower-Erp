/**
 * The `shift.force_closed` audit metadata, for both channels (RT-1445;
 * `console-force-actions.openapi.yaml`, "Audit"; POS contract
 * `pos-shifts.openapi.yaml` `forceCloseShift`).
 *
 * One builder, so the POS and Console events carry the same keys: the shift,
 * the terminal that opened it, the terminal the request came from (null for a
 * Console close), the channel, the closing user's role, the preview fingerprint
 * (null on the POS path), the lifecycle state before and after, the opening
 * cashier and the shift's age in minutes. The closing user is the audit
 * actor. NEVER the reason (it is stored on the fact, D5a), never PII, never a
 * credential: ids, codes and counts only (FR-AUDIT-3, Constitution §XIV).
 *
 * RT-1462: a Console close also carries `actor_kind` (`owner`, `tenant_admin` or
 * `platform_admin`) and `on_behalf_of` (null, or the tenant and support session a
 * platform admin acted for). The POS path writes neither key.
 */
import type { PoolClient } from "pg";

import {
  auditFieldsOf,
  type ForceActionAuditActor,
  type ForceActionAuditFields,
} from "../common/force-action-actor";
import type { MembershipRepository } from "../context/membership.repository";
import type { StoreShiftRow } from "./shift-force-close.repository";

type ForceCloseChannel = "pos" | "console";

/** The `shift.force_closed` audit metadata. */
export interface ForceCloseAudit extends Partial<ForceActionAuditFields> {
  readonly shift_id: string;
  readonly channel: ForceCloseChannel;
  readonly actor_role: string | null;
  readonly preview_fingerprint: string | null;
  readonly lifecycle_state_before: "open" | "closed_forced";
  readonly lifecycle_state_after: "closed_forced";
  readonly opened_on_device_id: string;
  readonly closed_from_device_id: string | null;
  readonly opening_user_id: string;
  readonly shift_age_minutes: number;
  readonly replayed: boolean;
}

export interface ForceCloseAuditInput {
  readonly shift: StoreShiftRow;
  readonly channel: ForceCloseChannel;
  readonly actorRole: string | null;
  /** The Console actor (RT-1462); absent on the POS path. */
  readonly actor?: ForceActionAuditActor;
  readonly previewFingerprint: string | null;
  readonly closedFromDeviceId: string | null;
  readonly replayed: boolean;
  /** The clock the age is read at (the caller's, so a test can pin it). */
  readonly nowMs: number;
}

export function buildForceCloseAudit(input: ForceCloseAuditInput): ForceCloseAudit {
  const { shift } = input;
  return {
    shift_id: shift.shiftId,
    channel: input.channel,
    actor_role: input.actorRole,
    ...(input.actor === undefined ? {} : auditFieldsOf(input.actor)),
    preview_fingerprint: input.previewFingerprint,
    lifecycle_state_before: input.replayed ? "closed_forced" : "open",
    lifecycle_state_after: "closed_forced",
    opened_on_device_id: shift.openingDeviceId,
    closed_from_device_id: input.closedFromDeviceId,
    opening_user_id: shift.openingUserId,
    shift_age_minutes: Math.max(0, Math.floor((input.nowMs - shift.openedAt.getTime()) / 60_000)),
    replayed: input.replayed,
  };
}

/**
 * The user's role code in the tenant (`owner`, `tenant_admin`, ...), or null
 * when they hold no live membership in an active tenant. It is the guards' own
 * lookup (`MembershipRepository.findRoleCodeForUserInTenant`), so "live role"
 * has one definition, read in the force close's own tenant transaction.
 */
export function readActorRole(
  memberships: MembershipRepository,
  client: PoolClient,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  return memberships.findRoleCodeForUserInTenant(userId, tenantId, client);
}
