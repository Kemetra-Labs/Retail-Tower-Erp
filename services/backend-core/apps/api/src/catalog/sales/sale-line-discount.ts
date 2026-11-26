/**
 * RT-1571 (RT-285 F-7, RT-740 lineage; migration 0134, `pos-sales/sales.yaml` 1.30.0-draft): a line's manual
 * discount (`CaptureSaleLineDiscount`) as a stored sale-line fact. The capture writes it exactly as the till
 * sent it (it was already validated by the DTO and checked by `findLinePricingViolation`, and it is already
 * part of the payload hash, so nothing here changes what is hashed or refused), and the reads return it.
 *
 * Two read shapes (least disclosure):
 *   - `readSale` / `captureSale` (`SaleLine.discount`): every stored fact, the approver's user id included
 *     when the till sent one (the till that rang the sale reads its own facts back);
 *   - the sale history and the console detail (`SaleHistoryLine.discount`): the same facts WITHOUT the
 *     approver's user id, like the void view there, which names the approver's role and never the user.
 *
 * A line captured before 0134 has no stored discount even when its net is below its gross: it reads with no
 * `discount` ("not recorded"); nothing is inferred or backfilled.
 */
import type { CaptureSaleLineDiscountDto } from "./dto/capture-sale-request.dto";

type Discount = CaptureSaleLineDiscountDto;

/** The seven `sale_lines.discount_*` values in INSERT column order; all null without a manual discount. */
export function discountColumns(discount: Discount | undefined): ReadonlyArray<string | null> {
  if (discount === undefined) return Array.from({ length: 7 }, () => null);
  return [
    discount.kind,
    discount.value,
    discount.amount,
    discount.reasonCode,
    discount.authoritySource,
    discount.approverRole,
    discount.approverUserId ?? null,
  ];
}

/**
 * The discount columns of a `sale_lines sl` read. `numeric(19,4)` returns `10.0000` for a percent of 10, so a
 * percent's value is read back as the whole number the contract allows (`^(100|[1-9][0-9]?)$`); an amount's
 * value and every amount read at the column scale like the line's other money.
 */
export const DISCOUNT_SELECT_SQL = `sl.discount_kind,
         CASE WHEN sl.discount_kind = 'percent' THEN sl.discount_value::integer::text
              ELSE sl.discount_value::text END AS discount_value,
         sl.discount_amount::text AS discount_amount, sl.discount_reason_code, sl.discount_authority_source,
         sl.discount_approver_role, sl.discount_approver_user_id::text AS discount_approver_user_id`;

/** The discount columns of a line row; optional so a unit-test row double may omit them. */
export interface DiscountRow {
  readonly discount_kind?: Discount["kind"] | null;
  readonly discount_value?: string | null;
  readonly discount_amount?: string | null;
  readonly discount_reason_code?: Discount["reasonCode"] | null;
  readonly discount_authority_source?: Discount["authoritySource"] | null;
  readonly discount_approver_role?: Discount["approverRole"] | null;
  readonly discount_approver_user_id?: string | null;
}

/** Contract `SaleLineDiscount` (sales.yaml 1.30.0-draft). */
export interface SaleLineDiscountProjection {
  readonly kind: Discount["kind"];
  readonly value: string;
  readonly amount: string;
  readonly reasonCode: Discount["reasonCode"];
  readonly authoritySource: Discount["authoritySource"];
  readonly approverRole: Discount["approverRole"];
  readonly approverUserId?: string;
}

/** The stored discount, or null when the line has none recorded (the CHECK keeps it whole or absent). */
function storedDiscount(row: DiscountRow): Omit<SaleLineDiscountProjection, "approverUserId"> | null {
  const kind = row.discount_kind ?? null;
  if (kind === null) return null;
  return {
    kind,
    value: row.discount_value!,
    amount: row.discount_amount!,
    reasonCode: row.discount_reason_code!,
    authoritySource: row.discount_authority_source!,
    approverRole: row.discount_approver_role!,
  };
}

/** `SaleLine.discount` (readSale, captureSale): present only when recorded, with the approver's id if sent. */
export function lineDiscountField(row: DiscountRow): { discount?: SaleLineDiscountProjection } {
  const discount = storedDiscount(row);
  if (discount === null) return {};
  const approverUserId = row.discount_approver_user_id ?? null;
  return { discount: approverUserId === null ? discount : { ...discount, approverUserId } };
}

/** `SaleHistoryLine.discount` (sale history, console detail): present only when recorded, never the approver's id. */
export function historyLineDiscountField(row: DiscountRow): {
  discount?: Omit<SaleLineDiscountProjection, "approverUserId">;
} {
  const discount = storedDiscount(row);
  return discount === null ? {} : { discount };
}
