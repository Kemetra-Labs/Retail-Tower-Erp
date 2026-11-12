/**
 * RT-1337 — fixture for the Offer Engine HTTP and integration specs.
 *
 * On top of the RT-387 policy fixture (tenants A / B; sessions: `all` owner
 * `SES_OWNER_ALL`, `all` tenant_admin `SES_ADMIN_ALL`, store_manager of
 * STORE_A_X only `SES_MANAGER`, store_staff `SES_STAFF`, tenant B owner
 * `SES_OWNER_B`; devices DEV_X / DEV_Y / DEV_B with tokens) it seeds a small
 * catalog in tenant A:
 *
 *   categories  SHOES, SOCKS, HATS            brands  NIKE, ADIDAS
 *   products    P_RUN   (SHOES, NIKE)   P_TRAIN (SHOES, ADIDAS)  P_SOCK (SOCKS, NIKE)
 *               P_HAT   (HATS, no brand) P_BARE (no category, no brand)
 *               P_OLD   (SHOES, retired) P_OFF  (SHOES, inactive)
 *   tenant B    one category, brand and product (isolation)
 *
 * STORE_A_X is in Africa/Cairo; STORE_A_Y stays UTC. `.ts` (not `.spec.ts`) so Jest
 * does not collect it. IDs use the `1337` mnemonic (hex only).
 */
import type { Pool } from "pg";

import type { PgTestEnv } from "../../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, TENANT_A, TENANT_B } from "../../catalog/__support__/isolation-harness";
import { seedPolicyFixture } from "../../cash-variance-policy/__support__/policy-fixture";

export {
  DEV_B,
  DEV_X,
  DEV_Y,
  SES_ADMIN_ALL,
  SES_MANAGER,
  SES_OWNER_B,
  SES_STAFF,
  TOKEN_B,
  TOKEN_X,
  TOKEN_Y,
  USER_ADMIN_ALL,
  USER_OWNER_ALL,
} from "../../cash-variance-policy/__support__/policy-fixture";
export { SES_OWNER_ALL } from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";

const id = (n: string): string => `0a000000-0000-7000-8000-00001337${n}`;
const idB = (n: string): string => `0b000000-0000-7000-8000-00001337${n}`;

export const CAT_SHOES = id("c001");
export const CAT_SOCKS = id("c002");
export const CAT_HATS = id("c003");
export const BR_NIKE = id("b001");
export const BR_ADIDAS = id("b002");
export const P_RUN = id("a001");
export const P_TRAIN = id("a002");
export const P_SOCK = id("a003");
export const P_HAT = id("a004");
export const P_BARE = id("a005");
export const P_OLD = id("a006");
export const P_OFF = id("a007");
export const CAT_B = idB("c001");
export const BR_B = idB("b001");
export const P_B = idB("a001");
/** A store that is not of tenant A. */
export const STORE_ABSENT = id("5fff");
export const ACTOR = "0a000000-0000-7000-8000-0000000000ac";

async function seedCatalog(admin: Pool): Promise<void> {
  await admin.query(`UPDATE stores SET timezone = 'Africa/Cairo' WHERE id = $1`, [STORE_A_X]);
  await admin.query(
    `INSERT INTO tenant_product_categories (id, tenant_id, name, created_by) VALUES
       ($1, $4, 'Shoes', $5), ($2, $4, 'Socks', $5), ($3, $4, 'Hats', $5), ($6, $7, 'B cat', $5)`,
    [CAT_SHOES, CAT_SOCKS, CAT_HATS, TENANT_A, ACTOR, CAT_B, TENANT_B],
  );
  await admin.query(
    `INSERT INTO tenant_product_brands (id, tenant_id, name, created_by) VALUES
       ($1, $3, 'Nike', $4), ($2, $3, 'Adidas', $4), ($5, $6, 'B brand', $4)`,
    [BR_NIKE, BR_ADIDAS, TENANT_A, ACTOR, BR_B, TENANT_B],
  );
  const products: Array<[string, string, string | null, string | null, boolean, boolean, string | null, string | null]> = [
    [P_RUN, "Run", CAT_SHOES, BR_NIKE, true, false, "100.00", "EGP"],
    [P_TRAIN, "Train", CAT_SHOES, BR_ADIDAS, true, false, "200.00", "EGP"],
    [P_SOCK, "Sock", CAT_SOCKS, BR_NIKE, true, false, "20.00", "EGP"],
    [P_HAT, "Hat", CAT_HATS, null, true, false, "50.00", "EGP"],
    [P_BARE, "Bare", null, null, true, false, "10.00", "EGP"],
    [P_OLD, "Old", CAT_SHOES, null, true, true, null, null],
    [P_OFF, "Off", CAT_SHOES, null, false, false, null, null],
  ];
  for (const [pid, name, cat, brand, active, retired, price, currency] of products) {
    await admin.query(
      `INSERT INTO tenant_products
         (id, tenant_id, name, category_id, brand_id, is_active, retired_at, tax_category, default_price, default_currency_code, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::boolean THEN now() END, 'standard', $8::numeric, $9, $10, $10)`,
      [pid, TENANT_A, name, cat, brand, active, retired, price, currency, ACTOR],
    );
  }
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, category_id, brand_id, tax_category, created_by, updated_by)
     VALUES ($1, $2, 'B product', $3, $4, 'standard', $5, $5)`,
    [P_B, TENANT_B, CAT_B, BR_B, ACTOR],
  );
}

export async function seedOffersFixture(env: PgTestEnv): Promise<void> {
  await seedPolicyFixture(env);
  await seedCatalog(env.admin);
}

export { STORE_A_X, STORE_A_Y, TENANT_A, TENANT_B };
