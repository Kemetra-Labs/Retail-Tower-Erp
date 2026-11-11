/**
 * vouchers-admin.dto.ts — RT-1108: the boundary of `vouchers-admin.openapi.yaml`.
 *
 *   - `VoucherIssueSchema`: strict (a client `code` or `tenant_id` is refused),
 *     `count` 1..100, `amount_minor` an integer 1..2^53-1 (the `vouchers` CHECK
 *     bound), `expires_at` null or in the future, the all-stores / subset rule,
 *     `note` at most 200 code points.
 *   - `VoucherListQuerySchema`: the filters, the opaque cursor and `page_size`.
 *   - `ContractValidationPipe`: a failed parse is the contract's
 *     `validation_failure` (the shared pipe answers `validation_error`).
 *   - the wire projections. No read projection has a `code` or `code_hash`.
 */
import { BadRequestException, type ArgumentMetadata, type PipeTransform } from "@nestjs/common";
import type { ZodTypeAny, infer as ZodInfer } from "zod";
import { z } from "zod";

import { hasNoNul, maxCodePoints, wellFormedText } from "../common/text-validation";

const VOUCHER_COUNT_MAX = 100;
const VOUCHER_AMOUNT_MAX = Number.MAX_SAFE_INTEGER;
const VOUCHER_NOTE_MAX = 200;
export const VOUCHER_PAGE_SIZE_DEFAULT = 50;
const VOUCHER_PAGE_SIZE_MAX = 100;
const VOUCHER_STATUSES = ["active", "redeemed", "cancelled", "expired"] as const;
type EffectiveVoucherStatus = (typeof VOUCHER_STATUSES)[number];

// `datetime({ offset: true })` accepts a +99:00 offset the Date parser (and Postgres) refuse.
const instant = z
  .string()
  .datetime({ offset: true })
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be a real instant");

export const VoucherIssueSchema = z
  .object({
    count: z.number().int().min(1).max(VOUCHER_COUNT_MAX),
    amount_minor: z.number().int().min(1).max(VOUCHER_AMOUNT_MAX),
    expires_at: instant
      .refine((value) => Date.parse(value) > Date.now(), "expires_at must be in the future")
      .nullable()
      .optional(),
    applies_to_all_stores: z.boolean(),
    // zod parses every element; the bound still caps the work (the contract's maxItems).
    eligible_store_ids: z.array(z.string().uuid().transform((id) => id.toLowerCase())).max(100).optional(),
    note: z
      .string()
      .refine(hasNoNul, "must not contain a NUL character")
      .superRefine(wellFormedText)
      .superRefine(maxCodePoints(VOUCHER_NOTE_MAX))
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const stores = body.eligible_store_ids ?? [];
    if (new Set(stores).size !== stores.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["eligible_store_ids"], message: "must not repeat a store" });
    }
    if (body.applies_to_all_stores && stores.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["eligible_store_ids"], message: "must be empty when applies_to_all_stores is true" });
    }
    if (!body.applies_to_all_stores && stores.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["eligible_store_ids"], message: "is required when applies_to_all_stores is false" });
    }
  });

export type VoucherIssueDto = z.infer<typeof VoucherIssueSchema>;

export const VoucherIdParamSchema = z.string().uuid("voucher_id is not a UUID");

export const VoucherListQuerySchema = z
  .object({
    status: z.enum(VOUCHER_STATUSES).optional(),
    batch_id: z.string().uuid().optional(),
    eligible_store_id: z.string().uuid().optional(),
    expires_from: instant.optional(),
    expires_before: instant.optional(),
    cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
    page_size: z.coerce.number().int().min(1).max(VOUCHER_PAGE_SIZE_MAX).optional(),
  })
  .strict();

export type VoucherListQuery = z.infer<typeof VoucherListQuerySchema>;

/**
 * An `instant` as a UTC ISO string for a `timestamptz` parameter. The validator
 * accepts any `±HH:MM` offset the Date parser takes (up to ±23:59), but Postgres
 * refuses a displacement past ±15:59 with 22009, which is not an input-error
 * code and so was a 500 (Schemathesis gate, RT-1108). Normalizing first sends
 * Postgres only `Z` instants, as the issue path already does for `expires_at`.
 */
export function toUtcInstant(value: string | undefined): string | null {
  return value === undefined ? null : new Date(value).toISOString();
}

/** Parses with a schema; a failure is a 400 `validation_failure` that names no value. */
export class ContractValidationPipe<TSchema extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): ZodInfer<TSchema> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({ code: "validation_failure", message: "The request did not match the contract." });
    }
    return parsed.data as ZodInfer<TSchema>;
  }
}

/** One `vouchers` row as the reads select it (effective status already derived). */
export interface VoucherReadRow {
  readonly id: string;
  readonly batch_id: string;
  readonly amount_minor: string | number;
  readonly currency_code: string;
  readonly status: EffectiveVoucherStatus;
  readonly expires_at: Date | null;
  readonly applies_to_all_stores: boolean;
  readonly eligible_store_ids: string[];
  readonly note: string | null;
  readonly created_at: Date;
  readonly cancelled_at: Date | null;
}

/** The contract `Voucher`. Closed by construction: no code, no hash, no tenant. */
export interface VoucherBody {
  readonly voucher_id: string;
  readonly batch_id: string;
  readonly amount_minor: number;
  readonly currency_code: string;
  readonly status: EffectiveVoucherStatus;
  readonly expires_at: string | null;
  readonly applies_to_all_stores: boolean;
  readonly eligible_store_ids: string[];
  readonly note: string | null;
  readonly created_at: string;
  readonly cancelled_at: string | null;
  /** Always null until the redemption runtime ships (RT-1111, RT-1112). */
  readonly redemption: null;
}

export function toVoucher(row: VoucherReadRow): VoucherBody {
  return {
    voucher_id: row.id,
    batch_id: row.batch_id,
    amount_minor: Number(row.amount_minor),
    currency_code: row.currency_code,
    status: row.status,
    expires_at: row.expires_at === null ? null : row.expires_at.toISOString(),
    applies_to_all_stores: row.applies_to_all_stores,
    eligible_store_ids: row.eligible_store_ids,
    note: row.note,
    created_at: row.created_at.toISOString(),
    cancelled_at: row.cancelled_at === null ? null : row.cancelled_at.toISOString(),
    redemption: null,
  };
}

export interface VoucherPageBody {
  readonly items: VoucherBody[];
  readonly next_cursor: string | null;
}

export interface VoucherCancelBody {
  readonly voucher_id: string;
  readonly status: "cancelled";
  readonly cancelled_at: string;
  readonly already_cancelled: boolean;
}

interface IssuedVoucherBody {
  readonly voucher_id: string;
  readonly code: string;
  readonly amount_minor: number;
  readonly currency_code: string;
  readonly expires_at: string | null;
}

export interface VoucherIssueBody {
  readonly batch_id: string;
  readonly vouchers: IssuedVoucherBody[];
}
