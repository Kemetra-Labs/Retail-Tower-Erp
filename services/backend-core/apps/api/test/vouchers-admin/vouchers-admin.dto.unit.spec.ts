/**
 * RT-1108 — the issue / list DTO bounds of `vouchers-admin.openapi.yaml`.
 * Docker-free. A refusal is the contract's 400 `validation_failure`.
 */
import { BadRequestException } from "@nestjs/common";

import {
  ContractValidationPipe,
  toVoucher,
  VoucherIdParamSchema,
  VoucherIssueSchema,
  VoucherListQuerySchema,
} from "../../src/vouchers-admin/vouchers-admin.dto";

const STORE = "0a000000-0000-7000-8000-000000000003";
const STORE_2 = "0a000000-0000-7000-8000-000000000004";
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const base = { count: 1, amount_minor: 100, applies_to_all_stores: true };
const ok = (body: unknown): boolean => VoucherIssueSchema.safeParse(body).success;

describe("VoucherIssueSchema", () => {
  it.each([
    ["an all-stores batch", base],
    ["count 100", { ...base, count: 100 }],
    ["the largest amount the table accepts (2^53 - 1)", { ...base, amount_minor: 9_007_199_254_740_991 }],
    ["a subset batch with expiry and note", { count: 2, amount_minor: 5, applies_to_all_stores: false, eligible_store_ids: [STORE, STORE_2], expires_at: FUTURE, note: "spring" }],
    ["a null expiry and null note", { ...base, expires_at: null, note: null }],
    ["an empty note", { ...base, note: "" }],
    ["a 200 code point note of emoji (400 UTF-16 units)", { ...base, note: "\u{1F600}".repeat(200) }],
    ["an empty store list with all stores", { ...base, eligible_store_ids: [] }],
  ])("accepts %s", (_label, body) => {
    expect(ok(body)).toBe(true);
  });

  it.each([
    ["count 0", { ...base, count: 0 }],
    ["count 101", { ...base, count: 101 }],
    ["a fractional count", { ...base, count: 1.5 }],
    ["amount 0", { ...base, amount_minor: 0 }],
    ["a negative amount", { ...base, amount_minor: -1 }],
    ["amount 2^53 (past the table CHECK)", { ...base, amount_minor: 9_007_199_254_740_992 }],
    ["a fractional amount", { ...base, amount_minor: 1.5 }],
    ["a string amount", { ...base, amount_minor: "100" }],
    ["a missing applies_to_all_stores", { count: 1, amount_minor: 100 }],
    ["a client-chosen code", { ...base, code: "AAAA-AAAA-AAAA-AAAA" }],
    ["a client tenant id", { ...base, tenant_id: STORE }],
    ["an expiry in the past", { ...base, expires_at: new Date(Date.now() - 1000).toISOString() }],
    ["an expiry that is not a date-time", { ...base, expires_at: "tomorrow" }],
    ["all stores with a store list", { ...base, eligible_store_ids: [STORE] }],
    ["a subset with no store list", { ...base, applies_to_all_stores: false }],
    ["a subset with an empty store list", { ...base, applies_to_all_stores: false, eligible_store_ids: [] }],
    ["a duplicate store", { ...base, applies_to_all_stores: false, eligible_store_ids: [STORE, STORE] }],
    ["a duplicate store differing only in letter case", { ...base, applies_to_all_stores: false, eligible_store_ids: ["0A000000-0000-7000-8000-00000000000A", "0a000000-0000-7000-8000-00000000000a"] }],
    ["a non-uuid store", { ...base, applies_to_all_stores: false, eligible_store_ids: ["nope"] }],
    ["101 stores", { ...base, applies_to_all_stores: false, eligible_store_ids: Array.from({ length: 101 }, (_, i) => `0a000000-0000-7000-8000-${String(i).padStart(12, "0")}`) }],
    ["a note of 201 characters", { ...base, note: "x".repeat(201) }],
    ["a NUL in the note", { ...base, note: "a\u0000b" }],
    ["a lone surrogate in the note", { ...base, note: "\ud800" }],
  ])("refuses %s", (_label, body) => {
    expect(ok(body)).toBe(false);
  });
});

describe("VoucherListQuerySchema", () => {
  it("accepts every filter, coerces page_size and bounds it 1..100", () => {
    const parsed = VoucherListQuerySchema.parse({
      status: "expired",
      batch_id: STORE,
      eligible_store_id: STORE_2,
      expires_from: "2026-01-01T00:00:00.000Z",
      expires_before: "2027-01-01T00:00:00Z",
      cursor: "abc_DEF-123",
      page_size: "100",
    });
    expect(parsed.page_size).toBe(100);
    for (const bad of [0, 101, "x", 1.5]) {
      expect(VoucherListQuerySchema.safeParse({ page_size: bad }).success).toBe(false);
    }
  });

  it.each([
    ["an unknown status", { status: "pending" }],
    ["a non-uuid batch", { batch_id: "x" }],
    ["a malformed expires_from", { expires_from: "2026-01-01" }],
    ["a cursor outside the pattern", { cursor: "a b" }],
    ["a cursor over 512 characters", { cursor: "a".repeat(513) }],
    ["an unknown parameter", { tenant_id: STORE }],
  ])("refuses %s", (_label, query) => {
    expect(VoucherListQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe("ContractValidationPipe and the id param", () => {
  it("answers validation_failure, naming no value", () => {
    const pipe = new ContractValidationPipe(VoucherIdParamSchema);
    expect(pipe.transform(STORE, { type: "param" })).toBe(STORE);
    try {
      pipe.transform("not-a-uuid", { type: "param" });
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as { code: string; message: string };
      expect(body.code).toBe("validation_failure");
      expect(body.message).not.toContain("not-a-uuid");
    }
  });
});

describe("toVoucher", () => {
  it("projects a row to the closed Voucher shape: no code, no hash, no tenant", () => {
    const body = toVoucher({
      id: STORE,
      batch_id: STORE_2,
      amount_minor: "5000",
      currency_code: "EGP",
      status: "active",
      expires_at: null,
      applies_to_all_stores: true,
      eligible_store_ids: [],
      note: null,
      created_at: new Date("2026-11-10T10:00:00.000Z"),
      cancelled_at: null,
    });
    expect(Object.keys(body).sort()).toEqual([
      "amount_minor",
      "applies_to_all_stores",
      "batch_id",
      "cancelled_at",
      "created_at",
      "currency_code",
      "eligible_store_ids",
      "expires_at",
      "note",
      "redemption",
      "status",
      "voucher_id",
    ]);
    expect(body.amount_minor).toBe(5000);
    expect(body.redemption).toBeNull();
  });
});
