/**
 * Who performed a Console force action, and on whose behalf (RT-1462; the RT-1437 D1 amendment,
 * owner decision 2026-11-18, RT-1437 comment 17453 and RT-1462 comment 17454).
 *
 * SHARED by the shift force close (`console-force-actions`) and the store deletion
 * (`stores/deletion`), so both write the same two audit keys:
 *
 *   `actor_kind`   `owner` | `tenant_admin` | `platform_admin`. A platform admin is ALWAYS
 *                  `platform_admin`, even when the same account also holds an owner membership in
 *                  the tenant (the lab account does): the row says which authority was used.
 *   `on_behalf_of` null for `owner` and `tenant_admin`. For a platform admin, the customer the
 *                  action was taken for: the tenant, plus the support session and its ticket
 *                  reference when the caller acted inside one. It is read from the SERVER
 *                  (the session's tenant and the live support session), never from the request,
 *                  and it carries ids and a ticket reference only: no customer name, e-mail or
 *                  phone (FR-AUDIT-3, Constitution §XIV). The support session names no person.
 *
 * `actor_role` keeps its meaning (the caller's membership role in the tenant, or null).
 */
import type { ResolvedContext } from "../context/types";

export type ForceActionActorKind = "owner" | "tenant_admin" | "platform_admin";

/** The customer a platform admin acted for. Snake case: it is written as audit metadata as is. */
export interface OnBehalfOf {
  readonly tenant_id: string;
  /** The live support session the request ran in, or null (a platform admin who is a tenant member). */
  readonly support_session_id: string | null;
  readonly ticket_ref: string | null;
}

/** The admitted caller of a force action, as the audit needs it. */
export interface ForceActionAuditActor {
  readonly kind: ForceActionActorKind;
  /** The caller's membership role, or null (a platform admin who is not a member). */
  readonly role: string | null;
  readonly onBehalfOf: OnBehalfOf | null;
}

/** The audit keys every force action row carries beside `actor_role`. */
export interface ForceActionAuditFields {
  readonly actor_kind: ForceActionActorKind | null;
  readonly on_behalf_of: OnBehalfOf | null;
}

/** A platform admin's actor: always `platform_admin`, on behalf of the session's tenant. */
export function platformAdminActor(ctx: ResolvedContext, tenantId: string, role: string | null): ForceActionAuditActor {
  return {
    kind: "platform_admin",
    role,
    onBehalfOf: {
      tenant_id: tenantId,
      support_session_id: ctx.supportSession?.id ?? null,
      ticket_ref: ctx.supportSession?.ticketRef ?? null,
    },
  };
}

/** The two audit keys of an actor; `null` for both when the writer has no actor kind (the POS path, the API path). */
export function auditFieldsOf(actor: ForceActionAuditActor | null): ForceActionAuditFields {
  return { actor_kind: actor?.kind ?? null, on_behalf_of: actor?.onBehalfOf ?? null };
}
