/**
 * Jira RT-451 slice S1 — the tracked-selling deployment gate.
 *
 * RT-451 serves the tracked-selling operations of `pos-sales/tracked-lines.yaml`
 * "behind a default-off per-tenant activation flag". The per-tenant flag needs
 * a `[GATED]` migration that slice S1 does not carry (owner instruction
 * 2026-11-03: no new migration is pre-approved). Until that slice lands, the
 * whole surface sits behind this deployment gate, which is stricter: while it
 * is off, no tenant can reach the surface at all.
 *
 *   - `POS_TRACKED_SELLING_ENABLED` unset or anything but "1" / "true" / "yes"
 *     (case-insensitive, trimmed): OFF, the default. `posListTrackedLots`
 *     answers the contract's non-disclosing 404 and reads nothing.
 *   - The slice that adds the per-tenant flag ANDs it with this gate; this
 *     gate never turns tracked selling on for a tenant by itself in that slice.
 *
 * Read per request (the `isPosReturnsEnabled` convention), so a test or a
 * restart-free toggle sees the current value. Deliberately NOT passed by
 * `docker-compose.prod.yml` (an RT-984 exclusion with this reason), so
 * production stays off until the owner approves turning tracked selling on.
 */
import { isEnvFlagOn } from "../sale-tenders-gate";

export const TRACKED_SELLING_GATE = "POS_TRACKED_SELLING_ENABLED";

export function isTrackedSellingEnabled(): boolean {
  // The literal name, so the RT-984 compose env sweep resolves it.
  return isEnvFlagOn("POS_TRACKED_SELLING_ENABLED");
}
