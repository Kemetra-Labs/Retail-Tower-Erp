/**
 * Server-generated tenant slug for a self-signup (RT-1350 slice 3, design D3).
 *
 * The owner never picks a slug. `<ascii-slug-of-business-name>-<8 hex>`: readable, valid
 * for the DB CHECK `tenants_slug_format` (`^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$`), and unique
 * in practice through the random suffix (the partial unique index on `lower(slug)` is
 * the backstop). A name with no ASCII letters or digits (for example Arabic only) uses
 * `workspace`.
 */
import { randomBytes } from "node:crypto";

const SUFFIX_LENGTH = 8;
const MAX_LENGTH = 63;
/** Room for the base: total minus the hyphen and the suffix. */
const MAX_BASE = MAX_LENGTH - 1 - SUFFIX_LENGTH;

export function deriveSlug(businessName: string, suffix: string = randomBytes(4).toString("hex")): string {
  const base = businessName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BASE)
    .replace(/-+$/g, "");
  return `${base === "" ? "workspace" : base}-${suffix}`;
}
