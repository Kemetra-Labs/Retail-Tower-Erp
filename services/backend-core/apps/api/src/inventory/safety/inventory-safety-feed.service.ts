/**
 * The POS inventory safety feed — Jira RT-449 PR 2 (RT-50 G7-6 / G7-7;
 * rulings H5, H8 in RT-449 comment 13434).
 * Contract: `packages/contracts/openapi/inventory/inventory-safety-feed.yaml`.
 *
 * The tenant's active tracking holds as a snapshot plus a delta by Inventory
 * Safety Revision. Every store's feed carries all of the tenant's active holds
 * (H5): holds and identities are tenant-level.
 *
 * Consistency. Each read is ONE SQL statement, so the revision, the Safety TTL
 * and the rows come from one snapshot even under READ COMMITTED. A safety
 * command steps the revision and writes its change row in one transaction and
 * holds the revision row lock until commit (`safety-revision.ts`), so the
 * change log never shows revision n + 1 without n.
 *
 * Delta. Up to `limit` change rows after `since`, in revision order, name the
 * holds they touched: a placement or release its hold; a recall every hold it
 * placed (`tracking_holds.recall_id`; a recall writes one change row); an
 * expiry correction the active holds of the identity; a tracking-profile
 * change none. Each touched hold is answered in its CURRENT state: active →
 * upsert, released → removal. Applying a page is idempotent, so a hold that
 * changed again after the page's last step converges on a later page. The
 * last page answers the tenant's current revision.
 */
import { Inject, Injectable } from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import type { Pool } from 'pg';

import { PG_POOL } from '../../auth/auth.module';
import { decodePageToken, encodePageToken } from './inventory-safety-feed.cursor';
import { EFFECTIVE_SAFETY_TTL_SQL } from './safety-ttl.service';

export const DEFAULT_FEED_LIMIT = 500;

/** Contract `SafetyHold`. */
export interface SafetyHoldRow {
  readonly hold_id: string;
  readonly kind: string;
  readonly tracking_identity_id: string;
  readonly product_id: string;
  readonly identity_kind: string;
  readonly identity_code: string;
  readonly expiry_date: string | null;
  readonly reason_code: string;
  readonly recall_id: string | null;
  readonly placed_at: string;
}

/** Contract `SafetyHoldRemoval`. */
export interface SafetyHoldRemoval {
  readonly hold_id: string;
  readonly tracking_identity_id: string;
}

/** Contract `InventorySafetySnapshotPage`. */
export interface InventorySafetySnapshotPage {
  readonly revision: number;
  readonly holds: SafetyHoldRow[];
  readonly next_page_token: string | null;
  readonly safety_ttl_seconds: number;
  readonly served_at: string;
}

/** Contract `InventorySafetyDeltaPage`. */
export interface InventorySafetyDeltaPage {
  readonly from_revision: number;
  readonly revision: number;
  readonly upserts: SafetyHoldRow[];
  readonly removals: SafetyHoldRemoval[];
  readonly has_more: boolean;
  readonly safety_ttl_seconds: number;
  readonly served_at: string;
}

export type SafetyDeltaResult =
  | { readonly kind: 'page'; readonly page: InventorySafetyDeltaPage }
  | { readonly kind: 'snapshot_required' };

/** A hold joined to its identity, as the feed reads it (nullable for the LEFT JOIN). */
interface HoldColumns {
  readonly hold_id: string | null;
  readonly kind: string | null;
  readonly tracking_identity_id: string | null;
  readonly product_id: string | null;
  readonly identity_kind: string | null;
  readonly identity_code: string | null;
  readonly expiry_date: string | null;
  readonly reason_code: string | null;
  readonly recall_id: string | null;
  readonly placed_at: Date | null;
  readonly active: boolean | null;
}

interface SnapshotRow extends HoldColumns {
  readonly revision: string;
  readonly ttl: number;
}

interface DeltaRow extends HoldColumns {
  readonly current_revision: string;
  readonly ttl: number;
  readonly step_count: number;
  readonly last_step: string | null;
}

/** The hold columns of `h` (tracking_holds) and `i` (tracking_identities). */
const HOLD_SELECT = `h.id AS hold_id, h.kind, h.tracking_identity_id,
       h.tenant_product_ref AS product_id, i.kind AS identity_kind, i.code AS identity_code,
       i.expiry_date::text AS expiry_date, h.reason_code, h.recall_id, h.placed_at,
       h.released_at IS NULL AS active`;

const CURRENT_REVISION_SQL = `COALESCE(
  (SELECT revision FROM tenant_inventory_safety_revisions WHERE tenant_id = $1), 0)`;

/**
 * Active holds after `$2` (null = from the start), at most `$3` rows, with the
 * current revision and TTL on every row (one row of nulls when there is none).
 */
const SNAPSHOT_SQL = `
  WITH page AS (
    SELECT ${HOLD_SELECT}
      FROM tracking_holds h
      JOIN tracking_identities i ON i.id = h.tracking_identity_id AND i.tenant_id = h.tenant_id
     WHERE h.tenant_id = $1 AND h.released_at IS NULL AND ($2::uuid IS NULL OR h.id > $2::uuid)
     ORDER BY h.id
     LIMIT $3
  )
  SELECT ${CURRENT_REVISION_SQL}::text AS revision, ${EFFECTIVE_SAFETY_TTL_SQL} AS ttl, page.*
    FROM (SELECT 1) one
    LEFT JOIN page ON true
   ORDER BY page.hold_id`;

/**
 * The change rows after `$2` (at most `$3` + 1, to tell whether more follow),
 * the holds the first `$3` of them touched, and the current revision and TTL.
 */
const DELTA_SQL = `
  WITH steps AS (
    SELECT revision, kind, tracking_hold_id, inventory_recall_id, tracking_identity_id
      FROM inventory_safety_changes
     WHERE tenant_id = $1 AND revision > $2
     ORDER BY revision
     LIMIT $3 + 1
  ), batch AS (
    SELECT * FROM steps ORDER BY revision LIMIT $3
  ), touched AS (
    SELECT tracking_hold_id AS hold_id FROM batch WHERE kind IN ('hold_placed', 'hold_released')
    UNION
    SELECT h.id FROM batch b
      JOIN tracking_holds h ON h.tenant_id = $1 AND h.recall_id = b.inventory_recall_id
     WHERE b.kind = 'recall_created'
    UNION
    SELECT h.id FROM batch b
      JOIN tracking_holds h
        ON h.tenant_id = $1 AND h.tracking_identity_id = b.tracking_identity_id AND h.released_at IS NULL
     WHERE b.kind = 'expiry_corrected'
  ), holds AS (
    SELECT ${HOLD_SELECT}
      FROM touched t
      JOIN tracking_holds h ON h.id = t.hold_id AND h.tenant_id = $1
      JOIN tracking_identities i ON i.id = h.tracking_identity_id AND i.tenant_id = h.tenant_id
  )
  SELECT ${CURRENT_REVISION_SQL}::text AS current_revision,
         ${EFFECTIVE_SAFETY_TTL_SQL} AS ttl,
         (SELECT count(*) FROM steps)::int AS step_count,
         (SELECT max(revision) FROM batch)::text AS last_step,
         holds.*
    FROM (SELECT 1) one
    LEFT JOIN holds ON true
   ORDER BY holds.hold_id`;

function toHold(row: HoldColumns): SafetyHoldRow {
  return {
    hold_id: row.hold_id as string,
    kind: row.kind as string,
    tracking_identity_id: row.tracking_identity_id as string,
    product_id: row.product_id as string,
    identity_kind: row.identity_kind as string,
    identity_code: row.identity_code as string,
    expiry_date: row.expiry_date,
    reason_code: row.reason_code as string,
    recall_id: row.recall_id,
    placed_at: (row.placed_at as Date).toISOString(),
  };
}

@Injectable()
export class InventorySafetyFeedService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * One snapshot page of the tenant's active holds. The first page reads the
   * revision; later pages answer the one their token carries. Throws
   * `SafetyFeedCursorError` for a malformed or foreign token.
   */
  async getSnapshot(
    tenantId: string,
    storeId: string,
    opts: { readonly limit: number | undefined; readonly pageToken: string | null },
  ): Promise<InventorySafetySnapshotPage> {
    const token = opts.pageToken === null ? null : decodePageToken(opts.pageToken, tenantId, storeId);
    const limit = opts.limit ?? DEFAULT_FEED_LIMIT;
    return await runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      const r = await client.query<SnapshotRow>(SNAPSHOT_SQL, [
        tenantId,
        token?.afterHoldId ?? null,
        limit + 1,
      ]);
      const first = r.rows[0] as SnapshotRow;
      const revision = token?.revision ?? Number(first.revision);
      const found = r.rows.filter((row) => row.hold_id !== null);
      const holds = found.slice(0, limit).map(toHold);
      const last = holds[holds.length - 1];
      return {
        revision,
        holds,
        next_page_token:
          found.length > limit && last
            ? encodePageToken({ tenantId, storeId, revision, afterHoldId: last.hold_id })
            : null,
        safety_ttl_seconds: first.ttl,
        served_at: new Date().toISOString(),
      };
    });
  }

  /** The holds touched by up to `limit` revision steps after `since`. */
  getDeltas(
    tenantId: string,
    since: number,
    opts: { readonly limit: number | undefined },
  ): Promise<SafetyDeltaResult> {
    const limit = opts.limit ?? DEFAULT_FEED_LIMIT;
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      const r = await client.query<DeltaRow>(DELTA_SQL, [tenantId, since, limit]);
      const first = r.rows[0] as DeltaRow;
      const current = Number(first.current_revision);
      if (since > current) return { kind: 'snapshot_required' };
      const hasMore = first.step_count > limit;
      const touched = r.rows.filter((row) => row.hold_id !== null);
      return {
        kind: 'page',
        page: {
          from_revision: since,
          revision: hasMore ? Number(first.last_step) : current,
          upserts: touched.filter((row) => row.active === true).map(toHold),
          removals: touched
            .filter((row) => row.active === false)
            .map((row) => ({
              hold_id: row.hold_id as string,
              tracking_identity_id: row.tracking_identity_id as string,
            })),
          has_more: hasMore,
          safety_ttl_seconds: first.ttl,
          served_at: new Date().toISOString(),
        },
      };
    });
  }
}
