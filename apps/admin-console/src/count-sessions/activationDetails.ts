/**
 * RT-1423 activation refusal details: the unmet readiness boundaries of a 409
 * `count_sessions_readiness_unmet`, read defensively (a malformed body shows nothing
 * rather than half a list). Kept apart from `countLogic.ts`, which never touches a store id.
 */
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
