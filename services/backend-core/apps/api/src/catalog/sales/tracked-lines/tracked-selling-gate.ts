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
 *   - RT-451 S2 added the per-tenant switch (`tenant_inventory_settings.
 *     tracked_selling_enabled`, 0086). Tracked selling is in effect only
 *     while this gate is on AND the tenant has switched it on: this gate
 *     never turns tracked selling on for a tenant by itself.
 *
 * RT-451 S6: the posting feed emits `trackingMode` / `erpnextBatchRef` only
 * while tracked selling is in effect, and holds every intent sold from a
 * tracking identity otherwise. Switching a tenant on re-heads those rows
 * (`tracked-selling-setting.service.ts`). Turning this gate OFF and then ON
 * again while a tenant is switched on must re-head them as a deploy step, in
 * the same release, under each tenant's feed sequence lock: `UPDATE
 * erpnext_posting_status SET sequence = DEFAULT` for its pending rows whose
 * current resolution has a line with `tracking_identity_id` set. Without it, a
 * Connector whose cursor moved past them never sees them (the RT-418 rule).
 *
 * Read per request (the `isPosReturnsEnabled` convention), so a test or a
 * restart-free toggle sees the current value. `docker-compose.prod.yml` passes
 * it to the api with the default `false` (RT-451), so an environment stays off
 * until an operator sets it in `backend.env`, and turning tracked selling on for
 * a tenant stays an owner decision.
 */
import { isEnvFlagOn } from "../sale-tenders-gate";

export const TRACKED_SELLING_GATE = "POS_TRACKED_SELLING_ENABLED";

export function isTrackedSellingEnabled(): boolean {
  // The literal name, so the RT-984 compose env sweep resolves it.
  return isEnvFlagOn("POS_TRACKED_SELLING_ENABLED");
}
