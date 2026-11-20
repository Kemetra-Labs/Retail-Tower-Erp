/**
 * RT-1503 (spec 049 S2) — Postgres side of the catalogue import expiry and
 * retention job (tables from migration 0124).
 *
 * RLS posture (the RT-123 lesson: a sweep without a GUC sees nothing under
 * FORCE RLS): `catalog_import_batches` and `catalog_import_rows` have
 * tenant-only policies and no platform-admin branch. The tenant listing is
 * the one platform-admin read (`listAllTenantIds`, tenant ids only); every
 * other statement runs in a transaction under ONE tenant's GUC
 * (`isPlatformAdmin: false`), and the explicit `tenant_id = $1` predicates are
 * belt-and-braces.
 *
 * Privileges: the worker's DATABASE_URL is the domain role the api also uses.
 * docs/operations/sql/catalog-import-domain-grants.sql grants it SELECT,
 * INSERT and UPDATE on the batches (`FOR UPDATE` needs UPDATE) and DELETE on
 * the rows only; the audit INSERT and the tenant listing use grants the api
 * already needs. No new grant, role or migration.
 *
 * Expiry (spec 049 §8.1). One transaction per pass: pick up to `limit` due
 * batches `FOR UPDATE SKIP LOCKED` (a batch the runtime is changing right now
 * is skipped and picked up next time), then per batch the conditional UPDATE
 * of §8.1 with the version just read, and its `catalog.import.expire` audit
 * row in the same transaction. Both the pick and the UPDATE compare
 * `expires_at` with `now()` (the transaction start, as the spec's statement
 * does), so a picked batch always satisfies the UPDATE's own predicate.
 *
 * Purge (OD-6, spec 049 §10). One transaction per pass: pick up to `limit`
 * closed batches whose window has passed on the database clock
 * (`clock_timestamp()`, in UTC; the arithmetic is import-retention.policy.ts),
 * `FOR UPDATE SKIP LOCKED`, count their rows, delete them, then stamp
 * `rows_purged_at` (the batch header stays). The counts must agree: rows
 * deleted = rows counted, and batches stamped = batches picked; otherwise the
 * transaction rolls back with `ImportPurgeCountMismatchError`. The batch lock
 * blocks a concurrent row INSERT (its FK takes KEY SHARE on the batch), so a
 * mismatch is a real fault, never a race.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import { deterministicId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { listAllTenantIds } from "../common/all-tenant-ids";
import {
  CLOSED_ROWS_RETENTION_DAYS,
  PUBLISHED_ROWS_RETENTION_MONTHS,
  type ImportBatchState,
} from "./import-retention.policy";

/** Spec 049 §8.7 batch event for the expiry (contract catalog-import.yaml audit family). */
export const IMPORT_EXPIRE_AUDIT_ACTION = "catalog.import.expire";
const IMPORT_BATCH_AUDIT_TARGET = "catalog_import_batch";

/** Namespace of the expiry audit's deterministic id: one row per expired batch. */
const IMPORT_EXPIRE_AUDIT_NAMESPACE = "8d4f2b1e-5c3a-5e7f-9a10-150315031503";

export interface ExpiryCandidate {
  readonly id: string;
  readonly version: number;
  readonly state: ImportBatchState;
}

export interface ExpiredBatch {
  readonly id: string;
  /** The version after the expiry (the read version + 1). */
  readonly version: number;
  readonly previousState: ImportBatchState;
  readonly counts: unknown;
  readonly fileSha256: string;
}

export interface ExpiryPass {
  /** Due batches picked (locked) in this pass. */
  readonly picked: number;
  /** Batches the conditional UPDATE expired (each with its audit row). */
  readonly expired: number;
}

export interface PurgePass {
  /** Batches picked, purged and stamped in this pass. */
  readonly batches: number;
  /** Rows deleted. */
  readonly rows: number;
}

export interface ImportRetentionRepository {
  /** Every tenant id (any status). */
  listTenantIds(): Promise<string[]>;
  /** Expire up to `limit` due draft / validated batches of one tenant. */
  expireDueBatches(tenantId: string, limit: number): Promise<ExpiryPass>;
  /** Purge the rows of up to `limit` closed batches of one tenant past their window. */
  purgeDueRows(tenantId: string, limit: number): Promise<PurgePass>;
}

export class ImportPurgeCountMismatchError extends Error {
  constructor(what: "rows" | "batches", expected: number, actual: number) {
    super(`catalog import purge: ${what} mismatch (expected ${expected}, got ${actual}); rolled back`);
    this.name = "ImportPurgeCountMismatchError";
  }
}

const PICK_DUE_EXPIRY_SQL = `
SELECT id, version, state
  FROM catalog_import_batches
 WHERE tenant_id = $1
   AND state IN ('draft', 'validated')
   AND expires_at <= now()
 ORDER BY expires_at, id
 LIMIT $2
   FOR UPDATE SKIP LOCKED
`;

// Spec 049 §8.1, verbatim apart from the batch's own keys.
const EXPIRE_IF_UNCHANGED_SQL = `
UPDATE catalog_import_batches
   SET state = 'expired', closed_at = now(), expires_at = NULL, preview_hash = NULL, version = version + 1
 WHERE tenant_id = $1
   AND id = $2
   AND state IN ('draft', 'validated')
   AND version = $3
   AND expires_at <= now()
RETURNING id, version, counts, file_sha256
`;

const INSERT_EXPIRE_AUDIT_SQL = `
INSERT INTO audit_events
  (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
VALUES ($1, NULL, 'system', $2, NULL, $3, $4, $5, NULL, $6::jsonb)
`;

// The windows on the database clock in UTC: (clock AT TIME ZONE 'UTC' - interval) AT TIME ZONE 'UTC'.
const PICK_DUE_PURGE_SQL = `
SELECT id
  FROM catalog_import_batches
 WHERE tenant_id = $1
   AND rows_purged_at IS NULL
   AND (
         (state IN ('cancelled', 'expired')
          AND closed_at <= (clock_timestamp() AT TIME ZONE 'UTC' - make_interval(days => $3)) AT TIME ZONE 'UTC')
      OR (state = 'published'
          AND published_at <= (clock_timestamp() AT TIME ZONE 'UTC' - make_interval(months => $4)) AT TIME ZONE 'UTC')
       )
 ORDER BY closed_at, id
 LIMIT $2
   FOR UPDATE SKIP LOCKED
`;

const COUNT_ROWS_SQL = `
SELECT count(*)::int AS n FROM catalog_import_rows WHERE tenant_id = $1 AND batch_id = ANY($2::uuid[])
`;

const DELETE_ROWS_SQL = `
DELETE FROM catalog_import_rows WHERE tenant_id = $1 AND batch_id = ANY($2::uuid[])
`;

const STAMP_PURGED_SQL = `
UPDATE catalog_import_batches
   SET rows_purged_at = clock_timestamp()
 WHERE tenant_id = $1
   AND id = ANY($2::uuid[])
   AND rows_purged_at IS NULL
`;

/**
 * The §8.1 conditional expiry of ONE batch and its audit row, on a client
 * already in a transaction under the batch's tenant GUC. A batch changed
 * since `candidate` was read (another version, no longer draft / validated, or
 * `expires_at` moved) is left alone: no UPDATE, no audit row, `null`.
 */
export async function expireBatchIfUnchanged(
  client: PoolClient,
  tenantId: string,
  candidate: ExpiryCandidate,
): Promise<ExpiredBatch | null> {
  const r = await client.query<{ id: string; version: number; counts: unknown; file_sha256: string }>(
    EXPIRE_IF_UNCHANGED_SQL,
    [tenantId, candidate.id, candidate.version],
  );
  const row = r.rows[0];
  if (!row) return null;
  const expired: ExpiredBatch = {
    id: row.id,
    version: row.version,
    previousState: candidate.state,
    counts: row.counts,
    fileSha256: row.file_sha256,
  };
  await client.query(INSERT_EXPIRE_AUDIT_SQL, [
    deterministicId(IMPORT_EXPIRE_AUDIT_NAMESPACE, expired.id),
    tenantId,
    IMPORT_EXPIRE_AUDIT_ACTION,
    IMPORT_BATCH_AUDIT_TARGET,
    expired.id,
    JSON.stringify({
      import_batch_id: expired.id,
      version: expired.version,
      previous_state: expired.previousState,
      counts: expired.counts ?? null,
      file_sha256: expired.fileSha256,
    }),
  ]);
  return expired;
}

const EMPTY_EXPIRY_PASS: ExpiryPass = Object.freeze({ picked: 0, expired: 0 });
const EMPTY_PURGE_PASS: PurgePass = Object.freeze({ batches: 0, rows: 0 });

/** One tenant's GUC, never the platform-admin flag: the import tables have no platform branch. */
const tenantOnly = (tenantId: string) => ({ tenantId, isPlatformAdmin: false }) as const;

export class PgImportRetentionRepository implements ImportRetentionRepository {
  constructor(private readonly pool: Pool) {}

  listTenantIds(): Promise<string[]> {
    return listAllTenantIds(this.pool);
  }

  expireDueBatches(tenantId: string, limit: number): Promise<ExpiryPass> {
    return runWithTenantContext(this.pool, tenantOnly(tenantId), async (client) => {
      const due = await client.query<ExpiryCandidate>(PICK_DUE_EXPIRY_SQL, [tenantId, limit]);
      let expired = 0;
      // sequential: one transaction; each UPDATE and its audit row follow the previous one.
      for (const candidate of due.rows) {
        if (await expireBatchIfUnchanged(client, tenantId, candidate)) expired += 1;
      }
      return { picked: due.rows.length, expired };
    });
  }

  purgeDueRows(tenantId: string, limit: number): Promise<PurgePass> {
    return runWithTenantContext(this.pool, tenantOnly(tenantId), async (client) => {
      const due = await client.query<{ id: string }>(PICK_DUE_PURGE_SQL, [
        tenantId,
        limit,
        CLOSED_ROWS_RETENTION_DAYS,
        PUBLISHED_ROWS_RETENTION_MONTHS,
      ]);
      const ids = due.rows.map((row) => row.id);
      if (ids.length === 0) return EMPTY_PURGE_PASS;

      const counted = (await client.query<{ n: number }>(COUNT_ROWS_SQL, [tenantId, ids])).rows[0]?.n ?? 0;
      const deleted = (await client.query(DELETE_ROWS_SQL, [tenantId, ids])).rowCount ?? 0;
      if (deleted !== counted) throw new ImportPurgeCountMismatchError("rows", counted, deleted);
      const stamped = (await client.query(STAMP_PURGED_SQL, [tenantId, ids])).rowCount ?? 0;
      if (stamped !== ids.length) throw new ImportPurgeCountMismatchError("batches", ids.length, stamped);
      return { batches: stamped, rows: deleted };
    });
  }
}

/** No-DB path (dev / CI without DATABASE_URL): no tenant, so nothing to expire or purge. */
export class NoOpImportRetentionRepository implements ImportRetentionRepository {
  async listTenantIds(): Promise<string[]> {
    return [];
  }

  async expireDueBatches(): Promise<ExpiryPass> {
    return EMPTY_EXPIRY_PASS;
  }

  async purgeDueRows(): Promise<PurgePass> {
    return EMPTY_PURGE_PASS;
  }
}
