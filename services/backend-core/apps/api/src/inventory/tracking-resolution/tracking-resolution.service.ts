/**
 * TrackingResolutionService — Jira RT-451 slice S5 (scope item 4; RT-50 DC-2,
 * G7-9 row 4; RT-455 TR-2, OD-1, OD-9; RT-451 comment 16556 Q1). Contract:
 * `listTrackingResolutionQueue` and `bindTrackingResolution` in
 * `inventory/inventory.yaml`.
 *
 * The queue: the sales captured `tracking_unresolved` (a tracked product's
 * line without `tracking`, with an unknown identity or another product's
 * identity), newest capture first, in RT-731 keyset pages. Unresolved sales
 * are read from `sales` (`tracking_status = 'tracking_unresolved'`); resolved
 * ones from `tracking_resolutions` (0094), whose bind set the sale `tracked`,
 * so the two halves never overlap. Owner and tenant_admin read the items, in
 * their store scope; any other admitted caller (a store_manager) gets only
 * `unresolvedCount` for its own stores (OD-9). Not gated by the tracked-selling
 * switch: sales already in the queue stay visible and resolvable while it is
 * off (OD-T4, RT-451 comment 16215).
 *
 * The bind: the governed, audited, owner-only Tracking Resolution of one sale.
 * In ONE transaction, under the sale's row lock:
 *   1. refusals, before any write: a sale not of this tenant, outside the
 *      caller's store scope or never `tracking_unresolved`, and an identity
 *      that does not exist, is of another tenant or is not a batch identity
 *      (a serial identity is never a lot, Q11): non-disclosing 404. Already
 *      resolved: 409. A `lines` set that is not exactly the sale's unresolved
 *      lines: 400. Then, over every line: another product's identity (409
 *      `_identity_mismatch`), an identity held now or at the sale's
 *      `occurredAt` (409 `_identity_held`), an identity expired at the sale's
 *      business date, or without an expiry on an `expiry_required` product
 *      (fail closed, as capture and the TLV; RT-451 comment 16246) (409
 *      `_identity_expired`). The identities are locked FOR KEY SHARE first,
 *      in id order, so a hold or recall in flight (FOR UPDATE) commits before
 *      the holds are read;
 *   2. the resolution, its line bindings, the sale set `tracked`, and an
 *      `erp_intent_held` / `edge_map_missing` sale-line finding for a bound
 *      identity with no ERP edge-map row (G7-9 row 3; the bind records no
 *      other finding);
 *   3. {@link commitResolvedSale}: the sale's effects and `sale_post` intent
 *      (when the worker already processed it), the void and return restores
 *      suppressed before the bind, and the reversal intents emitted before it,
 *      each re-emitted once (comment 16556 Q1);
 *   4. the audit row `inventory.tracking_resolution.bind`.
 * It does not step the Inventory Safety Revision.
 *
 * Replay: the fingerprint is SHA-256 over (actor, Idempotency-Key), UNIQUE per
 * tenant; the same command returns the recorded resolution and writes
 * nothing; another command under that key is a 409 `idempotency_key_conflict`.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { commitResolvedSale, runWithTenantContext } from '@data-pulse-2/db';
import { newId } from '@data-pulse-2/shared';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../../auth/auth.module';
import { writeSaleLineFindings } from '../../catalog/sales/tracked-lines/capture-tracking';
import { MembershipRepository } from '../../context/membership.repository';
import { callerStoreScope, inStoreScope, scopeStoreIds } from '../../context/operator-store-scope';
import type { ResolvedContext } from '../../context/types';
import { resolveReturnLandingStatus } from '../position-events/position-events.service';
import { writeAudit } from '../position-events/position-event.writer';
import {
  decodeSafetyHistoryCursorOrReject,
  encodeSafetyHistoryCursor,
  instantKeySql,
  type SafetyHistoryCursorBinding,
} from '../safety/safety-history.cursor';
import { byText, fingerprint, idempotencyConflict, normalizeNote, normalizeReasonCode } from '../safety/safety.common';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** The audit action of a bind (a direct-emit change code, not a read). */
export const AUDIT_ACTION_TRACKING_RESOLUTION_BIND = 'inventory.tracking_resolution.bind';

/** Roles that read the queue items; every other admitted role reads the count only (OD-9). */
const ITEM_READER_ROLES: ReadonlySet<string> = new Set(['owner', 'tenant_admin']);

export type QueueStatusFilter = 'unresolved' | 'resolved' | 'all';

export interface ListQueueInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
  readonly status?: QueueStatusFilter | undefined;
  readonly storeId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface BindInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
  readonly userId: string;
  /** The request's Idempotency-Key; only its fingerprint is stored. */
  readonly idempotencyKey: string;
  readonly saleId: string;
  readonly reasonCode: string;
  readonly note: string;
  readonly lines: ReadonlyArray<{ readonly saleLineId: string; readonly trackingIdentityId: string }>;
}

/** Contract `TrackingResolutionLineBinding`. */
export interface TrackingResolutionLineBody {
  readonly saleLineId: string;
  readonly trackingIdentityId: string;
}

/** Contract `TrackingResolution`. */
export interface TrackingResolutionBody {
  readonly id: string;
  readonly saleId: string;
  readonly reasonCode: string;
  readonly note: string;
  readonly resolvedBy: string;
  readonly resolvedAt: string;
  readonly lines: TrackingResolutionLineBody[];
}

/** Contract `UnresolvedTrackedLine`. */
interface UnresolvedLineBody {
  readonly saleLineId: string;
  readonly tenantProductRef: string;
  readonly reason: string;
  readonly sentIdentityId: string | null;
  readonly scannedCode: string | null;
  readonly quantity: string;
  readonly unit: string;
}

/** Contract `TrackingResolutionQueueItem`. */
interface QueueItemBody {
  readonly saleId: string;
  readonly storeId: string;
  readonly businessDate: string;
  readonly occurredAt: string;
  readonly capturedAt: string;
  readonly status: 'unresolved' | 'resolved';
  readonly unresolvedLines: UnresolvedLineBody[];
  readonly resolution: TrackingResolutionBody | null;
}

/** Contract `TrackingResolutionQueue`. */
export interface TrackingResolutionQueueBody {
  readonly items: QueueItemBody[];
  readonly nextCursor: string | null;
  readonly unresolvedCount: number;
}

interface ResolutionRow {
  readonly id: string;
  readonly sale_id: string;
  readonly reason_code: string;
  readonly note: string;
  readonly resolved_by: string;
  readonly resolved_at: Date;
}

const RESOLUTION_COLUMNS = 'id, sale_id, reason_code, note, resolved_by, resolved_at';

interface QueueRow {
  readonly sale_id: string;
  readonly store_id: string;
  readonly business_date: string;
  readonly occurred_at: Date;
  readonly captured_at: Date;
  readonly status: 'unresolved' | 'resolved';
  readonly at_key: string;
}

interface UnresolvedLineRow {
  readonly sale_id: string;
  readonly id: string;
  readonly tenant_product_ref: string;
  readonly reason: string;
  readonly sent_identity_id: string | null;
  readonly scanned_code: string | null;
  readonly quantity: string;
  readonly unit: string;
}

/**
 * The queue page. `$2` status, `$3` storeId, `$4` the scoped store ids (null
 * when tenant-wide, empty → no row), `$5`/`$6` the keyset position, `$7`
 * limit + 1. The unresolved half reads `sales`, the resolved half
 * `tracking_resolutions` (its own `(tenant, captured_at DESC, sale_id DESC)`
 * index); a bound sale is `tracked`, so they are disjoint.
 */
const QUEUE_SQL = `
  SELECT q.* FROM (
    SELECT s.id AS sale_id, s.store_id, s.business_date::text AS business_date, s.occurred_at,
           s.received_at AS captured_at, 'unresolved' AS status, ${instantKeySql('s.received_at')} AS at_key
      FROM sales s
     WHERE $2::text IN ('unresolved', 'all')
       AND s.tenant_id = $1 AND s.tracking_status = 'tracking_unresolved'
       AND ($3::uuid IS NULL OR s.store_id = $3)
       AND ($4::uuid[] IS NULL OR s.store_id = ANY($4::uuid[]))
       AND ($5::timestamptz IS NULL OR (s.received_at, s.id) < ($5::timestamptz, $6::uuid))
    UNION ALL
    SELECT r.sale_id, r.store_id, s.business_date::text AS business_date, s.occurred_at,
           r.captured_at, 'resolved' AS status, ${instantKeySql('r.captured_at')} AS at_key
      FROM tracking_resolutions r
      JOIN sales s ON s.id = r.sale_id AND s.tenant_id = r.tenant_id
     WHERE $2::text IN ('resolved', 'all')
       AND r.tenant_id = $1
       AND ($3::uuid IS NULL OR r.store_id = $3)
       AND ($4::uuid[] IS NULL OR r.store_id = ANY($4::uuid[]))
       AND ($5::timestamptz IS NULL OR (r.captured_at, r.sale_id) < ($5::timestamptz, $6::uuid))
  ) q
  ORDER BY q.captured_at DESC, q.sale_id DESC
  LIMIT $7`;

/** The unresolved sales in scope, whatever status, cursor and limit. */
const COUNT_SQL = `
  SELECT count(*)::int AS n FROM sales s
   WHERE s.tenant_id = $1 AND s.tracking_status = 'tracking_unresolved'
     AND ($2::uuid IS NULL OR s.store_id = $2)
     AND ($3::uuid[] IS NULL OR s.store_id = ANY($3::uuid[]))`;

/** The row-4 lines of the given sales, as captured, in capture order. */
const UNRESOLVED_LINES_SQL = `
  SELECT sl.sale_id, sl.id, sl.tenant_product_ref, sl.tracking_unresolved_reason AS reason,
         sl.tracking_identity_id AS sent_identity_id, sl.tracking_code AS scanned_code,
         sl.quantity::text AS quantity, sl.unit
    FROM sale_lines sl
   WHERE sl.sale_id = ANY($1::uuid[]) AND sl.tracking_class = 'unresolved'
   ORDER BY sl.sale_id, sl.line_seq NULLS LAST, sl.id`;

/** The normalized bind command. */
interface BindCommand {
  readonly saleId: string;
  readonly reasonCode: string;
  readonly note: string;
  /** Sorted by sale line id. */
  readonly lines: ReadonlyArray<TrackingResolutionLineBody>;
  readonly fingerprint: string;
}

interface LockedSale {
  readonly id: string;
  readonly store_id: string;
  readonly tracking_status: string | null;
  readonly business_date: string;
  readonly occurred_at: Date;
  readonly received_at: Date;
}

interface IdentityRow {
  readonly id: string;
  readonly product_id: string;
  readonly expiry_date: string | null;
  readonly has_edge_map: boolean;
}

@Injectable()
export class TrackingResolutionService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly memberships: MembershipRepository,
  ) {}

  // -------------------------------------------------------------------------
  // listTrackingResolutionQueue
  // -------------------------------------------------------------------------

  listQueue(input: ListQueueInput): Promise<TrackingResolutionQueueBody> {
    const status = input.status ?? 'unresolved';
    const storeId = input.storeId?.toLowerCase() ?? null;
    const binding: SafetyHistoryCursorBinding = {
      op: 'tracking_resolution_queue',
      tenantId: input.tenantId,
      filters: [status, storeId],
    };
    const after = decodeSafetyHistoryCursorOrReject(binding, input.cursor);
    const limit = pageLimit(input.limit);
    const tenantContext = { tenantId: input.tenantId, isPlatformAdmin: false };
    return runWithTenantContext(this.pool, tenantContext, async (client) => {
      const userId = input.context.userId;
      const role =
        userId === null ? null : await this.memberships.findRoleCodeForUserInTenant(userId, input.tenantId, client);
      const scope = await callerStoreScope(client, this.memberships, input);
      const scoped = scopeStoreIds(scope);
      const count = await client.query<{ n: number }>(COUNT_SQL, [input.tenantId, storeId, scoped]);
      const unresolvedCount = count.rows[0]?.n ?? 0;
      if (role === null || !ITEM_READER_ROLES.has(role)) {
        return { items: [], nextCursor: null, unresolvedCount };
      }
      const page = await client.query<QueueRow>(QUEUE_SQL, [
        input.tenantId,
        status,
        storeId,
        scoped,
        after?.atKey ?? null,
        after?.id ?? null,
        limit + 1,
      ]);
      const rows = page.rows.slice(0, limit);
      const items = await this.queueItems(client, rows);
      const last = rows[rows.length - 1];
      return {
        items,
        nextCursor:
          page.rows.length > limit && last
            ? encodeSafetyHistoryCursor(binding, { atKey: last.at_key, id: last.sale_id })
            : null,
        unresolvedCount,
      };
    });
  }

  private async queueItems(client: PoolClient, rows: readonly QueueRow[]): Promise<QueueItemBody[]> {
    if (rows.length === 0) return [];
    const saleIds = rows.map((r) => r.sale_id);
    const lines = await client.query<UnresolvedLineRow>(UNRESOLVED_LINES_SQL, [saleIds]);
    const linesBySale = groupBy(lines.rows, (l) => l.sale_id);
    const resolved = rows.filter((r) => r.status === 'resolved').map((r) => r.sale_id);
    const resolutions = await this.resolutionsOfSales(client, resolved);
    return rows.map((r) => ({
      saleId: r.sale_id,
      storeId: r.store_id,
      businessDate: r.business_date,
      occurredAt: r.occurred_at.toISOString(),
      capturedAt: r.captured_at.toISOString(),
      status: r.status,
      unresolvedLines: (linesBySale.get(r.sale_id) ?? []).map(toUnresolvedLineBody),
      resolution: resolutions.get(r.sale_id) ?? null,
    }));
  }

  /** The recorded resolutions of `saleIds`, by sale id. */
  private async resolutionsOfSales(
    client: PoolClient,
    saleIds: readonly string[],
  ): Promise<Map<string, TrackingResolutionBody>> {
    if (saleIds.length === 0) return new Map();
    const r = await client.query<ResolutionRow>(
      `SELECT ${RESOLUTION_COLUMNS} FROM tracking_resolutions WHERE sale_id = ANY($1::uuid[])`,
      [saleIds],
    );
    const lines = await this.bindingsOf(
      client,
      r.rows.map((row) => row.id),
    );
    return new Map(r.rows.map((row) => [row.sale_id, toResolutionBody(row, lines.get(row.id) ?? [])]));
  }

  /** The line bindings of `resolutionIds`, by resolution id, in sale-line id order. */
  private async bindingsOf(
    client: PoolClient,
    resolutionIds: readonly string[],
  ): Promise<Map<string, TrackingResolutionLineBody[]>> {
    if (resolutionIds.length === 0) return new Map();
    const r = await client.query<{ resolution_id: string; sale_line_id: string; tracking_identity_id: string }>(
      `SELECT resolution_id, sale_line_id, tracking_identity_id FROM tracking_resolution_lines
        WHERE resolution_id = ANY($1::uuid[]) ORDER BY resolution_id, sale_line_id`,
      [resolutionIds],
    );
    const out = new Map<string, TrackingResolutionLineBody[]>();
    for (const row of r.rows) {
      const list = out.get(row.resolution_id) ?? [];
      list.push({ saleLineId: row.sale_line_id, trackingIdentityId: row.tracking_identity_id });
      out.set(row.resolution_id, list);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // bindTrackingResolution
  // -------------------------------------------------------------------------

  bind(input: BindInput): Promise<TrackingResolutionBody> {
    const cmd = normalizeBind(input);
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      const scope = await callerStoreScope(client, this.memberships, input);
      // The sale's row lock serializes binds of one sale (and the worker's
      // processing UPDATE); a replay is read after it, so a concurrent twin
      // under the same key sees the first one's resolution.
      const sale = await lockSale(client, cmd.saleId);
      if (!sale || !inStoreScope(scope, sale.store_id)) throw new NotFoundException('Not Found');
      const replay = await this.findByFingerprint(client, cmd.fingerprint);
      if (replay) return this.replayResult(client, replay, cmd);

      const unresolved = await client.query<{ id: string; tenant_product_ref: string }>(
        `SELECT id, tenant_product_ref FROM sale_lines WHERE sale_id = $1 AND tracking_class = 'unresolved'`,
        [sale.id],
      );
      // Never `tracking_unresolved`: nothing to resolve (non-disclosing).
      if (unresolved.rows.length === 0) throw new NotFoundException('Not Found');
      const recorded = await client.query(`SELECT 1 FROM tracking_resolutions WHERE sale_id = $1`, [sale.id]);
      if ((recorded.rowCount ?? 0) > 0 || sale.tracking_status !== 'tracking_unresolved') {
        throw conflict('tracking_resolution_already_resolved', 'The sale is already resolved.');
      }
      const productOfLine = new Map(unresolved.rows.map((l) => [l.id, l.tenant_product_ref]));
      assertExactLines(cmd, productOfLine);

      const identities = await lockBoundIdentities(client, input.tenantId, cmd);
      await assertBindable(client, input.tenantId, sale, cmd, productOfLine, identities);

      const resolution = await insertResolution(client, input, sale, cmd).catch((err: unknown) => {
        // The same key used concurrently for another sale: the fingerprint
        // index refuses the second command (nothing of it is written).
        if (isUniqueViolation(err, 'uq_tracking_resolutions_tenant_fingerprint')) throw idempotencyConflict();
        throw err;
      });
      await client.query(
        `INSERT INTO tracking_resolution_lines
           (sale_line_id, tenant_id, resolution_id, tenant_product_ref, tracking_identity_id)
         SELECT b.line_id, $1, $2, b.product_id, b.identity_id
           FROM unnest($3::uuid[], $4::uuid[], $5::uuid[]) AS b(line_id, product_id, identity_id)`,
        [
          input.tenantId,
          resolution.id,
          cmd.lines.map((l) => l.saleLineId),
          cmd.lines.map((l) => productOfLine.get(l.saleLineId)!),
          cmd.lines.map((l) => l.trackingIdentityId),
        ],
      );
      // Every classified line now has an identity (0089's meaning of `tracked`).
      await client.query(`UPDATE sales SET tracking_status = 'tracked' WHERE id = $1 AND store_id = $2`, [
        sale.id,
        sale.store_id,
      ]);
      await writeSaleLineFindings(
        client,
        {
          tenantId: input.tenantId,
          storeId: sale.store_id,
          saleId: sale.id,
          businessDate: sale.business_date,
          occurredAt: sale.occurred_at.toISOString(),
        },
        cmd.lines
          .filter((l) => !identities.get(l.trackingIdentityId)!.has_edge_map)
          .map((l) => ({
            saleLineId: l.saleLineId,
            productId: productOfLine.get(l.saleLineId)!,
            identityId: l.trackingIdentityId,
            findings: [{ kind: 'erp_intent_held', cause: 'edge_map_missing', holdId: null }],
          })),
      );

      const outcome = await commitResolvedSale(client, {
        tenantId: input.tenantId,
        storeId: sale.store_id,
        saleId: sale.id,
        resolveLandingStatus: (c) => resolveReturnLandingStatus(c, input.tenantId),
      });

      await writeAudit(client, {
        tenantId: input.tenantId,
        userId: input.userId,
        action: AUDIT_ACTION_TRACKING_RESOLUTION_BIND,
        targetType: 'sale',
        targetId: sale.id,
        metadata: {
          trackingResolutionId: resolution.id,
          reasonCode: cmd.reasonCode,
          lines: cmd.lines,
          salePostEmitted: outcome.salePostEmitted,
          effectIds: outcome.effects.flatMap((e) => e.written),
          reEmittedReversals: outcome.reEmittedReversals,
        },
      });
      return toResolutionBody(resolution, [...cmd.lines]);
    });
  }

  private async findByFingerprint(client: PoolClient, commandFingerprint: string): Promise<ResolutionRow | undefined> {
    const r = await client.query<ResolutionRow>(
      `SELECT ${RESOLUTION_COLUMNS} FROM tracking_resolutions WHERE command_fingerprint = $1`,
      [commandFingerprint],
    );
    return r.rows[0];
  }

  /** The recorded resolution when `cmd` is the same command; else a 409. */
  private async replayResult(client: PoolClient, row: ResolutionRow, cmd: BindCommand): Promise<TrackingResolutionBody> {
    const lines = (await this.bindingsOf(client, [row.id])).get(row.id) ?? [];
    const recorded = [row.sale_id, row.reason_code, row.note, lines];
    const requested = [cmd.saleId, cmd.reasonCode, cmd.note, cmd.lines];
    if (JSON.stringify(recorded) !== JSON.stringify(requested)) throw idempotencyConflict();
    return toResolutionBody(row, lines);
  }
}

// ---------------------------------------------------------------------------
// Bind steps
// ---------------------------------------------------------------------------

function normalizeBind(input: BindInput): BindCommand {
  const reasonCode = normalizeReasonCode(input.reasonCode);
  const note = normalizeNote(input.note);
  if (note === null) throw new BadRequestException('note must not be blank');
  const lines = input.lines
    .map((l) => ({ saleLineId: l.saleLineId.toLowerCase(), trackingIdentityId: l.trackingIdentityId.toLowerCase() }))
    .sort((a, b) => byText(a.saleLineId, b.saleLineId));
  if (lines.length === 0) throw new BadRequestException('lines must not be empty');
  if (new Set(lines.map((l) => l.saleLineId)).size !== lines.length) {
    throw new BadRequestException('lines must name each saleLineId once');
  }
  return {
    saleId: input.saleId.toLowerCase(),
    reasonCode,
    note,
    lines,
    fingerprint: fingerprint(['tracking_resolution', input.userId.toLowerCase(), input.idempotencyKey]),
  };
}

/** The sale, locked FOR UPDATE for the rest of the bind; undefined when not of this tenant. */
async function lockSale(client: PoolClient, saleId: string): Promise<LockedSale | undefined> {
  const r = await client.query<LockedSale>(
    `SELECT id, store_id, tracking_status, business_date::text AS business_date, occurred_at, received_at
       FROM sales WHERE id = $1 FOR UPDATE`,
    [saleId],
  );
  return r.rows[0];
}

/** `lines` names each unresolved line of the sale exactly once and nothing else, else 400. */
function assertExactLines(cmd: BindCommand, productOfLine: ReadonlyMap<string, string>): void {
  const exact =
    cmd.lines.length === productOfLine.size && cmd.lines.every((l) => productOfLine.has(l.saleLineId));
  if (!exact) {
    throw new BadRequestException('lines must name every unresolved line of the sale exactly once, and nothing else');
  }
}

/**
 * Lock the bound identities FOR KEY SHARE in id order (the order the safety
 * commands lock them FOR UPDATE), then read them. A missing, other-tenant or
 * non-batch identity is a non-disclosing 404.
 */
async function lockBoundIdentities(
  client: PoolClient,
  tenantId: string,
  cmd: BindCommand,
): Promise<Map<string, IdentityRow>> {
  const ids = [...new Set(cmd.lines.map((l) => l.trackingIdentityId))].sort(byText);
  await client.query(
    `SELECT id FROM tracking_identities WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR KEY SHARE`,
    [tenantId, ids],
  );
  const r = await client.query<IdentityRow>(
    `SELECT i.id::text AS id, i.tenant_product_ref::text AS product_id, i.expiry_date::text AS expiry_date,
            EXISTS (SELECT 1 FROM erpnext_tracking_map m
                     WHERE m.tenant_id = i.tenant_id AND m.tracking_identity_id = i.id) AS has_edge_map
       FROM tracking_identities i
      WHERE i.tenant_id = $1 AND i.id = ANY($2::uuid[]) AND i.kind = 'batch'`,
    [tenantId, ids],
  );
  if (r.rows.length !== ids.length) throw new NotFoundException('Not Found');
  return new Map(r.rows.map((row) => [row.id, row]));
}

/** The 409 refusals, in the contract's order, each over every line. */
async function assertBindable(
  client: PoolClient,
  tenantId: string,
  sale: LockedSale,
  cmd: BindCommand,
  productOfLine: ReadonlyMap<string, string>,
  identities: ReadonlyMap<string, IdentityRow>,
): Promise<void> {
  const mismatch = cmd.lines.some(
    (l) => identities.get(l.trackingIdentityId)!.product_id !== productOfLine.get(l.saleLineId),
  );
  if (mismatch) {
    throw conflict('tracking_resolution_identity_mismatch', "An identity is not of the line's product.");
  }
  const held = await client.query(
    `SELECT 1 FROM tracking_holds
      WHERE tenant_id = $1 AND tracking_identity_id = ANY($2::uuid[])
        AND (released_at IS NULL
          OR (placed_at <= $3::timestamptz AND released_at > $3::timestamptz))
      LIMIT 1`,
    [tenantId, [...identities.keys()], sale.occurred_at],
  );
  if ((held.rowCount ?? 0) > 0) {
    throw conflict('tracking_resolution_identity_held', "An identity is held now or was held at the sale's occurredAt.");
  }
  const products = [...new Set(productOfLine.values())];
  const required = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM tenant_products WHERE id = ANY($1::uuid[]) AND expiry_required`,
    [products],
  );
  const expiryRequired = new Set(required.rows.map((r) => r.id));
  const expired = cmd.lines.some((l) => {
    const identity = identities.get(l.trackingIdentityId)!;
    // G7-5: sellable through its expiry date, inclusive; without an expiry,
    // expired only when the product requires one (fail closed, c16246).
    if (identity.expiry_date === null) return expiryRequired.has(productOfLine.get(l.saleLineId)!);
    return identity.expiry_date < sale.business_date;
  });
  if (expired) {
    throw conflict('tracking_resolution_identity_expired', "An identity is expired at the sale's business date.");
  }
}

async function insertResolution(
  client: PoolClient,
  input: BindInput,
  sale: LockedSale,
  cmd: BindCommand,
): Promise<ResolutionRow> {
  const r = await client.query<ResolutionRow>(
    `INSERT INTO tracking_resolutions
       (id, tenant_id, store_id, sale_id, captured_at, reason_code, note, command_fingerprint, resolved_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${RESOLUTION_COLUMNS}`,
    [newId(), input.tenantId, sale.store_id, sale.id, sale.received_at, cmd.reasonCode, cmd.note, cmd.fingerprint, input.userId],
  );
  const row = r.rows[0];
  if (!row) throw new Error('TrackingResolutionService: resolution INSERT returned no row');
  return row;
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

function toResolutionBody(row: ResolutionRow, lines: TrackingResolutionLineBody[]): TrackingResolutionBody {
  return {
    id: row.id,
    saleId: row.sale_id,
    reasonCode: row.reason_code,
    note: row.note,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at.toISOString(),
    lines,
  };
}

function toUnresolvedLineBody(row: UnresolvedLineRow): UnresolvedLineBody {
  return {
    saleLineId: row.id,
    tenantProductRef: row.tenant_product_ref,
    reason: row.reason,
    sentIdentityId: row.sent_identity_id,
    scannedCode: row.scanned_code,
    quantity: row.quantity,
    unit: row.unit,
  };
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && e.constraint === constraint;
}

/** `limit` clamped to 1-200, 50 when absent. */
function pageLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(key(row)) ?? [];
    list.push(row);
    out.set(key(row), list);
  }
  return out;
}
