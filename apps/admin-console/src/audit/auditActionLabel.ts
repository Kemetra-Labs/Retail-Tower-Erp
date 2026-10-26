/**
 * RT-784 (RT-777 S5): recognisable labels for the platform support-session
 * rows a tenant owner or tenant admin sees in the tenant's own audit view
 * (RT-414 decision 3). The action codes are the ones the pinned
 * `platform-support-sessions.openapi.yaml` names as written to the target
 * tenant's audit log, and `listAuditEvents` returns them for that tenant only.
 *
 * A label sits beside the action code, never in place of it: the code is the
 * evidence and still renders verbatim. An action not listed here (any other
 * row, or a platform action added later) has no label and renders as its code
 * alone, as before.
 */
import type { MessageKey } from "@/i18n/translate";
import type { AuditRow } from "./useAuditSearch";

const LABELS: Readonly<Record<string, MessageKey>> = {
  "platform.support_session.opened": "audit.action.supportSessionOpened",
  "platform.support_session.renewed": "audit.action.supportSessionRenewed",
  "platform.support_session.ended": "audit.action.supportSessionEnded",
  "platform.cross_tenant.accessed": "audit.action.crossTenantAccessed",
};

/**
 * The label key for a row's action, or `undefined` when the action has none.
 * A refused cross-tenant request (`metadata.outcome: "rejected"`) is named as
 * refused, so the owner never reads a refusal as access. Any other or missing
 * outcome keeps the neutral access label. `metadata` is untrusted: only an
 * exact string match is read from it.
 */
export function auditActionLabelKey(row: AuditRow): MessageKey | undefined {
  const action: unknown = row.action;
  if (typeof action !== "string" || !Object.hasOwn(LABELS, action)) return undefined;
  if (action === "platform.cross_tenant.accessed" && row.metadata?.outcome === "rejected") {
    return "audit.action.crossTenantRefused";
  }
  return LABELS[action];
}
