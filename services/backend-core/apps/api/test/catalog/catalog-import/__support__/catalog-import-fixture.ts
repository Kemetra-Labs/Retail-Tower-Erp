/**
 * RT-1505 — fixture for the product import HTTP spec.
 *
 * On top of the RT-562 console-sales / RT-730 catalog fixture (tenant A: the
 * `all` owner SES_OWNER_ALL, the `specific` tenant_admin SES_ADMIN_SPEC, the
 * store_manager SES_MANAGER, the store_staff SES_STAFF) adds one tenant-B owner
 * (SES_OWNER_B), and the admin-pool reads and writes the spec checks the
 * database with. Ids use the `1505` mnemonic (hex only).
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import type { Pool } from "pg";

import { seedConsoleMember } from "../../../_helpers/console-members";
import type { PgTestEnv } from "../../../_helpers/postgres-container";
import { TENANT_B } from "../../__support__/isolation-harness";
import { seedConsoleCatalogFixture } from "../../console-catalog/__support__/console-catalog-fixture";

const idB = (n: string): string => `0b000000-0000-7000-8000-00001505${n}`;

export const SES_OWNER_B = idB("01b1");

export async function seedImportFixture(env: PgTestEnv): Promise<void> {
  await seedConsoleCatalogFixture(env);
  await seedConsoleMember(env.admin, {
    tenantId: TENANT_B,
    userId: idB("02b1"),
    email: "rt1505-owner-b@example.test",
    membershipId: idB("04b1"),
    roleId: idB("05b1"),
    roleCode: "owner",
    stores: "all",
    sessions: { [SES_OWNER_B]: null },
  });
}

export interface BatchRecord {
  readonly id: string;
  readonly state: string;
  readonly version: number;
  readonly mode: string;
  readonly file_name: string | null;
  readonly file_sha256: string;
  readonly file_kind: string;
  readonly sheet_name: string | null;
  readonly csv_delimiter: string | null;
  readonly data_row_count: number;
  readonly column_count: number;
  readonly parser_version: string;
  readonly columns: unknown;
  readonly mapping: unknown;
  readonly suggested_mapping: unknown;
  readonly warnings: unknown;
  readonly created_by: string;
  readonly expires_in_days: number | null;
}

/** The tenant's batches, oldest first (admin pool: RLS does not apply). */
export async function batchesOf(admin: Pool, tenantId: string): Promise<BatchRecord[]> {
  const r = await admin.query<BatchRecord>(
    `SELECT id, state, version, mode, file_name, file_sha256, file_kind, sheet_name, csv_delimiter, data_row_count,
            column_count, parser_version, columns, mapping, suggested_mapping, warnings, created_by,
            EXTRACT(EPOCH FROM (expires_at - now())) / 86400 AS expires_in_days
       FROM catalog_import_batches WHERE tenant_id = $1 ORDER BY created_at, id`,
    [tenantId],
  );
  return r.rows.map((row) => ({ ...row, expires_in_days: row.expires_in_days === null ? null : Number(row.expires_in_days) }));
}

export interface RowRecord {
  readonly row_number: number;
  readonly cells: unknown;
  readonly status: string | null;
}

export async function rowsOf(admin: Pool, tenantId: string, batchId: string): Promise<RowRecord[]> {
  const r = await admin.query<RowRecord>(
    `SELECT row_number, cells, status FROM catalog_import_rows WHERE tenant_id = $1 AND batch_id = $2 ORDER BY row_number`,
    [tenantId, batchId],
  );
  return r.rows;
}

export async function countRows(admin: Pool, tenantId: string): Promise<number> {
  const r = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM catalog_import_rows WHERE tenant_id = $1`, [tenantId]);
  return Number(r.rows[0]!.n);
}

/** The tenant's `catalog.import.upload` audit rows, oldest first. */
export async function uploadAudits(
  admin: Pool,
  tenantId: string,
  since: Date,
): Promise<Array<{ actor_user_id: string | null; target_id: string; target_type: string; store_id: string | null; metadata: Record<string, unknown> }>> {
  // `audit_events` is append-only, so a test reads the rows written since it started.
  const r = await admin.query(
    `SELECT actor_user_id, target_id::text AS target_id, target_type, store_id, metadata
       FROM audit_events WHERE tenant_id = $1 AND action = 'catalog.import.upload' AND occurred_at >= $2
      ORDER BY occurred_at, id`,
    [tenantId, since],
  );
  return r.rows;
}

/** Closes the tenant's open batch (cancelled), as the cancel operation will, so a new upload is allowed. */
export async function closeOpenBatches(admin: Pool, tenantId: string): Promise<void> {
  await admin.query(
    `UPDATE catalog_import_batches SET state = 'cancelled', closed_at = now(), expires_at = NULL
      WHERE tenant_id = $1 AND state IN ('draft', 'validated')`,
    [tenantId],
  );
}

/** A `published` batch of the tenant with `sha256`, published `daysAgo` days ago (admin pool, every 0124 CHECK satisfied). */
export async function seedPublishedBatch(
  admin: Pool,
  seed: { readonly id: string; readonly tenantId: string; readonly actor: string; readonly sha256: string; readonly daysAgo: number },
): Promise<void> {
  await admin.query(
    `INSERT INTO catalog_import_batches
       (id, tenant_id, state, version, validation_generation, mode, file_size, file_sha256, file_kind, csv_delimiter,
        data_row_count, column_count, parser_version, columns, mapping, suggested_mapping, warnings,
        preview_hash, counts, publish_summary, created_by, published_at, closed_at, expires_at)
     VALUES ($1, $2, 'draft', 1, 0, 'create', 10, $3, 'csv', 'comma', 1, 1, 'csv-parse@7.0.3',
             '[{"columnNumber":1,"header":"a","samples":["1"]}]'::jsonb, NULL, '[]'::jsonb, '[]'::jsonb,
             NULL, NULL, NULL, $4, NULL, NULL, now() + interval '7 days')`,
    [seed.id, seed.tenantId, seed.sha256, seed.actor],
  );
  // Walk it through the lifecycle the guard allows: validated, then published.
  await admin.query(
    `UPDATE catalog_import_batches
        SET state = 'validated', version = 2, validation_generation = 1,
            mapping = '[{"columnNumber":1,"target":"sku"}]'::jsonb,
            counts = '{"ready_create":1,"ready_update":0,"unchanged":0,"needs_review":0,"error":0,"excluded":0}'::jsonb,
            preview_hash = $2, expires_at = now() + interval '7 days'
      WHERE id = $1`,
    [seed.id, `sha256:${"a".repeat(64)}`],
  );
  await admin.query(
    `UPDATE catalog_import_batches
        SET state = 'published', version = 3, expires_at = NULL,
            published_at = now() - make_interval(days => $2), closed_at = now() - make_interval(days => $2),
            publish_summary = '{"created":1}'::jsonb
      WHERE id = $1`,
    [seed.id, seed.daysAgo],
  );
}
