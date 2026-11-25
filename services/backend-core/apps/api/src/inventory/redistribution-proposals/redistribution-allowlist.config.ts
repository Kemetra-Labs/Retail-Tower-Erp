/**
 * RT-1600 — the two dark-launch allowlists of the W9 redistribution proposals (RT-1599 PHASES). Pure: it reads an
 * environment object; the module binds it once from `process.env`.
 *
 * | Variable                                | Meaning |
 * |-----------------------------------------|---------|
 * | `REDISTRIBUTION_SHADOW_TENANT_ALLOWLIST` | Comma-separated tenant ids that may compute, list, read, review and reject. |
 * | `REDISTRIBUTION_LIVE_TENANT_ALLOWLIST`   | Comma-separated tenant ids that may also accept (with W3 shipment transfers on). |
 *
 * Unset or blank: nobody. Live implies shadow. Fail closed: an entry that is not a UUID is ignored and counted (the
 * module logs the count, never the entries), never widened. A tenant on neither list gets the non-disclosing 404.
 */

const REDISTRIBUTION_SHADOW_ENV = "REDISTRIBUTION_SHADOW_TENANT_ALLOWLIST";
const REDISTRIBUTION_LIVE_ENV = "REDISTRIBUTION_LIVE_TENANT_ALLOWLIST";

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RedistributionAllowlist {
  /** Tenants in the shadow phase or later (the live list included), lower case. */
  readonly shadow: ReadonlySet<string>;
  /** Tenants in the live phase, lower case. */
  readonly live: ReadonlySet<string>;
  /** How many entries across both lists were not tenant UUIDs and were ignored. */
  readonly ignoredCount: number;
}

/** The UUID entries of one comma-separated list, lower case, and how many entries were refused. */
function tenantIdsOf(raw: string | undefined): { readonly ids: string[]; readonly refused: number } {
  const entries = (raw ?? "").split(",").map((e) => e.trim()).filter((e) => e.length > 0);
  const ids = entries.filter((e) => TENANT_UUID.test(e)).map((e) => e.toLowerCase());
  return { ids, refused: entries.length - ids.length };
}

export function resolveRedistributionAllowlist(env: Readonly<Record<string, string | undefined>>): RedistributionAllowlist {
  const shadow = tenantIdsOf(env[REDISTRIBUTION_SHADOW_ENV]);
  const live = tenantIdsOf(env[REDISTRIBUTION_LIVE_ENV]);
  return {
    shadow: new Set([...shadow.ids, ...live.ids]),
    live: new Set(live.ids),
    ignoredCount: shadow.refused + live.refused,
  };
}

/** The tenant may use the feature at all (shadow or live). */
export const isShadowEnabled = (config: RedistributionAllowlist, tenantId: string): boolean =>
  config.shadow.has(tenantId.toLowerCase());

/** The tenant is on the live list (accept also needs W3 shipment transfers on). */
export const isLiveListed = (config: RedistributionAllowlist, tenantId: string): boolean =>
  config.live.has(tenantId.toLowerCase());

/** DI token of the resolved `RedistributionAllowlist`. */
export const REDISTRIBUTION_ALLOWLIST = Symbol.for("inventory.redistributionAllowlist");
