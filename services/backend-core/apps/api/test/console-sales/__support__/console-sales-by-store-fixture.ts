/**
 * RT-1053 — fixture for the console sales by store spec.
 *
 * Builds on the RT-649 summary fixture (`console-sales-summary-fixture.ts`:
 * STORE_A_X in `Africa/Cairo` with its October sales, voids, returns and
 * legacy refunds; STORE_A_Y with one October sale and the September bulk,
 * then moved to `America/New_York`; S_DELETED; tenant B; every member and
 * session) and adds:
 *
 *   - X_USD: one STORE_A_X sale in USD on 2026-10-07, so no figure is ever
 *     added across currencies and a USD ranking differs from the EGP one.
 *   - S_INACTIVE: a tenant A store with `is_active = false` and two EGP sales
 *     on 2026-10-08 (2 × 6.25): the same EGP total as STORE_A_Y and
 *     S_DELETED (12.50) but a higher count, so the count tie-break shows.
 *   - Tenant C with BY_STORE_MAX_STORES stores and an `all` owner
 *     (SES_C_OWNER), for the 500-store bound; the spec adds the 501st.
 *
 * October 2026 EGP received sales, tenant A (the ranking the spec expects):
 *   STORE_A_X 9 / 112.50, S_INACTIVE 2 / 12.50, STORE_A_Y 1 / 12.50,
 *   S_DELETED 1 / 12.50. Baseline (2026-08-31..2026-09-30): STORE_A_X
 *   1 / 12.50 (X_SEP30), STORE_A_Y 522 / 545.00 (the bulk).
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `1053`
 * mnemonic (hex only).
 */
import type { Pool } from "pg";

import { seedConsoleMember } from "../../_helpers/console-members";
import type { PgTestEnv } from "../../_helpers/postgres-container";
import { STORE_A_X, TENANT_A } from "../../catalog/__support__/isolation-harness";
import { BY_STORE_MAX_STORES } from "../../../src/console-sales/console-sales-by-store.query";
import { CASHIER } from "./console-sales-fixture";
import { seedConsoleSalesSummaryFixture } from "./console-sales-summary-fixture";

const id = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;

export const X_USD = id("1053a1");
export const S_INACTIVE = id("1053a2");
export const INACTIVE_SALES = [id("1053a3"), id("1053a4")];

export const TENANT_C = "0c000000-0000-7000-8000-00000010530c";
const USER_C_OWNER = "0c000000-0000-7000-8000-0000001053e1";
export const SES_C_OWNER = "0c000000-0000-7000-8000-0000001053f1";
/** The store a spec inserts to take tenant C over the bound. */
export const STORE_C_EXTRA = "0c000000-0000-7000-8000-0000001053ff";

const ZERO_HASH = "0".repeat(64);

/** A plain received sale with a stored business date. */
export async function insertSale(
  admin: Pool,
  sale: {
    readonly id: string;
    readonly storeId: string;
    readonly currency: string;
    readonly total: string;
    readonly occurredAt: string;
    readonly businessDate: string;
  },
): Promise<void> {
  await admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
        source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, $4, $5::numeric, $6::timestamptz, $7::date, 'rt1053-seed', $8, $9, $10)`,
    [
      sale.id,
      TENANT_A,
      sale.storeId,
      sale.currency,
      sale.total,
      sale.occurredAt,
      sale.businessDate,
      `rt1053-${sale.id}`,
      ZERO_HASH,
      CASHIER,
    ],
  );
}

async function seedTenantC(admin: Pool): Promise<void> {
  await admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES ($1, 'rt1053-c', 'RT-1053 Tenant C', 'EGP')`,
    [TENANT_C],
  );
  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name)
     SELECT ('0c000000-0000-7000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, $1, 'c' || g, 'Store C' || g
       FROM generate_series(1, $2::int) AS g`,
    [TENANT_C, BY_STORE_MAX_STORES],
  );
  await seedConsoleMember(admin, {
    tenantId: TENANT_C,
    userId: USER_C_OWNER,
    email: "rt1053-owner-c@example.test",
    membershipId: "0c000000-0000-7000-8000-0000001053d1",
    roleId: "0c000000-0000-7000-8000-0000001053d2",
    roleCode: "owner",
    stores: "all",
    sessions: { [SES_C_OWNER]: null },
  });
}

export async function seedConsoleSalesByStoreFixture(env: PgTestEnv): Promise<void> {
  await seedConsoleSalesSummaryFixture(env);
  await insertSale(env.admin, {
    id: X_USD,
    storeId: STORE_A_X,
    currency: "USD",
    total: "10.0000",
    occurredAt: "2026-10-07T09:00:00Z",
    businessDate: "2026-10-07",
  });
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name, is_active) VALUES ($1, $2, 'rt1053-inactive', 'RT-1053 Inactive', false)`,
    [S_INACTIVE, TENANT_A],
  );
  for (const saleId of INACTIVE_SALES) {
    await insertSale(env.admin, {
      id: saleId,
      storeId: S_INACTIVE,
      currency: "EGP",
      total: "6.2500",
      occurredAt: "2026-10-08T09:00:00Z",
      businessDate: "2026-10-08",
    });
  }
  await seedTenantC(env.admin);
}
