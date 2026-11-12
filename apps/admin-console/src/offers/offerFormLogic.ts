/**
 * RT-1338 offer editor: pure draft ↔ `OfferDefinition`. A fail-fast guard for what the contract
 * constrains; Backend-Core stays authoritative (it re-checks the shape on save, and the references,
 * the eligible set and the conflicts on preview and publish). No React, no client.
 *
 * - X and Y are whole numbers 1 to 1000, P a whole percent 1 to 100 (sent as the contract's string),
 *   the maximum applications blank for unlimited or 1 to 1000. Arabic-Indic digits are accepted.
 * - Eligibility is two sets, include and exclude, each of products, categories and brands.
 *   Include must name at least one; EXCLUSION ALWAYS WINS (OD-1): this is copy only, the Console
 *   resolves nothing and computes no eligible set.
 * - Stores: all stores, or a list. A membership bounded to specific stores cannot author all stores.
 * - Schedule: store-local `YYYY-MM-DDTHH:MM` as typed in a `datetime-local` field; the end is
 *   optional and must be after the start.
 *
 * Errors are message keys (plus params), translated at render time.
 */
import type { MessageKey, Params } from "@/i18n";
import type { OfferDefinition, OfferOfflinePolicy } from "@/lib/offer-queries";
import { normalizeLevel } from "@/stock-levels/stockLevelLogic";

const NAME_MAX = 120;
export const QUANTITY_MAX = 1000;
export const MAX_PRODUCTS = 5000;
const MAX_RULE_IDS = 500;
const MAX_STORES = 500;

export interface EligibilityIds {
  productIds: string[];
  categoryIds: string[];
  brandIds: string[];
}

export interface OfferFormValues {
  nameAr: string;
  nameEn: string;
  buyQuantity: string;
  getQuantity: string;
  percentOff: string;
  /** Blank is unlimited. */
  maxApplications: string;
  include: EligibilityIds;
  exclude: EligibilityIds;
  scope: "all" | "stores";
  storeIds: string[];
  /** `datetime-local` value, store-local time. */
  startsAt: string;
  /** `datetime-local` value, or "" for no end. */
  endsAt: string;
  offlinePolicy: OfferOfflinePolicy;
  /** The loaded schedule was an absolute instant: saving writes it as store-local time. */
  scheduleWasAbsolute: boolean;
}

export type OfferFormField =
  | "nameAr"
  | "nameEn"
  | "buyQuantity"
  | "getQuantity"
  | "percentOff"
  | "maxApplications"
  | "include"
  | "storeIds"
  | "startsAt"
  | "endsAt";

interface FieldError {
  messageKey: MessageKey;
  params?: Params;
}

export type OfferFormErrors = Partial<Record<OfferFormField, FieldError>>;

/** The order of the fields in the form: the error summary lists them in it. */
export const OFFER_FIELD_ORDER: readonly OfferFormField[] = [
  "nameAr",
  "nameEn",
  "buyQuantity",
  "getQuantity",
  "percentOff",
  "maxApplications",
  "include",
  "storeIds",
  "startsAt",
  "endsAt",
];

const emptyIds = (): EligibilityIds => ({ productIds: [], categoryIds: [], brandIds: [] });

/** A new offer: buy one, get one at 50% off, all stores (or none chosen when bounded). */
export function emptyOfferForm(tenantWide: boolean): OfferFormValues {
  return {
    nameAr: "",
    nameEn: "",
    buyQuantity: "1",
    getQuantity: "1",
    percentOff: "50",
    maxApplications: "",
    include: emptyIds(),
    exclude: emptyIds(),
    scope: tenantWide ? "all" : "stores",
    storeIds: [],
    startsAt: "",
    endsAt: "",
    offlinePolicy: "allow_cached",
    scheduleWasAbsolute: false,
  };
}

/** `2026-11-20T09:00:00` or an ISO instant → the `datetime-local` value, as written. */
function localInput(value: string | null | undefined): string {
  return value ? value.slice(0, 16) : "";
}

/** The form for a loaded definition (a draft, or the published version a next draft starts from). */
export function formOf(definition: OfferDefinition): OfferFormValues {
  const { parameters, eligibility, storeScope, schedule } = definition;
  const ids = (set: Partial<EligibilityIds> | undefined): EligibilityIds => ({
    productIds: [...(set?.productIds ?? [])],
    categoryIds: [...(set?.categoryIds ?? [])],
    brandIds: [...(set?.brandIds ?? [])],
  });
  return {
    nameAr: definition.nameAr,
    nameEn: definition.nameEn ?? "",
    buyQuantity: String(parameters.buyQuantity),
    getQuantity: String(parameters.getQuantity),
    percentOff: parameters.percentOff,
    maxApplications:
      parameters.maxApplicationsPerSale === null ? "" : String(parameters.maxApplicationsPerSale),
    include: ids(eligibility.include),
    exclude: ids(eligibility.exclude),
    scope: "allStores" in storeScope ? "all" : "stores",
    storeIds: "allStores" in storeScope ? [] : [...storeScope.storeIds],
    startsAt: localInput(schedule.startsAt),
    endsAt: localInput(schedule.endsAt),
    offlinePolicy: definition.offlinePolicy ?? "allow_cached",
    scheduleWasAbsolute: schedule.timeBasis === "absolute",
  };
}

/** Is there any rule in this set? */
function setIsEmpty(set: EligibilityIds): boolean {
  return set.productIds.length + set.categoryIds.length + set.brandIds.length === 0;
}

/** Does the form differ from what was loaded? Compared as the values the person sees. */
export function isDirty(base: OfferFormValues, typed: OfferFormValues): boolean {
  return JSON.stringify(base) !== JSON.stringify(typed);
}

// --- Validation -------------------------------------------------------------------------------

function parseWhole(raw: string, min: number, max: number): number | undefined {
  const value = normalizeLevel(raw);
  if (!/^\d{1,5}$/.test(value)) return undefined;
  const n = Number.parseInt(value, 10);
  return n >= min && n <= max ? n : undefined;
}

function nameErrors(values: OfferFormValues): OfferFormErrors {
  const errors: OfferFormErrors = {};
  const ar = values.nameAr.trim();
  if (ar === "") errors.nameAr = { messageKey: "offers.form.error.nameArRequired" };
  else if (ar.length > NAME_MAX) {
    errors.nameAr = { messageKey: "offers.form.error.nameTooLong", params: { max: NAME_MAX } };
  }
  if (values.nameEn.trim().length > NAME_MAX) {
    errors.nameEn = { messageKey: "offers.form.error.nameTooLong", params: { max: NAME_MAX } };
  }
  return errors;
}

function parameterErrors(values: OfferFormValues): OfferFormErrors {
  const errors: OfferFormErrors = {};
  const whole = {
    messageKey: "offers.form.error.wholeNumber" as const,
    params: { max: QUANTITY_MAX },
  };
  if (parseWhole(values.buyQuantity, 1, QUANTITY_MAX) === undefined) errors.buyQuantity = whole;
  if (parseWhole(values.getQuantity, 1, QUANTITY_MAX) === undefined) errors.getQuantity = whole;
  if (parseWhole(values.percentOff, 1, 100) === undefined) {
    errors.percentOff = { messageKey: "offers.form.error.percent" };
  }
  if (
    values.maxApplications.trim() !== "" &&
    parseWhole(values.maxApplications, 1, QUANTITY_MAX) === undefined
  ) {
    errors.maxApplications = whole;
  }
  return errors;
}

function eligibilityTooLarge(set: EligibilityIds): boolean {
  return (
    set.productIds.length > MAX_PRODUCTS ||
    set.categoryIds.length > MAX_RULE_IDS ||
    set.brandIds.length > MAX_RULE_IDS
  );
}

function ruleErrors(values: OfferFormValues, tenantWide: boolean): OfferFormErrors {
  const errors: OfferFormErrors = {};
  if (setIsEmpty(values.include)) {
    errors.include = { messageKey: "offers.form.error.includeRequired" };
  } else if (eligibilityTooLarge(values.include) || eligibilityTooLarge(values.exclude)) {
    errors.include = { messageKey: "offers.form.error.tooManyRules" };
  }
  if (values.scope === "all" && !tenantWide) {
    errors.storeIds = { messageKey: "offers.form.error.allStoresNotAllowed" };
  } else if (values.scope === "stores" && values.storeIds.length === 0) {
    errors.storeIds = { messageKey: "offers.form.error.storesRequired" };
  } else if (values.storeIds.length > MAX_STORES) {
    errors.storeIds = {
      messageKey: "offers.form.error.tooManyStores",
      params: { max: MAX_STORES },
    };
  }
  return errors;
}

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function scheduleErrors(values: OfferFormValues): OfferFormErrors {
  const errors: OfferFormErrors = {};
  if (!LOCAL_TIME.test(values.startsAt)) {
    errors.startsAt = { messageKey: "offers.form.error.startRequired" };
  }
  if (values.endsAt !== "") {
    if (!LOCAL_TIME.test(values.endsAt)) {
      errors.endsAt = { messageKey: "offers.form.error.endInvalid" };
    } else if (!errors.startsAt && values.endsAt <= values.startsAt) {
      // Same-format local times compare as strings.
      errors.endsAt = { messageKey: "offers.form.error.endBeforeStart" };
    }
  }
  return errors;
}

/** Every error at once, so the summary lists them all. Empty when the form may be sent. */
export function validateOfferForm(values: OfferFormValues, tenantWide: boolean): OfferFormErrors {
  return {
    ...nameErrors(values),
    ...parameterErrors(values),
    ...ruleErrors(values, tenantWide),
    ...scheduleErrors(values),
  };
}

// --- The definition ----------------------------------------------------------------------------

/** Only the dimensions that name something go on the wire. */
function idsBody(set: EligibilityIds): Partial<EligibilityIds> {
  return {
    ...(set.productIds.length > 0 ? { productIds: set.productIds } : {}),
    ...(set.categoryIds.length > 0 ? { categoryIds: set.categoryIds } : {}),
    ...(set.brandIds.length > 0 ? { brandIds: set.brandIds } : {}),
  };
}

export type OfferDefinitionResult =
  | { ok: true; definition: OfferDefinition }
  | { ok: false; errors: OfferFormErrors };

/** The complete `OfferDefinition` for a valid form; otherwise the errors, and nothing is sent. */
export function buildDefinition(
  values: OfferFormValues,
  tenantWide: boolean,
): OfferDefinitionResult {
  const errors = validateOfferForm(values, tenantWide);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const nameEn = values.nameEn.trim();
  const maxApps = values.maxApplications.trim();
  const exclude = idsBody(values.exclude);
  return {
    ok: true,
    definition: {
      nameAr: values.nameAr.trim(),
      ...(nameEn === "" ? {} : { nameEn }),
      type: "buy_x_get_y_percent",
      parameters: {
        buyQuantity: Number(normalizeLevel(values.buyQuantity)),
        getQuantity: Number(normalizeLevel(values.getQuantity)),
        percentOff: String(Number(normalizeLevel(values.percentOff))),
        rewardSelection: "cheapest",
        maxApplicationsPerSale: maxApps === "" ? null : Number(normalizeLevel(maxApps)),
        priceBasis: "resolved_store_price",
      },
      eligibility: {
        include: idsBody(values.include),
        ...(Object.keys(exclude).length > 0 ? { exclude } : {}),
      },
      storeScope: values.scope === "all" ? { allStores: true } : { storeIds: [...values.storeIds] },
      schedule: {
        timeBasis: "store_local",
        startsAt: values.startsAt,
        endsAt: values.endsAt === "" ? null : values.endsAt,
      },
      offlinePolicy: values.offlinePolicy,
    } as OfferDefinition,
  };
}
