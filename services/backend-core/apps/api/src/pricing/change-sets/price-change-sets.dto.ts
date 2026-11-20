/**
 * RT-1484 (RT-282 PR-09b) — request shapes of `pricing/price-change-sets.yaml` 1.0.0-draft for
 * the authoring operations (list, create, get, update, cancel).
 *
 * Each schema mirrors the contract (`PriceChangeItem` and its six operations, the selectors, the
 * `TimeBasisRule`, `CreatePriceChangeSetRequest`, `UpdatePriceChangeSetRequest`,
 * `VersionedRequest`) and the 0121 / 0123 CHECKs the values land in. Bodies are strict (an
 * unknown key is a 400). Beyond JSON Schema, a date-time must be a real calendar value and
 * `effectiveTo` must be after `effectiveFrom` (the contract's `WriteValidationFailure`). A failed
 * parse throws the `ZodError` the global filter answers as 400 `validation_error`.
 *
 * Money stays an exact decimal string (never a float). Whether a price is > 0 and representable
 * at the Book's minor unit is a validation finding (`price_not_positive`, spec 041 Q-4), decided
 * by `validate` (PR-4b), not a request-shape error: the contract's `DecimalPrice` admits 0.
 */
import { z } from "zod";

import { isRfc3339Instant } from "../pricing-query";

const Uuid = z.string().uuid();

const DecimalPrice = z.string().regex(/^[0-9]{1,15}(\.[0-9]{1,4})?$/, "must be an exact decimal string");
const SignedDecimal = z.string().regex(/^-?[0-9]{1,15}(\.[0-9]{1,4})?$/, "must be an exact signed decimal string");
const Percent = z.string().regex(/^-?[0-9]{1,3}(\.[0-9]{1,2})?$/, "must be a percentage with up to two decimals");

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ABSOLUTE_FRACTION_RE = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

/** A local date-time without offset (`store_local`) that names a real calendar value. */
function isLocalDateTime(value: string): boolean {
  const m = LOCAL_RE.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 59;
}

/** A local date-time as sortable text with seconds (`2026-11-01T00:00` → `2026-11-01T00:00:00`). */
function localKey(value: string): string {
  return value.length === 16 ? `${value}:00` : value;
}

/** An RFC 3339 instant as epoch microseconds (exact: `Date` keeps only milliseconds). */
function instantMicros(value: string): bigint {
  const m = ABSOLUTE_FRACTION_RE.exec(value);
  if (!m) throw new Error(`not an instant: ${value}`);
  const whole = BigInt(Date.parse(`${m[1]}${m[3]}`)) * 1000n;
  return whole + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/** True when `to` is after `from`, both in `basis`; false when either is malformed. */
export function isAfter(from: string, to: string, basis: "store_local" | "absolute"): boolean {
  if (basis === "absolute") {
    if (!isRfc3339Instant(from) || !isRfc3339Instant(to)) return false;
    return instantMicros(to) > instantMicros(from);
  }
  if (!isLocalDateTime(from) || !isLocalDateTime(to)) return false;
  return localKey(to) > localKey(from);
}

const DateTimeText = z.string().min(1).max(40);

const ScopeSelector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("book") }).strict(),
  z.object({ kind: z.literal("zone"), zoneId: Uuid }).strict(),
  z.object({ kind: z.literal("stores"), storeIds: z.array(Uuid).min(1).max(1000) }).strict(),
]);
const StoresScope = z.object({ kind: z.literal("stores"), storeIds: z.array(Uuid).min(1).max(1000) }).strict();
const ProductSelector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("items"), productIds: z.array(Uuid).min(1).max(5000) }).strict(),
  z.object({ kind: z.literal("category"), categoryId: Uuid }).strict(),
]);

const SellUnit = z.literal("each");
const TimeBasis = z.enum(["store_local", "absolute"]);

const timed = {
  sellUnit: SellUnit.optional(),
  timeBasis: TimeBasis.optional(),
  effectiveFrom: DateTimeText,
};

const PriceChangeItemSchema = z
  .discriminatedUnion("op", [
    z.object({ op: z.literal("set_price"), scope: ScopeSelector, products: ProductSelector, price: DecimalPrice, ...timed, effectiveTo: DateTimeText.optional() }).strict(),
    z.object({ op: z.literal("adjust_amount"), scope: ScopeSelector, products: ProductSelector, amount: SignedDecimal, ...timed, effectiveTo: DateTimeText.optional() }).strict(),
    z.object({ op: z.literal("adjust_percent"), scope: ScopeSelector, products: ProductSelector, percent: Percent, ...timed, effectiveTo: DateTimeText.optional() }).strict(),
    z.object({ op: z.literal("end_price"), scope: ScopeSelector, products: ProductSelector, ...timed }).strict(),
    z.object({ op: z.literal("reset_store_override"), scope: StoresScope, products: ProductSelector, ...timed }).strict(),
    z
      .object({
        op: z.literal("move_store_zone"),
        storeId: Uuid,
        zoneId: Uuid,
        timeBasis: z.literal("absolute").optional(),
        effectiveFrom: DateTimeText,
        effectiveTo: DateTimeText.optional(),
      })
      .strict(),
  ])
  .superRefine((item, ctx) => {
    checkUniqueIds(item, ctx);
    checkTimes(item, ctx);
  });
export type PriceChangeItem = z.infer<typeof PriceChangeItemSchema>;

type ParsedItem = z.infer<typeof PriceChangeItemSchema>;

/** uniqueItems on the selector id lists (ids compared in any case). */
function checkUniqueIds(item: ParsedItem, ctx: z.RefinementCtx): void {
  const unique = (ids: readonly string[], path: (string | number)[]): void => {
    if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "must not repeat an id" });
    }
  };
  if ("scope" in item && item.scope.kind === "stores") unique(item.scope.storeIds, ["scope", "storeIds"]);
  if ("products" in item && item.products.kind === "items") unique(item.products.productIds, ["products", "productIds"]);
}

/**
 * The TimeBasisRule (an offset for `absolute`, none for `store_local`; Zone moves are always
 * absolute) and `effectiveTo` after `effectiveFrom`.
 */
function checkTimes(item: ParsedItem, ctx: z.RefinementCtx): void {
  const basis = item.op === "move_store_zone" ? "absolute" : (item.timeBasis ?? "store_local");
  const valid = basis === "absolute" ? isRfc3339Instant : isLocalDateTime;
  const message =
    basis === "absolute" ? "must be an RFC 3339 date-time with an offset" : "must be a local date-time without an offset";
  const fromOk = valid(item.effectiveFrom);
  if (!fromOk) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveFrom"], message });
  const to = "effectiveTo" in item ? item.effectiveTo : undefined;
  if (to === undefined) return;
  if (!valid(to)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message });
  } else if (fromOk && !isAfter(item.effectiveFrom, to, basis)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["effectiveTo"], message: "must be after effectiveFrom" });
  }
}

const Title = z.string().min(1).max(200);
const Reason = z.string().min(1).max(1000);
const Items = z.array(PriceChangeItemSchema).max(500);
const Version = z.number().int().min(1).max(2147483647);

export const CreatePriceChangeSetBodySchema = z
  .object({
    kind: z.enum(["standard", "emergency"]),
    title: Title,
    reason: Reason.optional(),
    items: Items.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.kind === "emergency" && body.reason === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "is required for an emergency set" });
    }
  });
export type CreatePriceChangeSetBody = z.infer<typeof CreatePriceChangeSetBodySchema>;

export const UpdatePriceChangeSetBodySchema = z
  .object({ expectedVersion: Version, title: Title.optional(), reason: Reason.optional(), items: Items.optional() })
  .strict()
  .refine((b) => b.title !== undefined || b.reason !== undefined || b.items !== undefined, {
    message: "must change title, reason or items",
  });
export type UpdatePriceChangeSetBody = z.infer<typeof UpdatePriceChangeSetBodySchema>;

export const VersionedBodySchema = z.object({ expectedVersion: Version }).strict();
export type VersionedBody = z.infer<typeof VersionedBodySchema>;

// RT-1484 PR-10b: submit, approve and reject (`SubmitPriceChangeSetRequest`,
// `ApprovePriceChangeSetRequest`, `RejectPriceChangeSetRequest`).
const AcknowledgedFindings = z
  .array(z.enum(["replaces", "invalidates_dependent", "rounded_price"]))
  .refine((v) => new Set(v).size === v.length, "must not repeat a finding");

export const SubmitPriceChangeSetBodySchema = z
  .object({ expectedVersion: Version, acknowledgedFindings: AcknowledgedFindings.optional() })
  .strict();
export type SubmitPriceChangeSetBody = z.infer<typeof SubmitPriceChangeSetBodySchema>;

export const ApprovePriceChangeSetBodySchema = z
  .object({
    expectedVersion: Version,
    previewHash: z.string().regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 lower-case hex>"),
    acknowledgedFindings: AcknowledgedFindings.optional(),
  })
  .strict();
export type ApprovePriceChangeSetBody = z.infer<typeof ApprovePriceChangeSetBodySchema>;

export const RejectPriceChangeSetBodySchema = z.object({ expectedVersion: Version, reason: Reason }).strict();
export type RejectPriceChangeSetBody = z.infer<typeof RejectPriceChangeSetBodySchema>;

const PageSize = z
  .string()
  .regex(/^\d{1,3}$/, "must be an integer from 1 to 200")
  .transform((v) => Number(v))
  .refine((v) => v >= 1 && v <= 200, "must be an integer from 1 to 200");

export const ListChangeSetsQuerySchema = z.object({
  state: z
    .enum(["draft", "validated", "pending_approval", "approved", "published", "superseded", "rolled_back", "cancelled"])
    .optional(),
  kind: z.enum(["standard", "emergency", "rollback", "legacy_import"]).optional(),
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
  page_size: PageSize.optional(),
});
export type ListChangeSetsQuery = z.infer<typeof ListChangeSetsQuerySchema>;

/** `consoleGetPriceChangeSetPreview` query: an optional `class` filter, the cursor and the page size. */
export const PreviewQuerySchema = z.object({
  class: z.enum(["new", "replaces", "conflicts_pending", "shadowed", "invalidates_dependent", "past_dated", "invalid"]).optional(),
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
  page_size: PageSize.optional(),
});
export type PreviewQuery = z.infer<typeof PreviewQuerySchema>;
