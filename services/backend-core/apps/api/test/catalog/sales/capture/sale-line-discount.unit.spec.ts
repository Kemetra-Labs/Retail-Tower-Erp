/**
 * RT-1571 (RT-285 F-7; migration 0134, sales.yaml 1.30.0-draft) — the manual-discount column mapping and the
 * two read shapes of `sale-line-discount.ts`. Docker-free.
 *
 *   - the INSERT values follow the seven `discount_*` columns in order, all null without a discount, and the
 *     approver's id is null when the till sent none;
 *   - `readSale` echoes every stored fact, the approver's id only when one was stored;
 *   - the history shape never carries the approver's id;
 *   - a line with no stored discount (none, or captured before 0134) has no `discount` key at all;
 *   - the SELECT reads a percent back as the whole number the contract allows.
 */
import { CaptureSaleLineDiscountSchema } from "../../../../src/catalog/sales/dto/capture-sale-request.dto";
import {
  DISCOUNT_SELECT_SQL,
  discountColumns,
  historyLineDiscountField,
  lineDiscountField,
  type DiscountRow,
} from "../../../../src/catalog/sales/sale-line-discount";

const APPROVER = "0a000000-0000-7000-8000-000000157131";

const SENT = CaptureSaleLineDiscountSchema.parse({
  kind: "amount",
  value: "5.00",
  amount: "5.00",
  reasonCode: "price_correction",
  authoritySource: "manager_session",
  approverRole: "admin",
  approverUserId: APPROVER,
});

const ROW: DiscountRow = {
  discount_kind: "amount",
  discount_value: "5.0000",
  discount_amount: "5.0000",
  discount_reason_code: "price_correction",
  discount_authority_source: "manager_session",
  discount_approver_role: "admin",
  discount_approver_user_id: APPROVER,
};

const STORED = {
  kind: "amount",
  value: "5.0000",
  amount: "5.0000",
  reasonCode: "price_correction",
  authoritySource: "manager_session",
  approverRole: "admin",
};

describe("RT-1571 discountColumns — the INSERT values", () => {
  it("are seven nulls without a discount", () => {
    expect(discountColumns(undefined)).toEqual([null, null, null, null, null, null, null]);
  });

  it("follow the column order: kind, value, amount, reason, authority source, approver role, approver id", () => {
    expect(discountColumns(SENT)).toEqual(["amount", "5.00", "5.00", "price_correction", "manager_session", "admin", APPROVER]);
  });

  it("store a null approver id when the till sent none", () => {
    const { approverUserId: _id, ...withoutId } = SENT;
    expect(discountColumns(withoutId).at(-1)).toBeNull();
  });
});

describe("RT-1571 lineDiscountField — SaleLine.discount (readSale, captureSale)", () => {
  it("echoes every stored fact with the approver's id", () => {
    expect(lineDiscountField(ROW)).toEqual({ discount: { ...STORED, approverUserId: APPROVER } });
  });

  it("omits the approver's id when none was stored", () => {
    expect(lineDiscountField({ ...ROW, discount_approver_user_id: null })).toEqual({ discount: STORED });
  });

  it("has no discount key when none was recorded, or the row double omits the columns", () => {
    expect(lineDiscountField({ ...ROW, discount_kind: null })).toEqual({});
    expect(lineDiscountField({})).toEqual({});
  });
});

describe("RT-1571 historyLineDiscountField — SaleHistoryLine.discount (history, console)", () => {
  it("never carries the approver's id", () => {
    expect(historyLineDiscountField(ROW)).toEqual({ discount: STORED });
    expect(JSON.stringify(historyLineDiscountField(ROW))).not.toContain(APPROVER);
  });

  it("has no discount key when none was recorded", () => {
    expect(historyLineDiscountField({})).toEqual({});
  });
});

describe("RT-1571 DISCOUNT_SELECT_SQL", () => {
  it("reads a percent as a whole number and every other value at the column scale", () => {
    const sql = DISCOUNT_SELECT_SQL.replace(/\s+/g, " ");
    expect(sql).toContain("CASE WHEN sl.discount_kind = 'percent' THEN sl.discount_value::integer::text");
    expect(sql).toContain("ELSE sl.discount_value::text END AS discount_value");
    expect(sql).toContain("sl.discount_approver_user_id::text AS discount_approver_user_id");
  });
});
