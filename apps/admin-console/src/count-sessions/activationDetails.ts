/**
 * RT-1423 activation refusal details: the unmet readiness boundaries of a 409
 * `count_sessions_readiness_unmet`, read defensively (a malformed body shows nothing
 * rather than half a list). Kept apart from `countLogic.ts`, which never touches a store id.
 */
import type { MessageKey } from "@/i18n";
import type { CountSessionsReadinessBoundary } from "@/lib/count-session-queries";

/** The unmet boundaries of a 409 `count_sessions_readiness_unmet`, only when every entry is well formed. */
export function unmetOf(error: unknown): CountSessionsReadinessBoundary[] | undefined {
  const unmet = (error as { error?: { details?: { unmet?: unknown } } } | undefined)?.error?.details
    ?.unmet;
  if (!Array.isArray(unmet)) return undefined;
  const wellFormed = unmet.every(
    (u) =>
      typeof u === "object" &&
      u !== null &&
      typeof u.code === "string" &&
      (u.storeId === null || typeof u.storeId === "string"),
  );
  return wellFormed ? (unmet as CountSessionsReadinessBoundary[]) : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RT-1440 (A3): the one screen that clears a readiness blocker, from its structured `subject`
 * (RT-1444): the device page (where closing its shift or retiring it is offered) or the ERP
 * warehouse mappings. Read defensively: anything but a well-formed device id or a non-empty
 * warehouse ref is no link.
 */
export function subjectLinkOf(subject: unknown): { to: string; labelKey: MessageKey } | null {
  if (typeof subject !== "object" || subject === null) return null;
  const { deviceId, warehouseRef } = subject as { deviceId?: unknown; warehouseRef?: unknown };
  if (typeof deviceId === "string" && UUID.test(deviceId)) {
    return { to: `/devices/${deviceId}`, labelKey: "counts.activation.link.device" };
  }
  if (typeof warehouseRef === "string" && warehouseRef !== "") {
    return { to: "/erp-connection/mappings", labelKey: "counts.activation.link.warehouse" };
  }
  return null;
}

/** A stable identity of a boundary's subject, so sibling rows for one store keep their own keys. */
export function subjectKey(subject: unknown): string {
  if (typeof subject !== "object" || subject === null) return "";
  const { deviceId, warehouseRef } = subject as { deviceId?: unknown; warehouseRef?: unknown };
  if (typeof deviceId === "string") return `d:${deviceId}`;
  if (typeof warehouseRef === "string") return `w:${warehouseRef}`;
  return "";
}
