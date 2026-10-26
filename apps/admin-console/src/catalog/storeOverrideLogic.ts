import type { BannerVariant } from "@/components/Banner";
/**
 * RT-770 pure rules of the store-override drawer (CAT-C2c, RT-752 AC 3). No
 * React, no fetch. The contract is the RT-738 override writes of
 * `console-catalog.yaml`:
 *
 *   PUT  /products/{id}/store-overrides/{storeId}         `expectedUpdatedAt` plus
 *        `isActive` and / or `taxCategory` (absent: left as is; `null`: cleared)
 *   POST /products/{id}/store-overrides/{storeId}/retire  `expectedUpdatedAt`
 *
 * Neither write ever changes the store's price (O-2). The form edits the
 * store's raw deviation only; nothing here computes what the store resolves
 * (RT-752 D8). The controls mirror the API's roles so a person is not offered
 * what would be refused (O-4); the API stays the authority. Helpers return
 * message keys, never copy (RT-399).
 */
import type { MessageKey } from "@/i18n";
import type { CatalogStoreOverride, CatalogStoreOverrideUpsert } from "@/lib/catalog-queries";
import { TAX_CATEGORY_MAX, canWriteCatalog } from "./productFormLogic";

/** Roles the override writes accept (RT-752 AC 1); `store_manager` for availability only. */
export const OVERRIDE_WRITE_ROLES = ["owner", "tenant_admin", "store_manager"] as const;

/** Mirrors the API's roles to show or hide the controls. Not an authorization decision. */
export function canWriteOverrides(role: string | null | undefined): boolean {
  return (OVERRIDE_WRITE_ROLES as readonly string[]).includes(role ?? "");
}

/** Only owner and tenant_admin may set or clear a store tax category (O-4). */
export function canOverrideTax(role: string | null | undefined): boolean {
  return canWriteCatalog(role);
}

/**
 * Retire is offered only where the API would accept it on role grounds: a
 * `store_manager` retiring an override that has a tax category is 403
 * `tax_override_forbidden`, so the control is not shown. A price on the
 * override is not pre-empted here: the API answers 409 `price_override_present`
 * and the drawer explains it.
 */
export function canRetireOverride(
  role: string | null | undefined,
  override: Pick<CatalogStoreOverride, "taxCategory"> | null,
): boolean {
  if (override === null || !canWriteOverrides(role)) return false;
  return canOverrideTax(role) || override.taxCategory === null;
}

// --- The availability tri-state --------------------------------------------------------------

/** «يتبع المؤسسة» / available / not available. */
export const AVAILABILITY_CHOICES = ["inherit", "available", "unavailable"] as const;
export type AvailabilityChoice = (typeof AVAILABILITY_CHOICES)[number];

/** The wire value of a choice: `null` clears the store's own availability. */
export function isActiveOf(choice: AvailabilityChoice): boolean | null {
  if (choice === "inherit") return null;
  return choice === "available";
}

export function availabilityChoiceOf(isActive: boolean | null): AvailabilityChoice {
  if (isActive === null) return "inherit";
  return isActive ? "available" : "unavailable";
}

export function availabilityChoiceKey(choice: AvailabilityChoice): MessageKey {
  switch (choice) {
    case "inherit":
      return "catalog.override.availability.inherit";
    case "available":
      return "catalog.override.availability.available";
    case "unavailable":
      return "catalog.override.availability.unavailable";
  }
}

// --- Form values ------------------------------------------------------------------------------

/** What the person sees and edits. `taxCategory` "" is "follow the tenant". Raw, not trimmed. */
export interface OverrideFormValues {
  availability: AvailabilityChoice;
  taxCategory: string;
}

/** The store's active override as form values; no override is "follow the tenant" for both. */
export function overrideValuesOf(override: CatalogStoreOverride | null): OverrideFormValues {
  return {
    availability: availabilityChoiceOf(override?.isActive ?? null),
    taxCategory: override?.taxCategory ?? "",
  };
}

/**
 * The precondition of either write: the active override's `updatedAt`, or
 * `null` when the person saw none (the upsert then creates it).
 */
export function expectedUpdatedAtOf(override: CatalogStoreOverride | null): string | null {
  return override?.updatedAt ?? null;
}

/** The active override of one store in a product's detail, or null. */
export function overrideOf(
  overrides: readonly CatalogStoreOverride[],
  storeId: string,
): CatalogStoreOverride | null {
  return overrides.find((o) => o.storeId === storeId) ?? null;
}

/**
 * What the client may prevent: a tax category over 50 characters once its
 * ends are trimmed (D5). An empty one is not an error: it clears the store's
 * tax category, so the store follows the tenant.
 */
export function overrideTaxError(values: OverrideFormValues): MessageKey | undefined {
  return values.taxCategory.trim().length > TAX_CATEGORY_MAX
    ? "catalog.override.error.taxCategoryTooLong"
    : undefined;
}

/**
 * The trimmed tax category to send, `null` to clear it, or undefined when the
 * input is no edit. Spaces at the ends alone are no edit (D5).
 */
function taxChange(base: string, typed: string): string | null | undefined {
  const next = typed.trim();
  if (typed === base || next === base) return undefined;
  return next === "" ? null : next;
}

/**
 * The upsert body: `expectedUpdatedAt` plus only the fields the person changed.
 * `taxCategory` is never sent by a role that may not change it (a key alone is
 * 403 `tax_override_forbidden`). `null` when nothing changed: nothing is sent.
 */
export function buildOverrideBody(
  base: OverrideFormValues,
  typed: OverrideFormValues,
  expectedUpdatedAt: string | null,
  taxEditable: boolean,
): CatalogStoreOverrideUpsert | null {
  const body: CatalogStoreOverrideUpsert = { expectedUpdatedAt };
  if (typed.availability !== base.availability) body.isActive = isActiveOf(typed.availability);
  if (taxEditable) {
    const tax = taxChange(base.taxCategory, typed.taxCategory);
    if (tax !== undefined) body.taxCategory = tax;
  }
  return "isActive" in body || "taxCategory" in body ? body : null;
}

/**
 * After a `stale_write` the product is read again. What the person changed is
 * kept; every other field takes the fresh value, so the next write cannot put
 * back somebody else's change. A tax category that differs only by spaces at
 * its ends is no edit (D5, as in the body), so it takes the fresh value too.
 */
export function mergeOverrideReload(
  oldBase: OverrideFormValues,
  typed: OverrideFormValues,
  freshBase: OverrideFormValues,
): OverrideFormValues {
  return {
    availability:
      typed.availability === oldBase.availability ? freshBase.availability : typed.availability,
    taxCategory:
      typed.taxCategory.trim() === oldBase.taxCategory.trim()
        ? freshBase.taxCategory
        : typed.taxCategory,
  };
}

// --- The failure of a write --------------------------------------------------------------------

export type OverrideWriteOp = "upsert" | "retire";

export type OverrideWriteRender =
  /** 409 `stale_write`: the store's deviation changed since it was read. Input is kept. */
  | { kind: "stale"; requestId?: string }
  /** 409 `product_retired` (upsert only): the item is retired; its deviations are read-only. */
  | { kind: "retired"; requestId?: string }
  /** 422 `override_empty` (upsert only): nothing would be left; retire the override instead. */
  | { kind: "empty"; requestId?: string }
  /** Every other failure: a persistent banner in the drawer. */
  | { kind: "banner"; variant: BannerVariant; messageKey: MessageKey; requestId?: string };

export interface OverrideWriteFailure {
  op: OverrideWriteOp;
  status: number;
  /** `error.code` of the envelope, when there was one. */
  code?: string;
  requestId?: string;
}

function banner(
  variant: BannerVariant,
  messageKey: MessageKey,
  requestId: string | undefined,
): OverrideWriteRender {
  return { kind: "banner", variant, messageKey, requestId };
}

function forbidden(code: string | undefined, requestId: string | undefined): OverrideWriteRender {
  if (code === "tax_override_forbidden") {
    return banner("danger", "catalog.override.error.taxForbidden", requestId);
  }
  if (code === "origin_rejected") return banner("danger", "catalog.write.error.origin", requestId);
  return banner("danger", "catalog.override.error.forbidden", requestId);
}

function conflict({ code, requestId }: OverrideWriteFailure): OverrideWriteRender {
  if (code === "stale_write") return { kind: "stale", requestId };
  if (code === "product_retired") return { kind: "retired", requestId };
  if (code === "price_override_present") {
    return banner("warning", "catalog.override.error.pricePresent", requestId);
  }
  return banner("danger", "catalog.override.error.conflict", requestId);
}

/**
 * Where a failed override write is shown. No server error belongs to a field
 * (the 400 has no field pointer, RT-752 G9): every failure is a context error
 * in the drawer (UX-08 "Invalid value ≠ invalid context").
 */
export function mapOverrideWriteError(failure: OverrideWriteFailure): OverrideWriteRender {
  const { status, code, requestId } = failure;
  switch (status) {
    case 400:
      return banner("danger", "catalog.override.error.validation", requestId);
    case 401:
      return banner("danger", "catalog.write.error.session", requestId);
    case 403:
      return forbidden(code, requestId);
    case 404:
      return banner("danger", "catalog.override.error.notFound", requestId);
    case 409:
      return conflict(failure);
    case 422:
      return { kind: "empty", requestId };
    case 429:
      return banner("warning", "catalog.write.error.rateLimited", requestId);
    default:
      return banner("danger", "catalog.write.error.server", requestId);
  }
}
