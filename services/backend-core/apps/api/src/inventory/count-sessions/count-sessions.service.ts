/**
 * CountSessionsService — Jira RT-1420 (RT-292 Gate 6; contract RT-1419,
 * `inventory/inventory.yaml` 1.15.0-draft). The Retail-side Count Session
 * lifecycle: open, observe at position grain, Count Cut behind the barrier,
 * submit, review lines, recount, approve under the approval policy, cancel,
 * late pre-cut event findings. ERP-independent: approval writes append-only
 * `count_correction` effects (`not_posted`) and nothing else; there is no
 * intent, work item or posting. DARK: every operation answers the
 * non-disclosing 404 until the tenant's `count_sessions_enabled` is on (the
 * activation slice owns that switch).
 *
 * Every command runs in ONE `runWithTenantContext` transaction under the
 * session row lock (`FOR UPDATE`), so concurrent commands serialise and a
 * second approve finds the session already `approved`.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import { newId } from '@data-pulse-2/shared';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../../auth/auth.module';
import { InvalidCursorError } from '../../common/cursor/opaque-cursor';
import { MembershipRepository } from '../../context/membership.repository';
import { formatQuantity, parseQuantity } from '../decimal-quantity';
import {
  assertReferencesInTenant,
  emitMovementCreated,
  insertMovementRow,
  recordNotPosted,
} from '../inventory-write.helpers';
import { MOVEMENT_COLUMNS } from '../inventory.types';
import { writeAudit } from '../position-events/position-event.writer';
import { readBarrier } from './count-barrier';
import {
  decodeCountCursor,
  encodeCountCursor,
  type CountCursorBinding,
} from './count-session.cursor';
import {
  CountRuleError,
  approvalOutcome,
  checkAcknowledgements,
  nextState,
  positionCorrections,
  type CountSessionState,
} from './count-session.rules';
import {
  LIVE_STATES,
  buildLine,
  counterIds,
  findingBody,
  loadLines,
  loadSession,
  scanLateEvents,
  scopeConflict,
  sessionBody,
  type BuiltLine,
  type CountSessionBody,
  type FindingBody,
  type ObservationBody,
  type SessionRow,
  type VarianceLineBody,
} from './count-session.store';

const AUDIT_TARGET = 'count_session';

export interface CountCaller {
  readonly tenantId: string;
  readonly userId: string;
}

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export interface ObservationInput {
  readonly productId: string;
  readonly locationId: string;
  readonly inventoryStatus: string;
  readonly countedQuantity: string;
  readonly stockingUnit: string;
}

function audit(
  client: PoolClient,
  caller: CountCaller,
  action: string,
  sessionId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  return writeAudit(client, {
    tenantId: caller.tenantId,
    userId: caller.userId,
    action: `inventory.count_session.${action}`,
    targetType: AUDIT_TARGET,
    targetId: sessionId,
    metadata,
  });
}

/** Map a pure-rule refusal to the HTTP error of the existing envelope. */
function toHttp(err: unknown): unknown {
  if (err instanceof InvalidCursorError)
    return new BadRequestException({ code: 'validation_error', message: err.message });
  if (!(err instanceof CountRuleError)) return err;
  if (err.code === 'validation_error') return new BadRequestException(err.message);
  return new ConflictException({ code: err.code, message: err.message });
}

@Injectable()
export class CountSessionsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  private async tx<T>(caller: CountCaller, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await runWithTenantContext(
        this.pool,
        { tenantId: caller.tenantId, isPlatformAdmin: false },
        async (client) => {
          await this.assertEnabled(client, caller.tenantId);
          return await fn(client);
        },
      );
    } catch (err) {
      throw toHttp(err);
    }
  }

  /** Dark by default: until the tenant is switched on, every operation is the non-disclosing 404. */
  private async assertEnabled(client: PoolClient, tenantId: string): Promise<void> {
    const r = await client.query<{ on: boolean }>(
      `SELECT count_sessions_enabled AS on FROM tenant_inventory_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    if (r.rows[0]?.on !== true) throw new NotFoundException('Not Found');
  }

  private async lockedSession(
    client: PoolClient,
    storeId: string,
    sessionId: string,
  ): Promise<SessionRow> {
    const row = await loadSession(client, storeId, sessionId, true);
    if (!row) throw new NotFoundException('Not Found');
    return row;
  }

  /** Lock the session and fold in any late pre-cut event before a command reads it. */
  private async lockedAndScanned(
    client: PoolClient,
    storeId: string,
    sessionId: string,
  ): Promise<SessionRow> {
    const row = await this.lockedSession(client, storeId, sessionId);
    return (await scanLateEvents(client, row)).session;
  }

  private async bodyOf(
    client: PoolClient,
    storeId: string,
    sessionId: string,
  ): Promise<CountSessionBody> {
    const row = await loadSession(client, storeId, sessionId, false);
    if (!row) throw new NotFoundException('Not Found');
    return await sessionBody(client, row);
  }

  /**
   * Fold late pre-cut events into the session in their OWN committed transaction,
   * before a command that may refuse: a refusal rolls its transaction back, and
   * the findings (and invalidations) must not be lost with it.
   */
  private async scanCommitted(
    caller: CountCaller,
    storeId: string,
    sessionId: string,
  ): Promise<void> {
    await this.tx(caller, async (client) => {
      await this.lockedAndScanned(client, storeId, sessionId);
    });
  }

  /** A command on one session: late events first (committed), then the session locked and re-scanned. */
  private command<T>(
    caller: CountCaller,
    storeId: string,
    sessionId: string,
    fn: (client: PoolClient, session: SessionRow) => Promise<T>,
  ): Promise<T> {
    return this.scanCommitted(caller, storeId, sessionId).then(() =>
      this.tx(caller, async (client) =>
        fn(client, await this.lockedAndScanned(client, storeId, sessionId)),
      ),
    );
  }

  // ---- open ------------------------------------------------------------------

  createSession(
    caller: CountCaller,
    storeId: string,
    productIds: readonly string[],
    note: string | null,
  ): Promise<CountSessionBody> {
    return this.tx(caller, async (client) => {
      await assertReferencesInTenant(client, { storeIds: [storeId] });
      const ids = [...new Set(productIds)];
      const products = await client.query<{ id: string; tracking_mode: string }>(
        `SELECT id, tracking_mode FROM tenant_products WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      if (products.rows.length !== ids.length) throw new NotFoundException('Not Found');
      if (products.rows.some((p) => p.tracking_mode !== 'none')) {
        throw new ConflictException({
          code: 'count_tracked_product_refused',
          message: 'A tracked product (batch or serial) cannot be counted yet.',
        });
      }
      // Serialise concurrent opens of one store so two sessions never share a product.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('count_sessions:' || $1::text, 0))`,
        [storeId],
      );
      const clash = await client.query(
        `SELECT 1 FROM count_sessions WHERE store_id = $1 AND state = ANY($2::text[]) AND scope_product_ids && $3::uuid[] LIMIT 1`,
        [storeId, LIVE_STATES, ids],
      );
      if (clash.rows.length > 0) throw scopeConflict();
      const sessionId = newId();
      await client.query(
        `INSERT INTO count_sessions (id, tenant_id, store_id, state, scope_product_ids, note, opened_by)
         VALUES ($1, $2, $3, 'open', $4::uuid[], $5, $6)`,
        [sessionId, caller.tenantId, storeId, ids, note, caller.userId],
      );
      await client.query(
        `INSERT INTO count_session_lines (session_id, tenant_id, store_id, tenant_product_ref)
         SELECT $1::uuid, $2::uuid, $3::uuid, p FROM unnest($4::uuid[]) AS p`,
        [sessionId, caller.tenantId, storeId, ids],
      );
      await audit(client, caller, 'open', sessionId, { storeId, productCount: ids.length });
      return await this.bodyOf(client, storeId, sessionId);
    });
  }

  // ---- reads -------------------------------------------------------------------

  getSession(caller: CountCaller, storeId: string, sessionId: string): Promise<CountSessionBody> {
    return this.tx(caller, async (client) => {
      await this.lockedAndScanned(client, storeId, sessionId);
      return await this.bodyOf(client, storeId, sessionId);
    });
  }

  listSessions(
    caller: CountCaller,
    storeId: string,
    state: CountSessionState | null,
    cursor: string | null,
    limit: number,
  ): Promise<Page<CountSessionBody>> {
    const binding: CountCursorBinding = {
      operation: 'sessions',
      storeId,
      sessionId: null,
      filter: state,
    };
    return this.tx(caller, async (client) => {
      await assertReferencesInTenant(client, { storeIds: [storeId] });
      const after = cursor ? decodeCountCursor(cursor, binding) : null;
      const rows = await client.query<{ id: string; opened_at_text: string }>(
        `SELECT id, opened_at::text AS opened_at_text FROM count_sessions
          WHERE store_id = $1 AND ($2::text IS NULL OR state = $2)
            AND ($3::timestamptz IS NULL OR (opened_at, id) < ($3::timestamptz, $4::uuid))
          ORDER BY opened_at DESC, id DESC LIMIT $5`,
        [storeId, state, after?.a ?? null, after?.b || null, limit + 1],
      );
      const page = rows.rows.slice(0, limit);
      const items: CountSessionBody[] = [];
      for (const r of page) items.push(await this.bodyOf(client, storeId, r.id));
      const last = page[page.length - 1];
      const more = rows.rows.length > limit && last;
      return {
        items,
        nextCursor: more
          ? encodeCountCursor(binding, { a: last.opened_at_text, b: last.id })
          : null,
      };
    });
  }

  listVarianceLines(
    caller: CountCaller,
    storeId: string,
    sessionId: string,
    flagged: boolean | null,
    cursor: string | null,
    limit: number,
  ): Promise<Page<VarianceLineBody>> {
    const binding: CountCursorBinding = {
      operation: 'lines',
      storeId,
      sessionId,
      filter: flagged === null ? null : String(flagged),
    };
    return this.command(caller, storeId, sessionId, async (client, session) => {
      if (
        !['submitted', 'approved', 'posting', 'confirmed', 'needs_attention', 'closed'].includes(
          session.state,
        )
      ) {
        throw new ConflictException({
          code: 'count_session_not_in_state',
          message: 'The review lines are available once the session is submitted.',
        });
      }
      const after = cursor ? decodeCountCursor(cursor, binding) : null;
      const all = (await loadLines(client, sessionId)).filter(
        (l) => !after || l.tenant_product_ref > after.a,
      );
      const items: VarianceLineBody[] = [];
      let nextCursor: string | null = null;
      for (const row of all) {
        const built = await buildLine(client, session, row);
        if (flagged !== null && built.body.flags.length > 0 !== flagged) continue;
        if (items.length === limit) {
          nextCursor = encodeCountCursor(binding, { a: items[items.length - 1]!.productId, b: '' });
          break;
        }
        items.push(built.body);
      }
      return { items, nextCursor };
    });
  }

  listLateEventFindings(
    caller: CountCaller,
    storeId: string,
    sessionId: string,
    cursor: string | null,
    limit: number,
  ): Promise<Page<FindingBody>> {
    const binding: CountCursorBinding = { operation: 'findings', storeId, sessionId, filter: null };
    return this.tx(caller, async (client) => {
      await this.lockedAndScanned(client, storeId, sessionId);
      const after = cursor ? decodeCountCursor(cursor, binding) : null;
      const rows = await client.query(
        `SELECT id, session_id, tenant_product_ref, assessment, quantity::text AS quantity, event_type, event_reference,
                source_system, external_id, effect_id, oversell_risk, erp_stamp, detected_at, detected_at::text AS detected_text,
                detected_in_state
           FROM count_late_event_findings
          WHERE session_id = $1 AND ($2::timestamptz IS NULL OR (detected_at, id) > ($2::timestamptz, $3::uuid))
          ORDER BY detected_at, id LIMIT $4`,
        [sessionId, after?.a ?? null, after?.b || null, limit + 1],
      );
      const page = rows.rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((r) => findingBody(r)),
        nextCursor:
          rows.rows.length > limit && last
            ? encodeCountCursor(binding, { a: last.detected_text, b: last.id })
            : null,
      };
    });
  }

  // ---- commands ------------------------------------------------------------------

  recordObservations(
    caller: CountCaller,
    storeId: string,
    sessionId: string,
    observations: readonly ObservationInput[],
  ): Promise<{ sessionId: string; observations: ObservationBody[] }> {
    return this.command(caller, storeId, sessionId, async (client, session) => {
      nextState(session.state, 'observe');
      const inScope = new Set(session.scope_product_ids);
      if (observations.some((o) => !inScope.has(o.productId))) {
        throw new BadRequestException('A counted product is outside the session scope.');
      }
      const locationIds = [...new Set(observations.map((o) => o.locationId))];
      const active = await client.query<{ id: string }>(
        `SELECT id FROM stock_locations WHERE id = ANY($1::uuid[]) AND store_id = $2 AND is_active`,
        [locationIds, storeId],
      );
      if (active.rows.length !== locationIds.length) {
        throw new BadRequestException(
          'A counted location is not an active location of this store.',
        );
      }
      const written: ObservationBody[] = [];
      for (const o of observations) {
        const r = await client.query<{ counted_at: Date }>(
          `INSERT INTO count_observations
             (id, session_id, tenant_id, store_id, tenant_product_ref, location_id, inventory_status,
              counted_quantity, stocking_unit, counted_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric(19,4), $9, $10)
           RETURNING counted_at`,
          [
            newId(),
            sessionId,
            caller.tenantId,
            storeId,
            o.productId,
            o.locationId,
            o.inventoryStatus,
            formatQuantity(parseQuantity(o.countedQuantity, 'countedQuantity')),
            o.stockingUnit.trim(),
            caller.userId,
          ],
        );
        written.push({
          productId: o.productId,
          locationId: o.locationId,
          inventoryStatus: o.inventoryStatus,
          countedQuantity: formatQuantity(parseQuantity(o.countedQuantity)),
          stockingUnit: o.stockingUnit.trim(),
          countedBy: caller.userId,
          countedAt: r.rows[0]!.counted_at.toISOString(),
        });
      }
      await client.query(`UPDATE count_sessions SET updated_at = now() WHERE id = $1`, [sessionId]);
      return { sessionId, observations: written };
    });
  }

  takeCut(caller: CountCaller, storeId: string, sessionId: string): Promise<CountSessionBody> {
    return this.tx(caller, async (client) => {
      const session = await this.lockedSession(client, storeId, sessionId);
      nextState(session.state, 'cut');
      // One timestamp is both the request time the barrier is judged against and the cut.
      const requested = (await client.query<{ t: Date }>(`SELECT clock_timestamp() AS t`)).rows[0]!
        .t;
      const verdict = await readBarrier(client, storeId, requested);
      if (!verdict.allowed) {
        throw new ConflictException({
          code: 'count_cut_barrier_not_met',
          message:
            `The Count Cut cannot be taken yet. Blocking devices: ${verdict.blockingDeviceIds.join(', ') || 'none'}. ` +
            `Blocking warehouses: ${verdict.blockingWarehouses.join(', ') || 'none'}.`,
        });
      }
      const effects = await client.query<{ n: string; last_id: string | null }>(
        `SELECT count(*)::text AS n, max(id::text) AS last_id FROM stock_movements WHERE store_id = $1 AND received_at <= $2::timestamptz`,
        [storeId, requested],
      );
      const watermark = `${requested.toISOString()}#${effects.rows[0]!.n}#${effects.rows[0]!.last_id ?? '-'}`;
      // Expected-at-cut: effects recorded at or before the cut only (later ones never change it).
      await client.query(
        `INSERT INTO count_session_expected
           (session_id, tenant_id, store_id, tenant_product_ref, location_id, inventory_status, expected_quantity)
         SELECT $1::uuid, $2::uuid, $3::uuid, m.tenant_product_ref,
                COALESCE(m.stock_location_id, (SELECT id FROM stock_locations WHERE store_id = $3::uuid AND kind = 'primary')),
                COALESCE(m.inventory_status, 'sellable'), SUM(m.quantity)
           FROM stock_movements m
          WHERE m.store_id = $3::uuid AND m.tenant_product_ref = ANY($4::uuid[]) AND m.received_at <= $5::timestamptz
          GROUP BY m.tenant_product_ref, 5, 6
         HAVING SUM(m.quantity) <> 0`,
        [sessionId, caller.tenantId, storeId, session.scope_product_ids, requested],
      );
      await client.query(
        `UPDATE count_session_lines l
            SET expected_total = COALESCE((SELECT SUM(e.expected_quantity) FROM count_session_expected e
                                            WHERE e.session_id = l.session_id AND e.tenant_product_ref = l.tenant_product_ref), 0),
                stocking_unit = (SELECT m.stocking_unit FROM stock_movements m
                                  WHERE m.store_id = l.store_id AND m.tenant_product_ref = l.tenant_product_ref
                                  ORDER BY m.received_at, m.id LIMIT 1),
                updated_at = now()
          WHERE l.session_id = $1`,
        [sessionId],
      );
      await client.query(
        `UPDATE count_sessions SET state = 'cut_taken', cut_at = $2::timestamptz, cut_watermark = $3, cut_taken_by = $4,
                updated_at = now() WHERE id = $1`,
        [sessionId, requested, watermark, caller.userId],
      );
      await audit(client, caller, 'cut', sessionId, { storeId, watermark });
      return await this.bodyOf(client, storeId, sessionId);
    });
  }

  submit(caller: CountCaller, storeId: string, sessionId: string): Promise<CountSessionBody> {
    return this.command(caller, storeId, sessionId, async (client, session) => {
      nextState(session.state, 'submit');
      const lines = await loadLines(client, sessionId);
      const built: BuiltLine[] = [];
      for (const l of lines) built.push(await buildLine(client, session, l)); // refuses an out-of-range total (400)
      if (built.some((b) => b.observed.length === 0)) {
        throw new BadRequestException('Every product of the scope needs at least one observation.');
      }
      // A product with no stock history takes the unit of its observations.
      await client.query(
        `UPDATE count_session_lines l
            SET stocking_unit = (SELECT o.stocking_unit FROM count_observations o
                                  WHERE o.session_id = l.session_id AND o.tenant_product_ref = l.tenant_product_ref AND o.seq > l.reset_after_seq
                                  ORDER BY o.seq LIMIT 1)
          WHERE l.session_id = $1 AND l.stocking_unit IS NULL`,
        [sessionId],
      );
      await client.query(
        `UPDATE count_sessions SET state = 'submitted', submitted_by = $2, submitted_at = now(), updated_at = now() WHERE id = $1`,
        [sessionId, caller.userId],
      );
      await audit(client, caller, 'submit', sessionId, { storeId, lines: lines.length });
      return await this.bodyOf(client, storeId, sessionId);
    });
  }

  requestRecount(
    caller: CountCaller,
    storeId: string,
    sessionId: string,
    productIds: readonly string[],
    reason: string,
  ): Promise<CountSessionBody> {
    return this.command(caller, storeId, sessionId, async (client, session) => {
      nextState(session.state, 'recount');
      const inScope = new Set(session.scope_product_ids);
      if (productIds.some((p) => !inScope.has(p))) {
        throw new BadRequestException('A recount product is outside the session scope.');
      }
      await client.query(
        `UPDATE count_session_lines l
            SET reset_after_seq = COALESCE((SELECT max(o.seq) FROM count_observations o
                                             WHERE o.session_id = l.session_id AND o.tenant_product_ref = l.tenant_product_ref), 0),
                line_version = l.line_version + 1,
                acknowledged_by = NULL, acknowledged_at = NULL, acknowledged_version = NULL, acknowledgement_note = NULL,
                updated_at = now()
          WHERE l.session_id = $1 AND l.tenant_product_ref = ANY($2::uuid[])`,
        [sessionId, [...new Set(productIds)]],
      );
      await client.query(
        `UPDATE count_sessions SET state = 'cut_taken', submitted_by = NULL, submitted_at = NULL, updated_at = now() WHERE id = $1`,
        [sessionId],
      );
      await audit(client, caller, 'recount', sessionId, {
        storeId,
        reason,
        productCount: new Set(productIds).size,
      });
      return await this.bodyOf(client, storeId, sessionId);
    });
  }

  approve(
    caller: CountCaller,
    storeId: string,
    sessionId: string,
    acknowledgements: ReadonlyArray<{
      productId: string;
      lineVersion: string;
      note: string | null;
    }>,
  ): Promise<CountSessionBody> {
    return this.command(caller, storeId, sessionId, async (client, session) => {
      nextState(session.state, 'approve');
      const inScope = new Set(session.scope_product_ids);
      if (acknowledgements.some((a) => !inScope.has(a.productId))) {
        throw new BadRequestException('An acknowledged product is outside the session scope.');
      }
      const lines = await loadLines(client, sessionId);
      const built: BuiltLine[] = [];
      for (const l of lines) built.push(await buildLine(client, session, l));
      checkAcknowledgements(
        built.map((b) => ({
          productId: b.body.productId,
          lineVersion: b.body.lineVersion,
          flags: b.body.flags,
          refusal: b.body.refusal?.code ?? null,
        })),
        acknowledgements,
      );
      const settings = await client.query<{ on: boolean }>(
        `SELECT count_self_approval_enabled AS on FROM tenant_inventory_settings WHERE tenant_id = $1`,
        [caller.tenantId],
      );
      const outcome = approvalOutcome({
        approverId: caller.userId,
        counterIds: await counterIds(client, sessionId),
        submittedBy: session.submitted_by,
        exceptionEnabled: settings.rows[0]?.on === true,
      });
      let reason: string | null = null;
      if (outcome.policy === 'small_merchant_exception') {
        const why = await client.query<{ reason: string }>(
          `SELECT count_self_approval_reason AS reason FROM tenant_inventory_settings WHERE tenant_id = $1`,
          [caller.tenantId],
        );
        reason = why.rows[0]?.reason ?? null;
      }

      let correctionCount = 0;
      for (const b of built) {
        const ack = acknowledgements.find((a) => a.productId === b.body.productId);
        await client.query(
          `UPDATE count_session_lines
              SET refusal_code = $3,
                  acknowledged_by = CASE WHEN $4::boolean THEN $5::uuid ELSE acknowledged_by END,
                  acknowledged_at = CASE WHEN $4::boolean THEN now() ELSE acknowledged_at END,
                  acknowledged_version = CASE WHEN $4::boolean THEN line_version ELSE acknowledged_version END,
                  acknowledgement_note = CASE WHEN $4::boolean THEN $6 ELSE acknowledgement_note END,
                  updated_at = now()
            WHERE session_id = $1 AND tenant_product_ref = $2`,
          [
            sessionId,
            b.body.productId,
            b.body.refusal?.code ?? null,
            ack !== undefined,
            caller.userId,
            ack?.note ?? null,
          ],
        );
        if (b.body.refusal !== null) continue; // a refused line writes no correction; the rest proceeds
        correctionCount += await this.writeCorrections(client, session, b, caller.userId);
      }
      await client.query(
        `UPDATE count_sessions
            SET state = 'approved', approved_by = $2, approved_at = now(), approval_policy = $3, self_approved = $4,
                approval_reason = $5, updated_at = now()
          WHERE id = $1`,
        [sessionId, caller.userId, outcome.policy, outcome.selfApproved, reason],
      );
      await writeAudit(client, {
        tenantId: caller.tenantId,
        userId: caller.userId,
        action: 'inventory.count_session.approve',
        targetType: AUDIT_TARGET,
        targetId: sessionId,
        metadata: {
          storeId,
          policy: outcome.policy,
          selfApproved: outcome.selfApproved,
          reason,
          corrections: correctionCount,
        },
      });
      return await this.bodyOf(client, storeId, sessionId);
    });
  }

  /** Append the line's per-position `count_correction` effects, once (the line row guards a replay). */
  private async writeCorrections(
    client: PoolClient,
    session: SessionRow,
    b: BuiltLine,
    userId: string,
  ): Promise<number> {
    const deltas = positionCorrections(b.expected, b.observed);
    if (deltas.length === 0 || b.row.correction_effect_ids !== null) return 0;
    const unit = b.body.stockingUnit;
    const stockCountId = newId();
    await client.query(
      `INSERT INTO stock_counts
         (id, tenant_id, store_id, tenant_product_ref, counted_quantity, derived_on_hand_at_count, stocking_unit, counted_at, created_by)
       VALUES ($1, $2, $3, $4, $5::numeric(19,4), $6::numeric(19,4), $7, now(), $8)`,
      [
        stockCountId,
        session.tenant_id,
        session.store_id,
        b.body.productId,
        b.body.countedQuantity,
        b.body.expectedQuantity,
        unit,
        userId,
      ],
    );
    const effectIds: string[] = [];
    for (const d of deltas) {
      const row = await insertMovementRow(
        client,
        `INSERT INTO stock_movements
           (id, tenant_id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref, stock_count_id, reason,
            occurred_at, created_by, event_type, event_ref_id, stock_location_id, inventory_status)
         VALUES ($1, $2, $3, 'count_correction', $4::numeric(19,4), $5, $6, $7, 'count session variance', now(), $8,
                 'count', $7, $9, $10)
         RETURNING ${MOVEMENT_COLUMNS}`,
        [
          newId(),
          session.tenant_id,
          session.store_id,
          d.quantity,
          unit,
          b.body.productId,
          stockCountId,
          userId,
          d.locationId,
          d.inventoryStatus,
        ],
        { storeId: session.store_id, tenantProductRef: b.body.productId, suppliedUnit: unit },
      );
      const id = row.rows[0]?.id;
      if (!id) throw new Error('CountSessionsService: correction INSERT returned no row');
      effectIds.push(id);
    }
    await recordNotPosted(client, session.tenant_id, effectIds);
    await client.query(
      `UPDATE count_session_lines SET stock_count_id = $3, correction_effect_ids = $4::uuid[], updated_at = now()
        WHERE session_id = $1 AND tenant_product_ref = $2`,
      [session.id, b.body.productId, stockCountId, effectIds],
    );
    await emitMovementCreated(client, {
      tenantId: session.tenant_id,
      storeId: session.store_id,
      movementIds: effectIds,
      movementType: 'count_correction',
      tenantProductRef: b.body.productId,
      provenance: { stockCountId, countSessionId: session.id },
    });
    return effectIds.length;
  }

  cancel(
    caller: CountCaller,
    storeId: string,
    sessionId: string,
    reason: string,
  ): Promise<CountSessionBody> {
    return this.tx(caller, async (client) => {
      const session = await this.lockedSession(client, storeId, sessionId);
      nextState(session.state, 'cancel');
      await client.query(
        `UPDATE count_sessions SET state = 'cancelled', cancelled_by = $2, cancelled_at = now(), cancel_reason = $3,
                updated_at = now() WHERE id = $1`,
        [sessionId, caller.userId, reason],
      );
      await audit(client, caller, 'cancel', sessionId, { storeId, reason });
      return await this.bodyOf(client, storeId, sessionId);
    });
  }

  // ---- G6-10 exception (owner only; no route in this contract) -----------------------

  /**
   * The tenant owner's audited small-merchant exception. Owner only (a
   * tenant_admin, a platform admin and Retail Tower staff cannot), with a
   * recorded reason. There is no route for it in the RT-1419 contract; the
   * activation slice exposes it.
   */
  async setSelfApprovalException(
    caller: CountCaller,
    enabled: boolean,
    reason: string | null,
  ): Promise<{ enabled: boolean }> {
    try {
      return await runWithTenantContext(
        this.pool,
        { tenantId: caller.tenantId, isPlatformAdmin: false },
        async (client) => {
          const role = await this.memberships.findRoleCodeForUserInTenant(
            caller.userId,
            caller.tenantId,
            client,
          );
          if (role !== 'owner')
            throw new ForbiddenException(
              'Only the tenant owner can change the approval exception.',
            );
          const text = reason?.trim() ?? '';
          if (enabled && (text.length === 0 || text.length > 500)) {
            throw new BadRequestException(
              'Enabling the exception needs a reason of 1 to 500 characters.',
            );
          }
          await client.query(
            `INSERT INTO tenant_inventory_settings
             (tenant_id, count_self_approval_enabled, count_self_approval_reason, count_self_approval_changed_at,
              count_self_approval_changed_by, updated_by)
           VALUES ($1, $2, $3, now(), $4, $4)
           ON CONFLICT (tenant_id) DO UPDATE
             SET count_self_approval_enabled = EXCLUDED.count_self_approval_enabled,
                 count_self_approval_reason = EXCLUDED.count_self_approval_reason,
                 count_self_approval_changed_at = EXCLUDED.count_self_approval_changed_at,
                 count_self_approval_changed_by = EXCLUDED.count_self_approval_changed_by,
                 updated_by = EXCLUDED.updated_by`,
            [caller.tenantId, enabled, enabled ? text : null, caller.userId],
          );
          await writeAudit(client, {
            tenantId: caller.tenantId,
            userId: caller.userId,
            action: 'inventory.count_self_approval.update',
            targetType: 'tenant_inventory_settings',
            targetId: caller.tenantId,
            metadata: { enabled, reason: enabled ? text : null },
          });
          return { enabled };
        },
      );
    } catch (err) {
      throw toHttp(err);
    }
  }
}
