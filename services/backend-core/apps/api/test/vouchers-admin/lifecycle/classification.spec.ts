/**
 * apps/api/test/vouchers-admin/lifecycle/classification.spec.ts
 *
 * RT-1107 (0091) — data-lifecycle classification guard for the voucher
 * issuance tables (SI-012, Constitution §XIV).
 *
 * `vouchers` and `voucher_eligible_stores` are BUSINESS-CLASS: opaque ids, a
 * one-way code HASH (the code itself is never persisted), an amount in minor
 * units and a currency code (the `sale_tenders` money posture, 0033), an
 * enumerated status, timestamps, two actor user ids (operational actors, not
 * customer PII) and a bounded internal note the contract bars from carrying
 * personal data. No customer reference of any kind. The classification prose
 * is recorded in `packages/db/drizzle/0091_vouchers.sql`.
 *
 * Docker-FREE introspection guard (mirrors the 008 guard
 * `catalog/sales/lifecycle/classification.spec.ts`): it reads the persisted
 * column inventory off the Drizzle table objects and asserts it is EXACTLY the
 * recorded allowlist. A later slice adding, removing or renaming a column
 * fails set-equality and forces a §XIV re-review. A collision-safe PII denylist
 * catches the common shapes a customer-reference column would take.
 *
 * `@data-pulse-2/db/schema` resolves to the package's built `dist/`, so build
 * the db package first (`pnpm --filter @data-pulse-2/db build`).
 */
import "reflect-metadata";

import * as fs from "node:fs";
import * as path from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";

import { voucherEligibleStores, vouchers } from "@data-pulse-2/db/schema";

function persistedColumns(table: unknown): string[] {
  const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  return cfg.columns.map((c) => (c as unknown as { name: string }).name).sort();
}

const BUSINESS_CLASS_COLUMNS: ReadonlyArray<{ name: string; table: unknown; columns: string[] }> = [
  {
    name: "vouchers",
    table: vouchers,
    columns: [
      "id",
      "tenant_id",
      // Opaque batch id (no batch table).
      "batch_id",
      // A one-way digest of the 16-character code; the plaintext is never stored.
      "code_hash",
      // Value in minor units and its ISO currency code.
      "amount_minor",
      "currency_code",
      // Enumerated: active | redeemed | cancelled.
      "status",
      "expires_at",
      "applies_to_all_stores",
      // Operational actor user ids (not customer PII).
      "issued_by_user_id",
      "cancelled_by_user_id",
      "cancelled_at",
      // Bounded (max 200) internal note; the contract bars personal data in it.
      "note",
      "created_at",
      "updated_at",
    ],
  },
  {
    name: "voucher_eligible_stores",
    table: voucherEligibleStores,
    columns: ["tenant_id", "voucher_id", "store_id"],
  },
];

/**
 * Collision-safe PII / payment-class substrings: fragments a customer
 * reference or payment-instrument column would carry, none of which occurs in
 * a column above. Bare `name` is avoided on purpose (`note` is reviewed above).
 */
const PII_PAYMENT_SUBSTRINGS = [
  "customer",
  "patient",
  "email",
  "phone",
  "address",
  "ssn",
  "national_id",
  "first_name",
  "last_name",
  "full_name",
  "dob",
  "birth",
  "tender",
  "payment",
  "card",
  "cash",
  "pan",
  "iban",
  "account_number",
  "cvv",
  // The code itself must never be a column; only its hash.
  "plaintext",
];

describe("RT-1107 — voucher data-class classification (SI-012 / §XIV)", () => {
  describe.each(BUSINESS_CLASS_COLUMNS)("$name persists EXACTLY the recorded business-class columns", ({ table, columns }) => {
    it("set-equals the allowlist (tripwire on add/remove/rename)", () => {
      expect(persistedColumns(table)).toEqual([...columns].sort());
    });
  });

  describe("no PII / payment-class column is persisted", () => {
    it.each(BUSINESS_CLASS_COLUMNS)("$name has zero PII/payment-class columns", ({ table }) => {
      const offending = persistedColumns(table).filter((col) =>
        PII_PAYMENT_SUBSTRINGS.some((frag) => col.toLowerCase().includes(frag)),
      );
      expect(offending).toEqual([]);
    });
  });

  it("never stores the code: the only code column is the hash", () => {
    const codeColumns = persistedColumns(vouchers).filter((c) => c.startsWith("code"));
    expect(codeColumns).toEqual(["code_hash"]);
  });
});

describe("RT-1107 — classification recorded in the migration header", () => {
  // __dirname is apps/api/test/vouchers-admin/lifecycle: FIVE hops up to the
  // backend-core root (vouchers-admin, test, api, apps, backend-core).
  const repoRoot = path.resolve(__dirname, "../../../../..");

  it("0091_vouchers.sql records BUSINESS-CLASS, SI-012 and the 001 long-horizon retention", () => {
    const text = fs.readFileSync(path.join(repoRoot, "packages/db/drizzle/0091_vouchers.sql"), "utf8");
    expect(text).toMatch(/DATA-LIFECYCLE CLASSIFICATION/);
    expect(text).toMatch(/SI-012/);
    expect(text).toMatch(/BUSINESS-CLASS/);
    expect(text).toMatch(/001 long-horizon/i);
  });
});
