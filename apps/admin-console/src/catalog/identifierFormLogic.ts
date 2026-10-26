/**
 * RT-769 pure rules of the identifier drawers (CAT-C2b, RT-752 AC 3 "Identifier
 * drawer form", decision D6). No React, no fetch. The contract is the RT-738
 * identifier writes of `console-catalog.yaml`:
 *
 *   POST /products/{id}/identifiers         `ProductIdentifierKey` to bind
 *   POST /products/{id}/identifiers/retire  `ProductIdentifierKey` to retire
 *
 * The value is an identifier, so it is stored BYTE FOR BYTE: nothing here trims
 * it, folds its case or converts its digits (UX-08 "normalization must never
 * change an identifier"). What the contract rejects deterministically (empty,
 * longer than 200 characters, a control character, whitespace at either end)
 * is prevented and NAMED, never fixed silently. Arabic-Indic digits in a barcode
 * or PLU are a non-blocking warning (D6): the value is still sent as typed.
 *
 * Helpers return message keys, never copy; components translate at render
 * (RT-399).
 */
import type { BannerVariant } from "@/components/Banner";
import type { MessageKey } from "@/i18n";
import type {
  CatalogIdentifier,
  CatalogIdentifierKey,
  CatalogIdentifierType,
} from "@/lib/catalog-queries";

/** The types the contract binds, in the order the select offers them. */
export const IDENTIFIER_TYPES: readonly CatalogIdentifierType[] = [
  "barcode",
  "sku",
  "plu",
  "supplier_code",
  "external_pos_id",
];

/** `ProductIdentifierKey.value`: 1 to 200 characters. */
export const VALUE_MAX = 200;
/** `ProductIdentifierKey.sourceSystem`: 1 to 100 characters. */
export const SOURCE_SYSTEM_MAX = 100;

/** The scope select's value for a tenant-wide identifier («كل المتاجر»). */
export const TENANT_WIDE = "";

/** What the person sees and edits. Raw: nothing here is ever trimmed. */
export interface IdentifierFormValues {
  identifierType: CatalogIdentifierType;
  value: string;
  /** `TENANT_WIDE` or a store id in the caller's scope. */
  storeId: string;
  sourceSystem: string;
}

export const EMPTY_IDENTIFIER_FORM: IdentifierFormValues = {
  identifierType: "barcode",
  value: "",
  storeId: TENANT_WIDE,
  sourceSystem: "",
};

export function isIdentifierType(type: string): type is CatalogIdentifierType {
  return (IDENTIFIER_TYPES as readonly string[]).includes(type);
}

/** An `external_pos_id` is never store-scoped: the scope choice is hidden for it. */
export function hasScope(type: CatalogIdentifierType): boolean {
  return type !== "external_pos_id";
}

/** Only an `external_pos_id` names the POS system it came from, and it must. */
export function needsSourceSystem(type: CatalogIdentifierType): boolean {
  return type === "external_pos_id";
}

// --- Validation: what the client may prevent --------------------------------------------

/** Characters as the contract counts them (code points), not UTF-16 units. */
function lengthOf(text: string): number {
  return [...text].length;
}

/** C0 controls and DEL, as the contract's pattern excludes them. */
function hasControl(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const EDGE_SPACE = /^\s|\s$/;

/** One problem at a time, the first the contract would hit. */
export function valueError(value: string): MessageKey | undefined {
  if (value === "") return "catalog.identifier.error.valueRequired";
  if (hasControl(value)) return "catalog.identifier.error.valueControl";
  if (EDGE_SPACE.test(value)) return "catalog.identifier.error.valueEdgeSpace";
  if (lengthOf(value) > VALUE_MAX) return "catalog.identifier.error.valueTooLong";
  return undefined;
}

/** Required, not blank, no NUL, at most 100 characters; otherwise sent as typed. */
export function sourceSystemError(values: IdentifierFormValues): MessageKey | undefined {
  if (!needsSourceSystem(values.identifierType)) return undefined;
  const { sourceSystem } = values;
  if (sourceSystem.trim() === "") return "catalog.identifier.error.sourceRequired";
  if (sourceSystem.includes("\u0000")) return "catalog.identifier.error.sourceControl";
  if (lengthOf(sourceSystem) > SOURCE_SYSTEM_MAX) return "catalog.identifier.error.sourceTooLong";
  return undefined;
}

/** The fields that can carry an error, in the order of the drawer (the value comes last). */
export const IDENTIFIER_FIELD_ORDER = ["sourceSystem", "value"] as const;
export type IdentifierField = (typeof IDENTIFIER_FIELD_ORDER)[number];
export type IdentifierFieldErrors = Partial<Record<IdentifierField, MessageKey>>;

export function validateIdentifierForm(values: IdentifierFormValues): IdentifierFieldErrors {
  const found: IdentifierFieldErrors = {
    sourceSystem: sourceSystemError(values),
    value: valueError(values.value),
  };
  return Object.fromEntries(
    Object.entries(found).filter(([, key]) => key !== undefined),
  ) as IdentifierFieldErrors;
}

/** The field focus goes to after a blocked submit: the first in error, in drawer order. */
export function firstErrorField(errors: IdentifierFieldErrors): IdentifierField | undefined {
  return IDENTIFIER_FIELD_ORDER.find((field) => errors[field] !== undefined);
}

// --- D6: digits a scanner never sends ---------------------------------------------------

/** A decimal digit that is not 0-9: Arabic-Indic (٠-٩), Extended Arabic-Indic (۰-۹) and the like. */
const NON_LATIN_DIGIT = /(?![0-9])\p{Nd}/u;

/**
 * D6: a barcode or PLU typed with non-Latin digits will not match what a
 * scanner sends (Latin digits). A warning only: the value is never converted
 * and the add is not blocked (blocking would be stricter than the contract).
 */
export function digitWarning(values: IdentifierFormValues): MessageKey | undefined {
  const scanned = values.identifierType === "barcode" || values.identifierType === "plu";
  return scanned && NON_LATIN_DIGIT.test(values.value)
    ? "catalog.identifier.warning.arabicDigits"
    : undefined;
}

// --- The request body ---------------------------------------------------------------------

/**
 * The key to bind, exactly as typed. `storeId` is the chosen store or null
 * (and always null on an `external_pos_id`); `sourceSystem` is set only on an
 * `external_pos_id`, null on every other type, as the contract requires.
 */
export function identifierKeyOf(values: IdentifierFormValues): CatalogIdentifierKey {
  const { identifierType } = values;
  return {
    identifierType,
    value: values.value,
    storeId: hasScope(identifierType) && values.storeId !== TENANT_WIDE ? values.storeId : null,
    sourceSystem: needsSourceSystem(identifierType) ? values.sourceSystem : null,
  };
}

/** The full key of an identifier as read: what retire names, byte for byte. */
export function retireKeyOf(identifier: CatalogIdentifier): CatalogIdentifierKey {
  return {
    identifierType: identifier.identifierType,
    value: identifier.value,
    storeId: identifier.storeId ?? null,
    sourceSystem: identifier.sourceSystem ?? null,
  };
}

/** Two keys name the same identifier (compared exactly, as the server does). */
export function sameKey(a: CatalogIdentifierKey, b: CatalogIdentifierKey): boolean {
  return (
    a.identifierType === b.identifierType &&
    a.value === b.value &&
    (a.storeId ?? null) === (b.storeId ?? null) &&
    (a.sourceSystem ?? null) === (b.sourceSystem ?? null)
  );
}

// --- The failure of a write -----------------------------------------------------------------

export type IdentifierWriteOp = "add" | "retire";

export type IdentifierWriteRender =
  /** 409 `alias_conflict`: the value is taken. A value-field error that names no other item. */
  | { kind: "field"; field: "value"; messageKey: MessageKey }
  /** 409 `product_retired` (add): the item is retired. A surface error; the item is re-read. */
  | { kind: "retired"; requestId?: string }
  /** 404 on retire: the identifier is not active on this item any more. The item is re-read. */
  | { kind: "gone"; requestId?: string }
  /** Every other failure: a banner at the top of the drawer. */
  | { kind: "banner"; variant: BannerVariant; messageKey: MessageKey; requestId?: string };

export interface IdentifierWriteFailure {
  op: IdentifierWriteOp;
  status: number;
  /** `error.code` of the envelope, when there was one. */
  code?: string;
  requestId?: string;
}

function banner(
  variant: BannerVariant,
  messageKey: MessageKey,
  requestId: string | undefined,
): IdentifierWriteRender {
  return { kind: "banner", variant, messageKey, requestId };
}

function conflict({ code, requestId }: IdentifierWriteFailure): IdentifierWriteRender {
  if (code === "alias_conflict") {
    return { kind: "field", field: "value", messageKey: "catalog.identifier.error.aliasConflict" };
  }
  if (code === "product_retired") return { kind: "retired", requestId };
  return banner("danger", "catalog.write.error.conflict", requestId);
}

function notFound({ op, requestId }: IdentifierWriteFailure): IdentifierWriteRender {
  // Non-disclosing either way: the item, the store or the identifier is simply not available.
  return op === "retire"
    ? { kind: "gone", requestId }
    : banner("danger", "catalog.identifier.error.notFound", requestId);
}

/**
 * Where a failed identifier write is shown. Only `alias_conflict` belongs to a
 * field (the value); the 400 has no field pointer (RT-752 G9), and
 * authorization, scope and state failures stay at the surface (UX-08 "Invalid
 * value ≠ invalid context").
 */
export function mapIdentifierWriteError(failure: IdentifierWriteFailure): IdentifierWriteRender {
  const { status, code, requestId } = failure;
  switch (status) {
    case 400:
      return banner("danger", "catalog.identifier.error.validation", requestId);
    case 401:
      return banner("danger", "catalog.write.error.session", requestId);
    case 403:
      return banner(
        "danger",
        code === "origin_rejected" ? "catalog.write.error.origin" : "catalog.write.error.forbidden",
        requestId,
      );
    case 404:
      return notFound(failure);
    case 409:
      return conflict(failure);
    case 429:
      return banner("warning", "catalog.write.error.rateLimited", requestId);
    default:
      return banner("danger", "catalog.write.error.server", requestId);
  }
}
