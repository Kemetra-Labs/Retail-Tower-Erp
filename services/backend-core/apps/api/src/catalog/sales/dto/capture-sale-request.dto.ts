/**
 * capture-sale-request.dto.ts — 008 US1 (T035).
 *
 * Strict Zod schema for the `captureSale` request body, mirroring the
 * `CaptureSaleRequest` schema in
 * `packages/contracts/openapi/pos-sales/sales.yaml`.
 *
 * `.strict()` enforces the FR-061/062 mass-assignment ban at the boundary:
 * tenant_id / store_id / created_by / received_at / business_date /
 * processed_at / mismatch_flag are NOT accepted from the body — they resolve
 * server-side. Any unknown key → deterministic validation failure.
 *
 * Money + quantity are exact-decimal STRINGS (gate A.6 — no float ever): the
 * service round-trips them to Postgres `numeric` and never parses them into a
 * JS number.
 *
 * Money is NON-NEGATIVE (B1-3): every sale-capture money column carries a
 * `>= 0` CHECK in `0012_sales.sql` (`sales_pos_total_non_negative`,
 * `sale_lines_unit_price_non_negative`, `sale_lines_line_amount_non_negative`,
 * `sale_lines_tax_amount_non_negative`). The DTO rejects a leading `-` at the
 * boundary so a negative amount fails as a deterministic 400 instead of 500'ing
 * on the DB CHECK — the same posture `RecordRefundRequestSchema` takes for
 * `posRefundAmount`. Signed money lives only on flows the domain explicitly
 * allows it (none in capture); the OpenAPI `CaptureSale*` schemas mirror this
 * via `NonNegativeDecimalAmount`.
 */
import { z } from "zod";
import { boundedArray } from "../../../common/bounded-array";
import { hasNoNul, NO_NUL_MESSAGE } from "../../../common/text-validation";

/**
 * Exact-decimal NON-NEGATIVE money string: up to 15 integer + 4 fractional
 * digits, no leading `-`. (B1-3 — mirrors the DB `>= 0` CHECKs.)
 */
const decimalAmount = z
  .string()
  .regex(/^\d{1,15}(\.\d{1,4})?$/, "must be a non-negative exact-decimal string");

/**
 * Line quantity: `numeric(19,6)` allows 13 integer digits (precision − scale)
 * and 6 fractional digits. A 15-digit integer pattern (copied from scale-4
 * money) overflows the column and becomes PG 22003.
 */
const quantityAmount = z
  .string()
  .regex(/^\d{1,13}(\.\d{1,6})?$/, "must be a non-negative decimal string");

/** ISO-4217 alphabetic currency code. */
const currencyCode = z.string().regex(/^[A-Z]{3}$/, "must be an ISO-4217 code");

/** RT-740 (OD-28-9): the closed manual-discount reason codes. Codes only, never free text. */
export const DISCOUNT_REASON_CODES = [
  "promotion",
  "loyal_or_contract_customer",
  "near_expiry_or_damaged",
  "price_correction",
] as const;

/** RT-740 (OD-28-2): a whole percent 1–100, no leading zero, no fraction. */
const WHOLE_PERCENT = /^(100|[1-9]\d?)$/;

/** A strictly positive exact-decimal money string (≤ 15 integer, ≤ 4 fractional digits). */
const POSITIVE_DECIMAL = /^(?!0+(?:\.0+)?$)\d{1,15}(\.\d{1,4})?$/;

/**
 * RT-740 (contract `CaptureSaleLineDiscount`, RT-699 doc 28 option C-A): a
 * line's one manual discount. The shape rules are here (400); the arithmetic
 * needs the line and its currency, so it runs in `findLinePricingViolation`
 * (422 `sale_line_pricing_invalid`).
 */
export const CaptureSaleLineDiscountSchema = z
  .object({
    kind: z.enum(["percent", "amount"]),
    value: decimalAmount,
    amount: decimalAmount,
    reasonCode: z.enum(DISCOUNT_REASON_CODES),
    authoritySource: z.enum(["cashier_approval", "manager_session"]),
    approverRole: z.enum(["manager", "admin"]),
    approverUserId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.kind === "percent" && !WHOLE_PERCENT.test(d.value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "must be a whole percent from 1 to 100" });
    } else if (d.kind === "amount" && !POSITIVE_DECIMAL.test(d.value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "must be a positive exact-decimal amount" });
    }
  });

/** A calendar date `YYYY-MM-DD` in years 0001-9999 that exists (the DB `date` range of 0089). */
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date")
  .refine((value) => {
    if (value.startsWith("0000")) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "must be a real calendar date");

/**
 * RT-451 S3 (contract `CaptureSaleLineTracking`, RT-450): the identity a line
 * of a batch-tracked product sold, as the till received it from the TLV. A
 * sale fact (hashed, frozen on the line). Its shape is a 400; what it names is
 * classified by the service (G7-9) while tracked selling is on, and stored as
 * received (provenance, unclassified) while it is off: never refused for what
 * it names (sales.yaml 1.21.0; RT-451 comment 16269).
 */
const CaptureSaleLineTrackingSchema = z
  .object({
    identityId: z.string().uuid(),
    code: z.string().min(1).max(128).refine(hasNoNul, NO_NUL_MESSAGE),
    expiryDate: calendarDate.optional(),
    selection: z.enum(["scanned", "fefo_suggested", "operator_selected"]),
    validationId: z.string().uuid().optional(),
  })
  .strict();

/**
 * RT-1335 / RT-1337 (contract `CaptureSaleLinePromotion`, spec 048 §8): the
 * frozen fact of an automatic offer on a line, as the till applied it from the
 * Offer Pack. The shape is here (400); the arithmetic and the rule-level check
 * need the offer version and the Pack revision it cites, so they run in
 * `sale-promotions.ts` (422 `sale_line_pricing_invalid` for arithmetic; a
 * rule-level difference is accepted and flagged, OD-9).
 */
const CaptureSaleLinePromotionSchema = z
  .object({
    offerId: z.string().uuid().transform((id) => id.toLowerCase()),
    offerVersion: z.number().int().min(1).max(2_147_483_647),
    packRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    discountAmount: decimalAmount,
  })
  .strict();

export const CaptureSaleLineSchema = z
  .object({
    lineName: z.string().min(1).max(500).refine(hasNoNul, NO_NUL_MESSAGE),
    unitPrice: decimalAmount,
    currencyCode,
    quantity: quantityAmount,
    lineAmount: decimalAmount,
    taxAmount: decimalAmount.optional(),
    unit: z.string().min(1).max(50).refine(hasNoNul, NO_NUL_MESSAGE),
    tenantProductRef: z.string().uuid().optional(),
    // RT-740: optional manual discount; when present, lineAmount is the net.
    // A sale fact (hashed), not stored in this version.
    discount: CaptureSaleLineDiscountSchema.optional(),
    // RT-451 S3: the line's tracking identity (hashed; frozen on the line).
    tracking: CaptureSaleLineTrackingSchema.optional(),
    // RT-1337 (spec 048): an automatic offer's frozen fact; lineAmount is then the net after it. Hashed and stored.
    promotion: CaptureSaleLinePromotionSchema.optional(),
  })
  .strict();

/**
 * RT-1051 (owner decision, Jira RT-1051 comment 15572, 2026-11-05): the most lines one
 * captured sale carries; mirrored as `CaptureSaleRequest.lines.maxItems` in sales.yaml.
 * The POS caps a cart at 30 lines (RT-1052), so this is a server-side safety bound.
 */
export const MAX_CAPTURE_LINES = 500;

/**
 * RT-1051 (owner decision 2026-11-05, chat: "Start with 16"; Jira RT-1051): the most tenders one
 * captured sale carries; mirrored as `CaptureSaleRequest.tenders.maxItems` in sales.yaml. One
 * tender per method plus same-method splits (RT-360); 16 matches the refund-tender bound.
 */
export const MAX_CAPTURE_TENDERS = 16;

/**
 * RT-225 ([GATED] approval: Jira RT-225, owner, 2026-10-05): the widest
 * allowed gap between `admissionCheckAt` and `occurredAt`.
 */
export const MAX_ADMISSION_CHECK_GAP_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * An RFC 3339 UTC instant (`z.string().datetime()`: `...THH:MM:SS[.f+]Z`)
 * split into its whole-second epoch milliseconds and its fraction digits, so
 * two instants compare at FULL precision (Date.parse truncates to the
 * millisecond; Postgres keeps microseconds).
 */
interface Instant {
  readonly secondsMs: number;
  readonly fraction: string;
}

function toInstant(value: string): Instant {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value);
  return { secondsMs: Date.parse(`${match?.[1] ?? value}Z`), fraction: match?.[2] ?? "" };
}

/** -1, 0 or 1 as `a` is before, equal to or after `b` (shifted by `shiftMs`). */
function compareInstants(a: Instant, b: Instant, shiftMs = 0): number {
  const bSeconds = b.secondsMs + shiftMs;
  if (a.secondsMs !== bSeconds) return a.secondsMs < bSeconds ? -1 : 1;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const fa = a.fraction.padEnd(width, "0");
  const fb = b.fraction.padEnd(width, "0");
  if (fa === fb) return 0;
  return fa < fb ? -1 : 1;
}

/**
 * RT-225: the cross-field rules for `admissionCheckAt` (sales.yaml
 * 1.6.0-draft states them in prose; OpenAPI cannot express them). Each breach
 * is a validation issue, so the usual 400 `validation_error`:
 *   - allowed ONLY with `operatorUserId` (the device path);
 *   - `admissionCheckAt <= occurredAt`;
 *   - `occurredAt - admissionCheckAt <= 7 days`.
 */
function checkAdmissionCheckAt(
  body: {
    occurredAt: string;
    operatorUserId?: string | undefined;
    admissionCheckAt?: string | undefined;
    lines?: ReadonlyArray<{ promotion?: unknown; discount?: unknown }> | undefined;
    responsibilities?: ReadonlyArray<unknown> | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  // RT-1337 (OD-5): offers are exclusive of the manual discount; both on one line is a 400.
  body.lines?.forEach((l, i) => {
    if (l.promotion !== undefined && l.discount !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines", i, "promotion"], message: "a line cannot carry both an offer promotion and a manual discount" });
    }
    // RT-1337: a credit sale (a responsibility on the envelope) returns through the credit reversal, which does not
    // settle an offer clawback yet; an offer on such a sale would refund the discount twice. Refused until it does.
    if (l.promotion !== undefined && (body.responsibilities?.length ?? 0) > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines", i, "promotion"], message: "an offer promotion cannot be combined with sale responsibilities (credit sale)" });
    }
  });
  if (body.admissionCheckAt === undefined) return;
  const path = ["admissionCheckAt"];
  if (body.operatorUserId === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "allowed only with operatorUserId" });
    return;
  }
  const checkAt = toInstant(body.admissionCheckAt);
  const occurredAt = toInstant(body.occurredAt);
  if (compareInstants(checkAt, occurredAt) > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "must not be after occurredAt" });
  } else if (compareInstants(occurredAt, checkAt, MAX_ADMISSION_CHECK_GAP_MS) > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "must be at most 7 days before occurredAt" });
  }
}

/**
 * RT-539 (sales.yaml 1.9.0-draft, RT-537): the receipt snapshot, the facts the
 * original receipt printed that are not sale facts. Presentation only: it is
 * never used for authorization, attribution or scope (FR-061), and the
 * controller keeps it out of payload_hash. The bounds are the contract's.
 */
export const CaptureSaleReceiptSchema = z
  .object({
    saleNumber: z.string().min(1).max(96).refine(hasNoNul, NO_NUL_MESSAGE),
    receiptNumber: z.string().min(1).max(96).refine(hasNoNul, NO_NUL_MESSAGE).optional(),
    terminalLabel: z.string().min(1).max(64).refine(hasNoNul, NO_NUL_MESSAGE),
    operatorDisplayName: z.string().min(1).refine(hasNoNul, NO_NUL_MESSAGE),
    // Year 0000 is not a Postgres timestamptz (22008): a 400, never a 500.
    settledAt: z
      .string()
      .datetime()
      .refine((value) => !value.startsWith("0000"), "must be a representable instant"),
    branchName: z.string().min(1).max(256).refine(hasNoNul, NO_NUL_MESSAGE),
    branchAddress: z.string().min(1).max(512).refine(hasNoNul, NO_NUL_MESSAGE),
    taxRegistrationId: z.string().min(1).max(64).refine(hasNoNul, NO_NUL_MESSAGE),
    changeGiven: decimalAmount.optional(),
  })
  .strict();

/**
 * RT-418 (contract RT-417, `PositiveDecimalAmount`): a strictly positive
 * exact-decimal money string, at most 15 integer and 4 fractional digits.
 */
const positiveDecimalAmount = z
  .string()
  .regex(/^(?!0+(?:\.0+)?$)\d{1,15}(\.\d{1,4})?$/, "must be a positive exact-decimal string");

/**
 * RT-418 (contract RT-417 `SaleResponsibility`, owner decision R-1): one
 * payer's share of the sale. `sequence` is bounded by its SMALLINT column.
 */
export const SaleResponsibilitySchema = z
  .object({
    payerRef: z.string().uuid("must be a uuid"),
    amount: positiveDecimalAmount,
    sequence: z.number().int().min(1).max(32767),
  })
  .strict();

/**
 * At most ONE payer per sale in this version (`maxItems: 1`): the posting
 * feed acknowledges one Sales Invoice per work item. `payerRef` and
 * `sequence` are unique within the sale (vacuous at one entry, kept for the
 * contract rule). The coverage rule and payer eligibility need the database
 * and run in the service (422).
 */
const responsibilityList = boundedArray(
  1,
  z
    .array(SaleResponsibilitySchema)
    .min(1)
    .superRefine((rs, ctx) => {
      if (hasRepeat(rs.map((r) => r.payerRef))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "payerRef must be unique within the sale" });
      }
      if (hasRepeat(rs.map((r) => r.sequence))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sequence must be unique within the sale" });
      }
    }),
);

/**
 * The capture body's object shape (strict). The exported schemas below add
 * the RT-225 cross-field refinement; use this one only for shape
 * introspection or extension.
 */
const CaptureSaleRequestObject = z
  .object({
    sourceSystem: z.string().min(1).max(100).refine(hasNoNul, NO_NUL_MESSAGE),
    externalId: z.string().min(1).max(200).refine(hasNoNul, NO_NUL_MESSAGE),
    currencyCode,
    posTotal: decimalAmount,
    occurredAt: z.string().datetime(),
    sourceClockAt: z.string().datetime().optional(),
    lines: boundedArray(MAX_CAPTURE_LINES, z.array(CaptureSaleLineSchema).min(1)),
    // RT-224 (Option B): the cashier's users.id on the device-bearer path. A
    // CLAIM: SaleCaptureAuthGuard verifies it against a covering cashier
    // admission before the handler runs, and the handler records the
    // guard-verified actor, never this field. Its presence selects the
    // device path (sales.yaml 1.5.0-draft).
    operatorUserId: z.string().uuid().optional(),
    // RT-225: the till's instant at which the cashier's admission held for
    // this sale (its settled time). It replaces occurredAt ONLY in the
    // admission-window comparison; it is never a sale fact (the controller
    // drops it before payload_hash). Device path only; see
    // checkAdmissionCheckAt for the cross-field rules.
    admissionCheckAt: z.string().datetime().optional(),
    // RT-539: the optional receipt snapshot (first write wins; not hashed).
    receipt: CaptureSaleReceiptSchema.optional(),
    // RT-418: who owes the part of the sale not paid at the till. A sale fact
    // (hashed); accepted on the operatorAuthorization path only (the service
    // refuses it on the device path, after a replay resolves).
    responsibilities: responsibilityList.optional(),
    // RT-451 S3 (RT-50 G7-7): the Inventory Safety Revision the till held and
    // when it last synced it. Provenance, never a sale fact: the controller
    // drops both from payload_hash (they stay in the idempotency fingerprint)
    // and they are stored first-write-wins whatever the switch state.
    safetyRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    // Year 0000 is not a Postgres timestamptz (22008): a 400, never a 500.
    safetySyncedAt: z
      .string()
      .datetime()
      .refine((value) => !value.startsWith("0000"), "must be a representable instant")
      .optional(),
  })
  .strict();

export const CaptureSaleRequestSchema = CaptureSaleRequestObject.superRefine(checkAdmissionCheckAt);

/**
 * RT-77 (RT-10 D1/D2) — one way the sale was paid, mirroring `SaleTender` in
 * `sales.yaml`. `amount` is NET of change and non-negative (the contract's
 * NonNegativeDecimalAmount; RT-77 comment 10509). `reference` is the card
 * terminal's short code, card_external only — never card data.
 */
/**
 * RT-360 (contract RT-359): the tender line's identity, minted by the POS, and
 * its 1-based apply order. `sequence` is bounded by its SMALLINT column.
 */
const tenderLineIdentity = {
  tenderRef: z.string().uuid("must be a uuid").optional(),
  sequence: z.number().int().min(1).max(32767).optional(),
};

const CashTenderSchema = z.object({ method: z.literal("cash"), amount: decimalAmount, ...tenderLineIdentity }).strict();

const CardExternalTenderSchema = z
  .object({
    method: z.literal("card_external"),
    amount: decimalAmount,
    reference: z
      .string()
      .regex(/^[A-Z0-9]{1,6}$/, "must be a short card terminal reference")
      .optional(),
    ...tenderLineIdentity,
  })
  .strict();

/**
 * RT-1114 (RT-1098 R-4a, decision 4A: a voucher is a tender): the voucher pays
 * `amount` of the sale through the redemption `redemptionId` names (V-A's
 * `redemption_id`, returned by `posRedeemVoucher`). REQUIRED on a voucher and
 * accepted on no other method (a strict object each, so a cash or card tender
 * carrying it is a 400). No `reference`. Whether the redemption is real, live,
 * of this tenant and store, unused and for exactly this amount is the
 * service's 422 `sale_voucher_tender_invalid`.
 */
const VoucherTenderSchema = z
  .object({
    method: z.literal("voucher"),
    amount: decimalAmount,
    redemptionId: z.string().uuid("must be a uuid"),
    ...tenderLineIdentity,
  })
  .strict();

/** The RT-10 D2 tender methods: what capture accepts while voucher tenders are off. */
export const SaleTenderSchema = z.discriminatedUnion("method", [CashTenderSchema, CardExternalTenderSchema]);

/**
 * RT-1114: the same, plus `voucher`. Selected only while
 * `POS_SALE_VOUCHER_TENDER_ENABLED` is on (default off until R-4b is deployed).
 */
export const SaleTenderWithVoucherSchema = z.discriminatedUnion("method", [
  CashTenderSchema,
  CardExternalTenderSchema,
  VoucherTenderSchema,
]);

type SaleTenderInput = z.infer<typeof SaleTenderWithVoucherSchema>;

/** True when `values` holds a repeat; `undefined` entries are ignored. */
function hasRepeat(values: ReadonlyArray<string | number | undefined>): boolean {
  const present = values.filter((v) => v !== undefined);
  return new Set(present).size !== present.length;
}

/**
 * The per-sale tender rules (contract RT-359), each a 400: `tenderRef` and
 * `sequence` are unique within the sale; more than one tender of a method is
 * accepted only when `allowSameMethod` (the RT-360 deploy gate) AND every
 * entry carries a `tenderRef`. RT-1114: with `allowVoucher` (its deploy gate)
 * the list also takes `voucher` tenders, and a `redemptionId` is unique within
 * the sale (one redemption pays one tender).
 */
function tenderList(allowSameMethod: boolean, allowVoucher = false) {
  const rules = (ts: SaleTenderInput[], ctx: z.RefinementCtx): void => {
    if (hasRepeat(ts.map((t) => t.tenderRef))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "tenderRef must be unique within the sale" });
    }
    if (hasRepeat(ts.map((t) => t.sequence))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "sequence must be unique within the sale" });
    }
    // A uuid is case-insensitive (zod accepts either case; Postgres compares the value), so the
    // repeat check lower-cases it: a repeat in another case is the same redemption (400, not 500).
    if (hasRepeat(ts.map((t) => (t.method === "voucher" ? t.redemptionId.toLowerCase() : undefined)))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "redemptionId must be unique within the sale" });
    }
    if (!hasRepeat(ts.map((t) => t.method))) return;
    if (!allowSameMethod) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "at most one tender per method" });
    } else if (ts.some((t) => t.tenderRef === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tenders sharing a method must each carry a tenderRef",
      });
    }
  };
  // RT-1051: the length is checked before any tender (zod GHSA-mrhx-c7xc-m3w5).
  const tender: z.ZodType<SaleTenderInput, z.ZodTypeDef, unknown> = allowVoucher
    ? SaleTenderWithVoucherSchema
    : SaleTenderSchema;
  return boundedArray(MAX_CAPTURE_TENDERS, z.array(tender).min(1).superRefine(rules)).optional();
}

/**
 * The tender-aware capture body (RT-77). Selected by `CaptureSaleRequestPipe`
 * only while `POS_SALE_TENDERS_ENABLED` is on; `CaptureSaleRequestSchema`
 * above stays the pre-RT-77 boundary. At most one entry per method — a
 * duplicate is a validation failure (400), per the contract. The Σ = posTotal
 * rule needs exact decimal math and runs in the service (422).
 */
export const CaptureSaleRequestWithTendersSchema = CaptureSaleRequestObject.extend({
  tenders: tenderList(false),
})
  .strict()
  .superRefine(checkAdmissionCheckAt);

/**
 * RT-360 — the same body, also accepting same-method split tenders that each
 * carry a `tenderRef`. Selected only while `POS_SALE_TENDERS_SAME_METHOD_ENABLED`
 * is on as well (after RT-361).
 */
export const CaptureSaleRequestWithSameMethodTendersSchema = CaptureSaleRequestObject.extend({
  tenders: tenderList(true),
})
  .strict()
  .superRefine(checkAdmissionCheckAt);

/**
 * RT-1114 — the tender-aware body that also accepts `voucher` tenders. Selected
 * only while `POS_SALE_VOUCHER_TENDER_ENABLED` is on as well (after R-4b,
 * RT-1330, is deployed; default off).
 */
export const CaptureSaleRequestWithVoucherTendersSchema = CaptureSaleRequestObject.extend({
  tenders: tenderList(false, true),
})
  .strict()
  .superRefine(checkAdmissionCheckAt);

/** RT-1114 — same-method split tenders (RT-360) and `voucher` tenders together. */
export const CaptureSaleRequestWithSameMethodVoucherTendersSchema = CaptureSaleRequestObject.extend({
  tenders: tenderList(true, true),
})
  .strict()
  .superRefine(checkAdmissionCheckAt);

/** The widest capture body: every gated tender shape, so the service handles each one. */
export type CaptureSaleRequestDto = z.infer<typeof CaptureSaleRequestWithSameMethodVoucherTendersSchema>;
export type SaleTenderDto = z.infer<typeof SaleTenderWithVoucherSchema>;
export type CaptureSaleLineDto = z.infer<typeof CaptureSaleLineSchema>;
export type CaptureSaleLineDiscountDto = z.infer<typeof CaptureSaleLineDiscountSchema>;
export type CaptureSaleReceiptDto = z.infer<typeof CaptureSaleReceiptSchema>;
export type SaleResponsibilityDto = z.infer<typeof SaleResponsibilitySchema>;
