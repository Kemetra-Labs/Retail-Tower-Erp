import { buildIssueBody } from "@/vouchers/voucherIssueForm";
import {
  buildCodesCsv,
  canCancelVoucher,
  canReadVouchers,
  flattenVoucherPages,
  formatVoucherAmount,
  minorToDecimal,
  nextVoucherCursor,
  voucherEligibility,
  voucherStatusKey,
} from "@/vouchers/voucherLogic";
import { classifyCancelOutcome, classifyIssueOutcome } from "@/vouchers/voucherOutcomes";
import { describe, expect, test } from "vitest";

/**
 * RT-1109 vouchers page: the pure rules. Roles (decision 2A), money from minor
 * units, keyset paging, the codes CSV built only from the 201 body, the issue
 * form guard, and the non-replayable issue / replayable cancel classifiers.
 */

function voucher(over: Record<string, unknown> = {}) {
  return {
    voucher_id: "v1",
    batch_id: "b1",
    amount_minor: 5000,
    currency_code: "EGP",
    status: "active" as const,
    expires_at: null,
    applies_to_all_stores: true,
    eligible_store_ids: [],
    note: null,
    created_at: "2026-11-11T10:00:00Z",
    cancelled_at: null,
    redemption: null,
    ...over,
  };
}

describe("access and display", () => {
  test("only owner and tenant_admin read vouchers", () => {
    expect(canReadVouchers("owner")).toBe(true);
    expect(canReadVouchers("tenant_admin")).toBe(true);
    for (const role of ["store_manager", "store_staff", "cashier", "auditor", null, undefined]) {
      expect(canReadVouchers(role)).toBe(false);
    }
  });

  test("minor units become an exact decimal, then the house money format", () => {
    expect(minorToDecimal(5025, 2)).toBe("50.25");
    expect(minorToDecimal(5, 2)).toBe("0.05");
    expect(minorToDecimal(125000, 2)).toBe("1250.00");
    expect(minorToDecimal(7, 0)).toBe("7");
    expect(formatVoucherAmount(125000, "EGP")).toBe("1,250.00 EGP");
    expect(formatVoucherAmount(1234, "KWD")).toBe("1.234 KWD");
  });

  test("statuses map to catalog keys; an unknown one never shows raw", () => {
    expect(voucherStatusKey("expired")).toBe("vouchers.status.expired");
    expect(voucherStatusKey("frozen")).toBe("vouchers.status.unknown");
  });

  test("cancel is offered for a stored-active voucher, expired or not (decision 5A)", () => {
    expect(canCancelVoucher("active")).toBe(true);
    expect(canCancelVoucher("expired")).toBe(true);
    expect(canCancelVoucher("redeemed")).toBe(false);
    expect(canCancelVoucher("cancelled")).toBe(false);
  });

  test("eligibility names known stores and counts the others", () => {
    const stores = [{ id: "s1", name: "Maadi" }];
    expect(voucherEligibility(voucher(), stores)).toEqual({ kind: "all" });
    expect(
      voucherEligibility(
        voucher({ applies_to_all_stores: false, eligible_store_ids: ["s1", "s2", "s3"] }),
        stores,
      ),
    ).toEqual({ kind: "stores", names: ["Maadi"], unnamed: 2 });
  });
});

describe("keyset paging", () => {
  test("a null cursor ends the walk; an empty page with a cursor does not", () => {
    expect(nextVoucherCursor({ items: [], next_cursor: null })).toBeUndefined();
    expect(nextVoucherCursor({ items: [], next_cursor: "abc" })).toBe("abc");
  });

  test("a voucher seen on two pages is kept once, where it first appeared", () => {
    const rows = flattenVoucherPages([
      { items: [voucher({ voucher_id: "a" }), voucher({ voucher_id: "b" })], next_cursor: "c" },
      { items: [voucher({ voucher_id: "b" }), voucher({ voucher_id: "c" })], next_cursor: null },
    ]);
    expect(rows.map((r) => r.voucher_id)).toEqual(["a", "b", "c"]);
  });
});

describe("codes CSV", () => {
  test("built only from the 201 body: one line per code, exact amounts", () => {
    const csv = buildCodesCsv({
      batch_id: "b1",
      vouchers: [
        {
          voucher_id: "v1",
          code: "ABCD-EFGH-JKMN-PQRS",
          amount_minor: 5025,
          currency_code: "EGP",
          expires_at: "2026-12-31T21:59:00.000Z",
        },
        {
          voucher_id: "v2",
          code: "0123-4567-89AB-CDEF",
          amount_minor: 5025,
          currency_code: "EGP",
          expires_at: null,
        },
      ],
    });
    expect(csv.split("\r\n")).toEqual([
      "batch_id,voucher_id,code,amount,currency_code,expires_at",
      "b1,v1,ABCD-EFGH-JKMN-PQRS,50.25,EGP,2026-12-31T21:59:00.000Z",
      "b1,v2,0123-4567-89AB-CDEF,50.25,EGP,",
      "",
    ]);
  });
});

describe("issue form guard", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const draft = {
    count: "10",
    amount: "50.25",
    expiresAt: "",
    scope: "all" as const,
    storeIds: [],
    note: "",
  };

  test("a valid all-stores draft becomes the closed request body", () => {
    expect(buildIssueBody(draft, 2, now)).toEqual({
      ok: true,
      body: {
        count: 10,
        amount_minor: 5025,
        expires_at: null,
        applies_to_all_stores: true,
        note: null,
      },
    });
  });

  test("Arabic-Indic digits and «٫» are accepted", () => {
    const built = buildIssueBody({ ...draft, count: "٣", amount: "١٢٫٥" }, 2, now);
    expect(built.ok && built.body.count).toBe(3);
    expect(built.ok && built.body.amount_minor).toBe(1250);
  });

  test("a store subset sends its ids; an empty subset is refused before any call", () => {
    const subset = buildIssueBody(
      { ...draft, scope: "stores", storeIds: ["s1", "s1", "s2"] },
      2,
      now,
    );
    expect(subset.ok && subset.body.eligible_store_ids).toEqual(["s1", "s2"]);
    expect(subset.ok && subset.body.applies_to_all_stores).toBe(false);
    const empty = buildIssueBody({ ...draft, scope: "stores", storeIds: [] }, 2, now);
    expect(empty.ok ? undefined : empty.errors.storeIds?.messageKey).toBe(
      "vouchers.form.storesRequired",
    );
  });

  test.each([
    [{ count: "0" }, "count", "vouchers.form.countInvalid"],
    [{ count: "101" }, "count", "vouchers.form.countInvalid"],
    [{ count: "2.5" }, "count", "vouchers.form.countInvalid"],
    [{ amount: "" }, "amount", "vouchers.form.amountRequired"],
    [{ amount: "0" }, "amount", "vouchers.form.amountInvalid"],
    [{ amount: "-5" }, "amount", "vouchers.form.amountInvalid"],
    [{ amount: "1.005" }, "amount", "vouchers.form.amountPrecision"],
    [{ expiresAt: "2026-11-10T09:00" }, "expiresAt", "vouchers.form.expiryPast"],
    [{ note: "x".repeat(201) }, "note", "vouchers.form.noteTooLong"],
  ])("%o is refused on %s", (over, field, key) => {
    const built = buildIssueBody({ ...draft, ...over }, 2, now);
    expect(built.ok).toBe(false);
    expect(built.ok ? undefined : built.errors[field as "count"]?.messageKey).toBe(key);
  });

  test("a future expiry is sent as UTC", () => {
    const built = buildIssueBody({ ...draft, expiresAt: "2027-01-01T00:00" }, 2, now);
    expect(built.ok && built.body.expires_at).toBe(new Date("2027-01-01T00:00").toISOString());
  });
});

describe("issue outcomes (non-replayable)", () => {
  const err = (code: string) => ({ error: { code, message: "x", request_id: "req-1" } });

  test("201 is issued", () => {
    expect(classifyIssueOutcome({ status: 201 })).toEqual({ kind: "issued" });
  });

  test.each([
    [400, "validation_failure", "vouchers.issue.errors.validation"],
    [400, "idempotency_key_malformed", "vouchers.issue.errors.generic"],
    [403, "forbidden", "vouchers.issue.errors.forbidden"],
    [404, "store_not_found", "vouchers.issue.errors.storeUnavailable"],
    [409, "store_inactive", "vouchers.issue.errors.storeInactive"],
    [429, "rate_limited", "vouchers.errors.rateLimited"],
  ])("%i %s is a refusal: nothing was issued", (status, code, key) => {
    expect(classifyIssueOutcome({ status, error: err(code) })).toEqual({
      kind: "rejected",
      messageKey: key,
      requestId: "req-1",
    });
  });

  test.each([
    [409, err("idempotency_key_conflict")],
    [425, { error: "idempotency_in_progress", retryAfterSec: 3 }],
    [500, undefined],
    [503, undefined],
  ])("%i is uncertain: the batch may exist", (status, error) => {
    expect(classifyIssueOutcome({ status, error }).kind).toBe("uncertain");
  });

  test("401 is the session", () => {
    expect(classifyIssueOutcome({ status: 401 }).kind).toBe("session");
  });
});

describe("cancel outcomes (replayable)", () => {
  const err = (code: string) => ({ error: { code, message: "x", request_id: "req-2" } });

  test("200 is cancelled, and says when it already was", () => {
    expect(classifyCancelOutcome({ status: 200, data: { already_cancelled: false } })).toEqual({
      kind: "cancelled",
      alreadyCancelled: false,
    });
    expect(classifyCancelOutcome({ status: 200, data: { already_cancelled: true } })).toEqual({
      kind: "cancelled",
      alreadyCancelled: true,
    });
  });

  test("a redeemed voucher cannot be cancelled; the key is dropped", () => {
    expect(classifyCancelOutcome({ status: 409, error: err("voucher_already_redeemed") })).toEqual({
      kind: "failed",
      messageKey: "vouchers.detail.cancelRedeemed",
      requestId: "req-2",
      keepKey: false,
    });
  });

  test("425 and 5xx keep the key: the same key replays the stored answer", () => {
    expect(classifyCancelOutcome({ status: 425 })).toMatchObject({ keepKey: true });
    expect(classifyCancelOutcome({ status: 502 })).toMatchObject({ keepKey: true });
    expect(classifyCancelOutcome({ status: 404, error: err("voucher_not_found") })).toMatchObject({
      messageKey: "vouchers.detail.notFound",
      keepKey: false,
    });
  });
});
