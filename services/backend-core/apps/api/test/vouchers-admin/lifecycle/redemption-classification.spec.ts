/**
 * apps/api/test/vouchers-admin/lifecycle/redemption-classification.spec.ts
 *
 * RT-1111 (0092) — data-lifecycle classification guard for the voucher
 * redemption tables (SI-012, Constitution §XIV). Companion of
 * `classification.spec.ts` (0091).
 *
 * `voucher_redemption_intents` and `voucher_redemptions` are BUSINESS-CLASS
 * with a monetary attribute (the 0091 `vouchers` posture): opaque ids, a
 * one-way token HASH (the redemption token is never persisted), integer
 * amounts in minor units, timestamps, and the operator user id and device ids
 * that performed each step (operational actors and equipment, not customer
 * PII; the way 0087 classifies `operator_user_id` and `device_id`). No customer
 * or holder reference of any kind. The classification prose is recorded in
 * `packages/db/drizzle/0092_voucher_redemptions.sql`.
 *
 * Docker-FREE introspection guard: it reads the persisted column inventory off
 * the Drizzle table objects and asserts it is EXACTLY the recorded allowlist,
 * so a later slice adding, removing or renaming a column fails set-equality and
 * forces a §XIV re-review.
 *
 * `@data-pulse-2/db/schema` resolves to the package's built `dist/`, so build
 * the db package first (`pnpm --filter @data-pulse-2/db build`).
 */
import "reflect-metadata";

import * as fs from "node:fs";
import * as path from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";

import { voucherRedemptionIntents, voucherRedemptions } from "@data-pulse-2/db/schema";

function persistedColumns(table: unknown): string[] {
  const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  return cfg.columns.map((c) => (c as unknown as { name: string }).name).sort();
}

const BUSINESS_CLASS_COLUMNS: ReadonlyArray<{ name: string; table: unknown; columns: string[] }> = [
  {
    name: "voucher_redemption_intents",
    table: voucherRedemptionIntents,
    columns: [
      "id",
      "tenant_id",
      "store_id",
      "voucher_id",
      // The POS's own opaque attempt id (not a payment instrument).
      "payment_attempt_id",
      "applied_amount_minor",
      "forfeited_amount_minor",
      // A one-way digest of the short-lived token; the token is never stored.
      "token_hash",
      // Operational actors and equipment (not customer PII).
      "operator_user_id",
      "device_id",
      "expires_at",
      "consumed_at",
      "created_at",
    ],
  },
  {
    name: "voucher_redemptions",
    table: voucherRedemptions,
    columns: [
      // The contract's redemption_id.
      "id",
      "tenant_id",
      "store_id",
      "voucher_id",
      "intent_id",
      "payment_attempt_id",
      "applied_amount_minor",
      "forfeited_amount_minor",
      "operator_user_id",
      "device_id",
      "redeemed_at",
      "reversed_at",
      "reversed_by_device_id",
      "created_at",
      "updated_at",
    ],
  },
];

/**
 * Collision-safe PII / payment-instrument substrings: fragments a customer
 * reference or payment-instrument column would carry, none of which occurs in
 * a column above. `payment_attempt_id` is an opaque POS id and is reviewed
 * above, so the bare `payment` fragment is replaced by instrument-specific ones.
 */
const PII_PAYMENT_SUBSTRINGS = [
  "customer",
  "holder",
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
  "payment_method",
  "instrument",
  "card",
  "cash",
  "pan",
  "iban",
  "account_number",
  "cvv",
  // The token itself must never be a column; only its hash.
  "plaintext",
];

describe("RT-1111 — voucher redemption data-class classification (SI-012 / §XIV)", () => {
  describe.each(BUSINESS_CLASS_COLUMNS)("$name persists EXACTLY the recorded business-class columns", ({ table, columns }) => {
    it("set-equals the allowlist (tripwire on add/remove/rename)", () => {
      expect(persistedColumns(table)).toEqual([...columns].sort());
    });
  });

  describe("no PII / payment-instrument column is persisted", () => {
    it.each(BUSINESS_CLASS_COLUMNS)("$name has zero PII/payment-instrument columns", ({ table }) => {
      const offending = persistedColumns(table).filter((col) =>
        PII_PAYMENT_SUBSTRINGS.some((frag) => col.toLowerCase().includes(frag)),
      );
      expect(offending).toEqual([]);
    });
  });

  it("never stores the token: the only token column is the hash", () => {
    const tokenColumns = persistedColumns(voucherRedemptionIntents).filter((c) => c.includes("token"));
    expect(tokenColumns).toEqual(["token_hash"]);
  });
});

describe("RT-1111 — classification recorded in the migration header", () => {
  // __dirname is apps/api/test/vouchers-admin/lifecycle: FIVE hops up to the
  // backend-core root (lifecycle, vouchers-admin, test, api, apps).
  const repoRoot = path.resolve(__dirname, "../../../../..");

  it("0092_voucher_redemptions.sql records BUSINESS-CLASS, SI-012 and the 001 long-horizon retention", () => {
    const text = fs.readFileSync(path.join(repoRoot, "packages/db/drizzle/0092_voucher_redemptions.sql"), "utf8");
    expect(text).toMatch(/DATA-LIFECYCLE CLASSIFICATION/);
    expect(text).toMatch(/SI-012/);
    expect(text).toMatch(/BUSINESS-CLASS/);
    expect(text).toMatch(/001 long-horizon/i);
  });
});
