/**
 * RT-1505 part B — fixture for the map / validate / row-list HTTP spec.
 *
 * On top of the part A import fixture (tenant A: owner, tenant_admin, store_manager, store_staff; tenant B owner) and
 * the RT-730 catalogue (Water: sku `W-1`, barcode `000123`, a store-scoped PLU `4242` at store Y, a barcode `555000`
 * scoped to a DELETED store; Juice: barcode `123`; an inactive and a retired product; a retired category) adds, for
 * tenant A, brand `RT1505 Acme`, and products
 *
 *   Alpha  `A-1`, barcode `4006381333931`, category `RT730 Drinks`
 *   Beta   `B-1`
 *   Gamma  `G-1`, barcode `6223001360018`
 *   and the SKUs `I-1` (the inactive product) and `R-1` (the retired one).
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. Ids use the `1505` mnemonic (hex only).
 */
import type { Pool } from "pg";

import type { PgTestEnv } from "../../../_helpers/postgres-container";
import { TENANT_A } from "../../__support__/isolation-harness";
import { CAT_DRINKS, P_INACTIVE, P_RETIRED } from "../../console-catalog/__support__/console-catalog-fixture";
import { seedImportFixture } from "./catalog-import-fixture";

const a = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const ACTOR = a("1505e1");

export const BRAND_ACME = a("1505b1");
export const P_ALPHA = a("1505a1");
export const P_BETA = a("1505a2");
export const P_GAMMA = a("1505a3");

async function seedProduct(admin: Pool, id: string, name: string, categoryId: string | null): Promise<void> {
  await admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, category_id, is_active, tax_category, created_by, updated_by)
     VALUES ($1, $2, $3, $4, true, 'standard', $5, $5)`,
    [id, TENANT_A, name, categoryId, ACTOR],
  );
}

async function seedAlias(admin: Pool, productId: string, type: string, value: string): Promise<void> {
  await admin.query(
    `INSERT INTO product_aliases (tenant_id, product_id, identifier_type, value, created_by) VALUES ($1, $2, $3, $4, $5)`,
    [TENANT_A, productId, type, value, ACTOR],
  );
}

export async function seedMapValidateFixture(env: PgTestEnv): Promise<void> {
  await seedImportFixture(env);
  const admin = env.admin;
  await admin.query(`INSERT INTO tenant_product_brands (id, tenant_id, name, created_by) VALUES ($1, $2, 'RT1505 Acme', $3)`, [BRAND_ACME, TENANT_A, ACTOR]);
  await seedProduct(admin, P_ALPHA, "RT1505 Alpha", CAT_DRINKS);
  await seedProduct(admin, P_BETA, "RT1505 Beta", null);
  await seedProduct(admin, P_GAMMA, "RT1505 Gamma", null);
  await seedAlias(admin, P_ALPHA, "sku", "A-1");
  await seedAlias(admin, P_ALPHA, "barcode", "4006381333931");
  await seedAlias(admin, P_BETA, "sku", "B-1");
  await seedAlias(admin, P_GAMMA, "sku", "G-1");
  await seedAlias(admin, P_GAMMA, "barcode", "6223001360018");
  await seedAlias(admin, P_INACTIVE, "sku", "I-1");
  await seedAlias(admin, P_RETIRED, "sku", "R-1");
}

export interface BatchState {
  readonly state: string;
  readonly version: number;
  readonly validation_generation: number;
  readonly mapping: unknown;
  readonly counts: unknown;
  readonly preview_hash: string | null;
  readonly mapping_profile_id: string | null;
  readonly suggested_mapping: unknown;
}

export async function batchState(admin: Pool, batchId: string): Promise<BatchState> {
  const r = await admin.query<BatchState>(
    `SELECT state, version, validation_generation, mapping, counts, preview_hash, mapping_profile_id, suggested_mapping
       FROM catalog_import_batches WHERE id = $1`,
    [batchId],
  );
  return r.rows[0] as BatchState;
}

/** The tenant's batch audit rows of one action, written since `since` (the table is append-only). */
export async function batchAudits(
  admin: Pool,
  tenantId: string,
  action: string,
  since: Date,
): Promise<Array<{ actor_user_id: string | null; target_id: string; target_type: string; metadata: Record<string, unknown> }>> {
  const r = await admin.query(
    `SELECT actor_user_id, target_id::text AS target_id, target_type, metadata
       FROM audit_events WHERE tenant_id = $1 AND action = $2 AND occurred_at >= $3 ORDER BY occurred_at, id`,
    [tenantId, action, since],
  );
  return r.rows;
}

export interface ProfileRecord {
  readonly id: string;
  readonly name: string;
  readonly entries: Record<string, string>;
  readonly created_by: string;
  readonly updated_by: string;
}

export async function profilesOf(admin: Pool, tenantId: string): Promise<ProfileRecord[]> {
  const r = await admin.query<ProfileRecord>(
    `SELECT id, name, entries, created_by, updated_by FROM catalog_import_mapping_profiles WHERE tenant_id = $1 ORDER BY name`,
    [tenantId],
  );
  return r.rows;
}

/** The stored result of each row of a batch, in row order. */
export async function validatedRows(
  admin: Pool,
  batchId: string,
): Promise<Array<{ row_number: number; status: string | null; review_reason: string | null; matched_ok: boolean | null }>> {
  const r = await admin.query(
    `SELECT r.row_number, r.status, r.review_reason,
            CASE WHEN r.matched_updated_at IS NULL THEN NULL
                 ELSE EXISTS (SELECT 1 FROM tenant_products p
                               WHERE p.id = (r.outcome->'matchedProduct'->>'productId')::uuid AND p.updated_at = r.matched_updated_at) END AS matched_ok
       FROM catalog_import_rows r WHERE r.batch_id = $1 ORDER BY r.row_number`,
    [batchId],
  );
  return r.rows;
}
