/**
 * Offer capabilities (OD-12; `offers.openapi.yaml` "Roles and capabilities";
 * Jira RT-1337). The one place that maps a role to the three capabilities, so
 * the Policy engine (RT-284) can take it over without touching the service.
 *
 *   offers.manage   create and edit drafts, preview, end, archive
 *   offers.publish  publish, and resume a paused offer
 *   offers.pause    pause: the whole offer, or only some stores
 *
 * `owner` and `tenant_admin` hold all three for every store of the tenant. A
 * `store_manager` holds `offers.pause` for THEIR OWN stores only (never a
 * whole-offer pause), and may read. Every other role holds nothing.
 */

export type OfferCapability = "offers.manage" | "offers.publish" | "offers.pause";

const TENANT_WIDE = new Set(["owner", "tenant_admin"]);

export function holdsCapability(roleCode: string | null, capability: OfferCapability): boolean {
  if (roleCode === null) return false;
  if (TENANT_WIDE.has(roleCode)) return true;
  return roleCode === "store_manager" && capability === "offers.pause";
}

/** Reads are open to `owner`, `tenant_admin` and `store_manager`. */
export function canRead(roleCode: string | null): boolean {
  return roleCode !== null && (TENANT_WIDE.has(roleCode) || roleCode === "store_manager");
}

/** A role whose reads and pause are bounded to its own stores. */
export function isStoreBounded(roleCode: string | null): boolean {
  return roleCode === "store_manager";
}
