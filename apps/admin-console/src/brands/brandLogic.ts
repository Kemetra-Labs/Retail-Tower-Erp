/**
 * RT-1338 brands (RT-1334 contract): pure rules of the brand list and editor. No React, no fetch.
 *
 * - Read: the roles that read the catalog (owner, tenant_admin, store_manager). Write (create,
 *   rename): owner and tenant_admin, as the contract says. The nav and the controls mirror the
 *   roles; Backend-Core is the authority and answers a non-disclosing 404 otherwise.
 * - A brand name is trimmed at its ends (the catalog's D5) and is 1 to 200 characters.
 * - There is no retire or delete in the contract: a brand can be created and renamed only.
 *
 * Helpers return message keys, never copy (RT-399).
 */
import { canReadCatalog } from "@/catalog/catalogLogic";
import { canWriteCatalog } from "@/catalog/productFormLogic";
import type { MessageKey } from "@/i18n";
import type { CatalogBrand } from "@/lib/brand-queries";
import { type WrapperResult, errorCodeOf, errorRequestIdOf } from "@/lib/write-outcome";

export const BRAND_NAME_MAX = 200;

export const canReadBrands = canReadCatalog;
export const canManageBrands = canWriteCatalog;

/** The name as it is sent: trimmed at the ends. */
export function normalizeBrandName(raw: string): string {
  return raw.trim();
}

/** What the server would refuse with a 400, caught before the request. */
export function validateBrandName(raw: string): MessageKey | undefined {
  const name = normalizeBrandName(raw);
  if (name === "") return "brands.form.nameRequired";
  return name.length > BRAND_NAME_MAX ? "brands.form.nameTooLong" : undefined;
}

export type BrandWriteOutcome =
  | { kind: "ok"; brand: CatalogBrand }
  /** 409 `brand_name_conflict`: the field is wrong, the context is fine. */
  | { kind: "nameTaken"; requestId?: string }
  /** 409 `stale_write`: the brand changed since it was read. */
  | { kind: "stale"; requestId?: string }
  /** 404 on a rename: the brand is gone (or never was); the list must be read again. */
  | { kind: "gone"; requestId?: string }
  /** 425 and a 5xx: the write may have landed; retrying with the same key replays it. */
  | { kind: "uncertain"; messageKey: MessageKey; requestId?: string }
  | { kind: "failed"; messageKey: MessageKey; requestId?: string };

const FAILURE_KEYS: Record<number, MessageKey> = {
  400: "brands.write.error.validation",
  401: "brands.write.error.session",
  403: "brands.write.error.forbidden",
  429: "brands.write.error.rateLimited",
};

/** Where a create or rename answer goes. A 5xx or no answer is uncertain: the key is kept. */
export function classifyBrandWrite(
  result: WrapperResult & { data?: CatalogBrand },
  op: "create" | "rename",
): BrandWriteOutcome {
  const requestId = errorRequestIdOf(result.error);
  const code = errorCodeOf(result.error);
  if (result.status < 300 && result.data) return { kind: "ok", brand: result.data };
  if (result.status === 409 && code === "brand_name_conflict") {
    return { kind: "nameTaken", requestId };
  }
  if (result.status === 409 && code === "stale_write") return { kind: "stale", requestId };
  // A rename 404 is a brand that is gone; a create 404 is the non-disclosing refusal of the role.
  if (result.status === 404) {
    return op === "rename"
      ? { kind: "gone", requestId }
      : { kind: "failed", messageKey: "brands.write.error.forbidden", requestId };
  }
  if (result.status === 425 || result.status >= 500) {
    return { kind: "uncertain", messageKey: "brands.write.error.uncertain", requestId };
  }
  const messageKey = FAILURE_KEYS[result.status] ?? "brands.write.error.generic";
  return { kind: "failed", messageKey, requestId };
}
