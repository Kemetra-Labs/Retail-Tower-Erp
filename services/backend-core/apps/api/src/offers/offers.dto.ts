/**
 * The boundary of `offers.openapi.yaml` (Jira RT-1337, RT-286 S4): the offer
 * definition (spec 048 §5), the Console requests and the list query, as strict
 * zod schemas. A failed parse is the shared pipe's 400 `validation_error`,
 * checked before any database read.
 *
 * `OfferDefinition` is validated whole at create and edit (a complete body),
 * stored as the draft JSON, and frozen into the version rows at publish. The
 * references (do the products, categories, brands and stores exist?) are NOT
 * checked here: a draft can be saved while the catalog is prepared, and
 * preview and publish report `offer_reference_invalid`.
 */
import { z } from "zod";

import { hasNoNul, maxCodePoints, wellFormedText } from "../common/text-validation";
import { normaliseLocal, parseLocalDateTime } from "./offer-schedule";

export const OFFER_PAGE_SIZE_DEFAULT = 50;
const OFFER_PAGE_SIZE_MAX = 100;

const uuid = z.string().uuid().transform((id) => id.toLowerCase());

const idList = (max: number) =>
  z
    .array(uuid)
    .max(max)
    .superRefine((ids, ctx) => {
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must not repeat an id" });
      }
    });

const text = (min: number, max: number) =>
  z
    .string()
    .refine(hasNoNul, "must not contain a NUL character")
    .superRefine(wellFormedText)
    .superRefine(maxCodePoints(max))
    .refine((v) => [...v].length >= min, `must be at least ${min} character`);

const WholePercent = z.string().regex(/^(100|[1-9][0-9]?)$/);

const BuyXGetYPercentParametersSchema = z
  .object({
    buyQuantity: z.number().int().min(1).max(1000),
    getQuantity: z.number().int().min(1).max(1000),
    percentOff: WholePercent,
    rewardSelection: z.literal("cheapest"),
    maxApplicationsPerSale: z.number().int().min(1).max(1000).nullable(),
    priceBasis: z.literal("resolved_store_price"),
  })
  .strict();

const EligibilitySetSchema = z
  .object({
    productIds: idList(5000).optional(),
    categoryIds: idList(500).optional(),
    brandIds: idList(500).optional(),
  })
  .strict();

const EligibilitySchema = z
  .object({
    include: EligibilitySetSchema.refine(
      (s) => (s.productIds?.length ?? 0) + (s.categoryIds?.length ?? 0) + (s.brandIds?.length ?? 0) > 0,
      "include must name at least one product, category or brand",
    ),
    exclude: EligibilitySetSchema.optional(),
  })
  .strict();

const StoreScopeSchema = z.union([
  z.object({ allStores: z.literal(true) }).strict(),
  z.object({ storeIds: idList(500).refine((ids) => ids.length >= 1, "must name at least one store") }).strict(),
]);

type ScheduleInput = { timeBasis: "store_local" | "absolute"; startsAt: string; endsAt?: string | null | undefined };

/** `store_local`: real local date-times without an offset, the end after the start. */
function checkLocalSchedule(s: ScheduleInput, bad: (path: string, message: string) => void): void {
  const start = parseLocalDateTime(s.startsAt);
  if (start === null) bad("startsAt", "must be a local date-time such as 2026-12-01T00:00");
  const end = s.endsAt === undefined || s.endsAt === null ? null : parseLocalDateTime(s.endsAt);
  if (s.endsAt !== undefined && s.endsAt !== null && end === null) bad("endsAt", "must be a local date-time such as 2026-12-31T23:59");
  if (start !== null && end !== null && end <= start) bad("endsAt", "must be after startsAt");
}

const OFFSET_INSTANT = /(Z|[+-]\d{2}:\d{2})$/;
const instantMs = (value: string): number => (OFFSET_INSTANT.test(value) ? Date.parse(value) : Number.NaN);

/** `absolute`: RFC 3339 instants with an offset, the end after the start. */
function checkAbsoluteSchedule(s: ScheduleInput, bad: (path: string, message: string) => void): void {
  const start = instantMs(s.startsAt);
  if (Number.isNaN(start)) bad("startsAt", "must be an RFC 3339 instant with an offset");
  const hasEnd = s.endsAt !== undefined && s.endsAt !== null;
  const end = hasEnd ? instantMs(s.endsAt!) : null;
  if (hasEnd && Number.isNaN(end)) bad("endsAt", "must be an RFC 3339 instant with an offset");
  if (!Number.isNaN(start) && end !== null && !Number.isNaN(end) && end <= start) bad("endsAt", "must be after startsAt");
}

const ScheduleSchema = z
  .object({
    timeBasis: z.enum(["store_local", "absolute"]),
    startsAt: z.string().max(40),
    endsAt: z.string().max(40).nullable().optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const bad = (path: string, message: string): void => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (s.timeBasis === "store_local") checkLocalSchedule(s, bad);
    else checkAbsoluteSchedule(s, bad);
  });

export const OfferDefinitionSchema = z
  .object({
    nameAr: text(1, 120),
    nameEn: text(1, 120).nullable().optional(),
    type: z.literal("buy_x_get_y_percent"),
    parameters: BuyXGetYPercentParametersSchema,
    eligibility: EligibilitySchema,
    storeScope: StoreScopeSchema,
    schedule: ScheduleSchema,
    offlinePolicy: z.enum(["allow_cached", "online_only"]).optional(),
  })
  .strict();

export type OfferDefinitionInput = z.infer<typeof OfferDefinitionSchema>;

/** The normalised definition: defaults filled, `nameEn` explicit, schedule times canonical. Stored as the draft JSON. */
export interface OfferDefinition {
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly type: "buy_x_get_y_percent";
  readonly parameters: {
    readonly buyQuantity: number;
    readonly getQuantity: number;
    readonly percentOff: string;
    readonly rewardSelection: "cheapest";
    readonly maxApplicationsPerSale: number | null;
    readonly priceBasis: "resolved_store_price";
  };
  readonly eligibility: {
    readonly include: EligibilityIds;
    readonly exclude?: EligibilityIds;
  };
  readonly storeScope: { readonly allStores: true } | { readonly storeIds: ReadonlyArray<string> };
  readonly schedule: { readonly timeBasis: "store_local" | "absolute"; readonly startsAt: string; readonly endsAt: string | null };
  readonly offlinePolicy: "allow_cached" | "online_only";
}

export interface EligibilityIds {
  readonly productIds?: ReadonlyArray<string>;
  readonly categoryIds?: ReadonlyArray<string>;
  readonly brandIds?: ReadonlyArray<string>;
}

type EligibilityInput = { productIds?: ReadonlyArray<string> | undefined; categoryIds?: ReadonlyArray<string> | undefined; brandIds?: ReadonlyArray<string> | undefined };

const compact = (s: EligibilityInput | undefined): EligibilityIds | undefined => {
  if (s === undefined) return undefined;
  const out: { productIds?: string[]; categoryIds?: string[]; brandIds?: string[] } = {};
  if (s.productIds && s.productIds.length > 0) out.productIds = [...s.productIds].sort();
  if (s.categoryIds && s.categoryIds.length > 0) out.categoryIds = [...s.categoryIds].sort();
  if (s.brandIds && s.brandIds.length > 0) out.brandIds = [...s.brandIds].sort();
  return Object.keys(out).length === 0 ? undefined : out;
};

export function normaliseDefinition(input: OfferDefinitionInput): OfferDefinition {
  const exclude = compact(input.eligibility.exclude);
  const local = input.schedule.timeBasis === "store_local";
  return {
    nameAr: input.nameAr,
    nameEn: input.nameEn ?? null,
    type: input.type,
    parameters: { ...input.parameters },
    eligibility: { include: compact(input.eligibility.include)!, ...(exclude ? { exclude } : {}) },
    storeScope: "allStores" in input.storeScope ? { allStores: true } : { storeIds: [...input.storeScope.storeIds].sort() },
    schedule: {
      timeBasis: input.schedule.timeBasis,
      startsAt: local ? normaliseLocal(input.schedule.startsAt) : new Date(input.schedule.startsAt).toISOString(),
      endsAt:
        input.schedule.endsAt === undefined || input.schedule.endsAt === null
          ? null
          : local
            ? normaliseLocal(input.schedule.endsAt)
            : new Date(input.schedule.endsAt).toISOString(),
    },
    offlinePolicy: input.offlinePolicy ?? "allow_cached",
  };
}

export const OfferCreateSchema = z.object({ definition: OfferDefinitionSchema }).strict();
export const OfferUpdateSchema = z
  .object({ expectedDraftRevision: z.number().int().min(1).nullable(), definition: OfferDefinitionSchema })
  .strict();

const SimulationLineSchema = z
  .object({
    unitPrice: z.string().regex(/^[0-9]{1,15}(\.[0-9]{1,4})?$/),
    quantity: z.number().int().min(1).max(999).optional(),
    productId: uuid.optional(),
  })
  .strict();

export const OfferPreviewSchema = z
  .object({
    expectedDraftRevision: z.number().int().min(1).optional(),
    simulation: z
      .object({
        currencyCode: z.string().regex(/^[A-Z]{3}$/),
        lines: z.array(SimulationLineSchema).min(1).max(100),
      })
      .strict()
      .optional(),
  })
  .strict();

export const OfferPublishSchema = z.object({ expectedDraftRevision: z.number().int().min(1) }).strict();

export const OfferPauseSchema = z
  .object({
    reason: text(1, 500),
    storeIds: idList(500).refine((ids) => ids.length >= 1, "must name at least one store").optional(),
  })
  .strict();

export const OfferResumeSchema = z
  .object({ storeIds: idList(500).refine((ids) => ids.length >= 1, "must name at least one store").optional() })
  .strict();

export const OfferIdParamSchema = z.string().uuid("offer_id is not a UUID").transform((id) => id.toLowerCase());

/** The keyset paging parameters of both list reads (`Cursor`, `PageSize`). */
const pagingFields = {
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
  page_size: z.coerce.number().int().min(1).max(OFFER_PAGE_SIZE_MAX).optional(),
};

export const OfferListQuerySchema = z
  .object({
    state: z.enum(["draft", "scheduled", "active", "paused", "ended", "archived"]).optional(),
    store_id: z.string().uuid().transform((id) => id.toLowerCase()).optional(),
    ...pagingFields,
  })
  .strict();

export type OfferListQuery = z.infer<typeof OfferListQuerySchema>;

export const OfferVersionListQuerySchema = z.object(pagingFields).strict();

export type OfferVersionListQuery = z.infer<typeof OfferVersionListQuerySchema>;
export type OfferCreateBody = z.infer<typeof OfferCreateSchema>;
export type OfferUpdateBody = z.infer<typeof OfferUpdateSchema>;
export type OfferPreviewBody = z.infer<typeof OfferPreviewSchema>;
export type OfferPublishBody = z.infer<typeof OfferPublishSchema>;
export type OfferPauseBody = z.infer<typeof OfferPauseSchema>;
export type OfferResumeBody = z.infer<typeof OfferResumeSchema>;
