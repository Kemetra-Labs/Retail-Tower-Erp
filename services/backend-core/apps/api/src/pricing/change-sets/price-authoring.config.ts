/**
 * RT-1484 (RT-282 PR-09b) — the Pricing authoring allowlist (owner decision 1, RT-1484 comment
 * 17829). Pure: it reads an environment object.
 *
 * | Variable                             | Meaning |
 * |--------------------------------------|---------|
 * | `PRICING_AUTHORING_TENANT_ALLOWLIST` | Comma-separated tenant ids that may write Price Change Sets. Unset or blank: nobody. |
 *
 * Until a tenant's legacy cutover (RT-1485, spec 044 §6.1), a Change Set published by Pricing
 * would take the tenant's revision 1, which migration 0123 reserves for the `legacy_import` set.
 * So every Change Set write of a tenant not on this list is refused with `409
 * pricing_authority_legacy` (the spec 044 §6.1 code); reads stay open. Fail closed: an entry
 * that is not a UUID is ignored (logged by the module), never widened. RT-1485 replaces this
 * list with the tenant's `authority` row.
 */

const PRICING_AUTHORING_ALLOWLIST_ENV = "PRICING_AUTHORING_TENANT_ALLOWLIST";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PricingAuthoringConfig {
  /** The allowlisted tenant ids, lower case. */
  readonly tenantIds: ReadonlySet<string>;
  /** Entries that are not UUIDs and were ignored. */
  readonly ignored: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

/** The allowlist from an environment object: comma-separated UUIDs; blank or unset is empty. */
export function resolvePricingAuthoringConfig(env: Env): PricingAuthoringConfig {
  const raw = env[PRICING_AUTHORING_ALLOWLIST_ENV] ?? "";
  const tenantIds = new Set<string>();
  const ignored: string[] = [];
  for (const entry of raw.split(",").map((e) => e.trim()).filter((e) => e !== "")) {
    if (UUID_RE.test(entry)) tenantIds.add(entry.toLowerCase());
    else ignored.push(entry);
  }
  return { tenantIds, ignored };
}

/** True when the tenant may write Price Change Sets. */
export function isPricingAuthoringAllowed(config: PricingAuthoringConfig, tenantId: string): boolean {
  return config.tenantIds.has(tenantId.toLowerCase());
}

/** DI token of the resolved `PricingAuthoringConfig`. */
export const PRICING_AUTHORING_CONFIG = Symbol.for("pricing.authoringConfig");
