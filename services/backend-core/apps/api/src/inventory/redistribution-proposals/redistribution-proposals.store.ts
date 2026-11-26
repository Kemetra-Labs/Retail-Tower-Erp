/**
 * RT-1600 — the SQL of the W9 redistribution proposals (migration 0134), on the caller's tenant-scoped client (RLS FORCE
 * on both tables). Nothing here opens a transaction or decides a rule: the service does. The W3 reads (established
 * unit, shipment-transfers switch) are W3's own helpers, not copies.
 *
 * Expiry is computed on read (no sweep): a non-terminal proposal past `expires_at` is REPORTED `expired`. Only a later
 * compute stores `expired` on it (`retireLiveProposal`), so the one-live-proposal index frees for the new one.
 */
import { newId } from '@data-pulse-2/shared';
import type { PoolClient } from 'pg';
import { z } from 'zod';

import { decodeOpaque, encodeOpaque, InvalidCursorError } from '../../common/cursor/opaque-cursor';
import type {
  BufferPolicyV1,
  RedistributionLimitsV1,
  RedistributionMoveV1,
  RedistributionObjectiveV1,
  RedistributionWarningV1,
} from '../redistribution/types';
import type { AcceptDecision } from './redistribution-accept.plan';
import type { ProposalStore } from './redistribution-problem';

const LIVE_STATES = ['open', 'reviewed', 'partially_accepted'] as const;

export interface ProposalRow {
  readonly id: string;
  readonly state: string;
  readonly created_by: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly decided_at: Date | null;
  readonly superseded_by: string | null;
  readonly reject_reason: string | null;
  readonly rule_name: string;
  readonly rule_version: string;
  readonly computed_at: Date;
  readonly limits: RedistributionLimitsV1;
  readonly buffer: BufferPolicyV1;
  readonly stores: ProposalStore[];
  readonly warnings: RedistributionWarningV1[];
  readonly deficit_before: string;
  readonly deficit_after: string;
  readonly store_pairs: number;
  readonly line_count: number;
}

export interface LineRow {
  readonly id: string;
  readonly line_seq: number;
  readonly product_id: string;
  readonly source_store_id: string;
  readonly destination_store_id: string;
  readonly quantity: string;
  readonly stocking_unit: string;
  readonly warnings: { code: string }[];
  readonly review_decision: string | null;
  readonly review_note: string | null;
  readonly reviewed_at: Date | null;
  readonly reviewed_by: string | null;
  readonly accept_outcome: string | null;
  readonly accept_created_quantity: string | null;
  readonly accept_transfer_id: string | null;
  readonly accept_reason: string | null;
  readonly accepted_at: Date | null;
  readonly accepted_by: string | null;
}

const PROPOSAL_COLUMNS = `id, state, created_by, created_at, expires_at, decided_at, superseded_by, reject_reason,
  rule_name, rule_version, computed_at, limits, buffer, stores, warnings,
  objective_deficit_before::text AS deficit_before, objective_deficit_after::text AS deficit_after,
  objective_store_pairs AS store_pairs, objective_lines AS line_count`;

const LINE_COLUMNS = `id, line_seq, product_id, source_store_id, destination_store_id, quantity::text AS quantity, stocking_unit,
  warnings, review_decision, review_note, reviewed_at, reviewed_by, accept_outcome,
  accept_created_quantity::text AS accept_created_quantity, accept_transfer_id, accept_reason, accepted_at, accepted_by`;

/** The state a proposal is REPORTED in at `now`: a live one past its expiry is `expired`. */
export function effectiveState(row: Pick<ProposalRow, 'state' | 'expires_at'>, nowMs: number): string {
  const live = (LIVE_STATES as readonly string[]).includes(row.state);
  return live && row.expires_at.getTime() <= nowMs ? 'expired' : row.state;
}

/**
 * The tenant's proposal lock, held to the end of the transaction. Every command (compute, review, accept, reject)
 * takes it `exclusive`, so commands serialise; every read takes it `shared`, so a read waits for an in-flight command
 * and its separate statements (a proposal header, then its lines) see one consistent state (review, PR #901).
 */
export async function lockTenantProposals(client: PoolClient, tenantId: string, mode: 'exclusive' | 'shared'): Promise<void> {
  const fn = mode === 'exclusive' ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared';
  await client.query(`SELECT ${fn}(hashtextextended('redistribution_proposals:' || $1::text, 0))`, [tenantId]);
}

/**
 * Retire the tenant's live proposal, if any, before a compute stores a new one: past its expiry it becomes `expired`
 * (never `superseded`); otherwise `superseded`, naming `supersededBy` (null when the compute stored nothing). Returns
 * what happened to which proposal, or null when there was none.
 */
export async function retireLiveProposal(
  client: PoolClient,
  now: Date,
  supersededBy: string | null,
): Promise<{ readonly id: string; readonly became: 'expired' | 'superseded' } | null> {
  const live = await client.query<{ id: string; expires_at: Date }>(
    `SELECT id, expires_at FROM redistribution_proposals WHERE state = ANY($1::text[]) FOR UPDATE`,
    [LIVE_STATES],
  );
  const row = live.rows[0];
  if (row === undefined) return null;
  if (row.expires_at.getTime() <= now.getTime()) {
    await client.query(`UPDATE redistribution_proposals SET state = 'expired', updated_at = $2 WHERE id = $1`, [row.id, now]);
    return { id: row.id, became: 'expired' };
  }
  await client.query(
    `UPDATE redistribution_proposals SET state = 'superseded', decided_at = $2, superseded_by = $3, updated_at = $2 WHERE id = $1`,
    [row.id, now, supersededBy],
  );
  return { id: row.id, became: 'superseded' };
}

export interface NewProposal {
  readonly id: string;
  readonly tenantId: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly computedAt: Date;
  readonly rule: { readonly name: string; readonly version: string };
  readonly limits: RedistributionLimitsV1;
  readonly buffer: BufferPolicyV1;
  readonly stores: readonly ProposalStore[];
  readonly warnings: readonly RedistributionWarningV1[];
  readonly objective: RedistributionObjectiveV1;
  readonly moves: readonly RedistributionMoveV1[];
}

/** Insert a proposal in state `open` and its lines (line_seq follows the engine's move order). */
export async function insertProposal(client: PoolClient, p: NewProposal): Promise<void> {
  await client.query(
    `INSERT INTO redistribution_proposals
       (id, tenant_id, state, created_by, created_at, expires_at, rule_name, rule_version, computed_at, limits, buffer,
        stores, warnings, objective_deficit_before, objective_deficit_after, objective_store_pairs, objective_lines, updated_at)
     VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb,
             $13::numeric(19,4), $14::numeric(19,4), $15, $16, $4)`,
    [
      p.id, p.tenantId, p.createdBy, p.createdAt, p.expiresAt, p.rule.name, p.rule.version, p.computedAt,
      JSON.stringify(p.limits), JSON.stringify(p.buffer), JSON.stringify(p.stores), JSON.stringify(p.warnings),
      p.objective.deficitBefore, p.objective.deficitAfter, p.objective.storePairs, p.objective.lines,
    ],
  );
  const m = p.moves;
  await client.query(
    `INSERT INTO redistribution_proposal_lines
       (id, tenant_id, proposal_id, line_seq, product_id, source_store_id, destination_store_id, quantity, stocking_unit,
        warnings, created_at)
     SELECT l.id, $1, $2, l.seq, l.product_id, l.source_store_id, l.destination_store_id, l.quantity::numeric(19,4),
            l.stocking_unit, l.warnings::jsonb, $3
       FROM unnest($4::uuid[], $5::int[], $6::uuid[], $7::uuid[], $8::uuid[], $9::text[], $10::text[], $11::text[])
         AS l(id, seq, product_id, source_store_id, destination_store_id, quantity, stocking_unit, warnings)`,
    [
      p.tenantId, p.id, p.createdAt,
      m.map(() => newId()), m.map((_, i) => i + 1), m.map((x) => x.productId), m.map((x) => x.sourceStoreId),
      m.map((x) => x.destinationStoreId), m.map((x) => x.quantity), m.map((x) => x.stockingUnit),
      m.map((x) => JSON.stringify(x.warnings.map((code) => ({ code })))),
    ],
  );
}

/** The proposal (locked with `forUpdate`), or null when it does not exist for this tenant (RLS). */
export async function loadProposal(client: PoolClient, id: string, forUpdate: boolean): Promise<ProposalRow | null> {
  const r = await client.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM redistribution_proposals WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return r.rows[0] ?? null;
}

export async function loadLines(client: PoolClient, proposalId: string): Promise<LineRow[]> {
  const r = await client.query<LineRow>(
    `SELECT ${LINE_COLUMNS} FROM redistribution_proposal_lines WHERE proposal_id = $1 ORDER BY line_seq`,
    [proposalId],
  );
  return r.rows;
}

/** Record (or replace) the review decision of each listed line. */
export async function recordReviews(
  client: PoolClient,
  proposalId: string,
  decisions: readonly { readonly lineId: string; readonly decision: string; readonly note: string | null }[],
  actor: { readonly userId: string; readonly at: Date },
): Promise<void> {
  await client.query(
    `UPDATE redistribution_proposal_lines l
        SET review_decision = d.decision, review_note = d.note, reviewed_at = $5, reviewed_by = $6
       FROM unnest($2::uuid[], $3::text[], $4::text[]) AS d(id, decision, note)
      WHERE l.id = d.id AND l.proposal_id = $1`,
    [proposalId, decisions.map((d) => d.lineId), decisions.map((d) => d.decision), decisions.map((d) => d.note), actor.at, actor.userId],
  );
}

/** Record the accept outcome of each decided line, with the draft Transfer it went onto. */
export async function recordOutcomes(
  client: PoolClient,
  proposalId: string,
  outcomes: readonly { readonly decision: AcceptDecision; readonly transferId: string | null }[],
  actor: { readonly userId: string; readonly at: Date },
): Promise<void> {
  await client.query(
    `UPDATE redistribution_proposal_lines l
        SET accept_outcome = o.outcome, accept_created_quantity = o.created::numeric(19,4),
            accept_transfer_id = o.transfer_id, accept_reason = o.reason, accepted_at = $7, accepted_by = $8
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::uuid[], $6::text[]) AS o(id, outcome, created, transfer_id, reason)
      WHERE l.id = o.id AND l.proposal_id = $1`,
    [
      proposalId,
      outcomes.map((o) => o.decision.lineId),
      outcomes.map((o) => o.decision.outcome),
      outcomes.map((o) => o.decision.createdQuantity),
      outcomes.map((o) => o.transferId),
      outcomes.map((o) => o.decision.reason),
      actor.at,
      actor.userId,
    ],
  );
}

/** Move a proposal to `state`; `decidedAt` for a terminal decision, `rejectReason` for a rejection. */
export async function setProposalState(
  client: PoolClient,
  id: string,
  change: { readonly state: string; readonly at: Date; readonly decidedAt: Date | null; readonly rejectReason?: string },
): Promise<void> {
  await client.query(
    `UPDATE redistribution_proposals SET state = $2, decided_at = $3, reject_reason = $4, updated_at = $5 WHERE id = $1`,
    [id, change.state, change.decidedAt, change.rejectReason ?? null, change.at],
  );
}

// ---- The list (keyset, newest first) -------------------------------------------------------------------------------

const CursorSchema = z
  .object({
    o: z.literal('redistribution_proposals'),
    t: z.string().uuid(),
    f: z.string().max(32).nullable(),
    // UTC text with six fractional digits: a JS Date keeps only milliseconds and would repeat or skip rows.
    a: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    b: z.string().uuid(),
  })
  .strict();

function decodeListCursor(token: string, tenantId: string, filter: string | null): { a: string; b: string } {
  const d = decodeOpaque(token, CursorSchema, () => new InvalidCursorError());
  if (d.t !== tenantId.toLowerCase() || d.f !== filter || Number.isNaN(Date.parse(d.a))) throw new InvalidCursorError();
  return { a: d.a, b: d.b };
}

export interface ListPage {
  readonly rows: readonly ProposalRow[];
  readonly nextCursor: string | null;
}

/** One page of the tenant's proposals, newest first, optionally of one REPORTED state at `now`. */
export async function listProposals(
  client: PoolClient,
  q: { readonly tenantId: string; readonly state: string | null; readonly cursor: string | null; readonly limit: number; readonly now: Date },
): Promise<ListPage> {
  const after = q.cursor === null ? null : decodeListCursor(q.cursor, q.tenantId, q.state);
  const r = await client.query<ProposalRow & { sort_key: string }>(
    `SELECT ${PROPOSAL_COLUMNS},
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key
       FROM redistribution_proposals
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR
             (CASE WHEN state = ANY($3::text[]) AND expires_at <= $4 THEN 'expired' ELSE state END) = $2)
        AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $7`,
    [q.tenantId, q.state, LIVE_STATES, q.now, after?.a ?? null, after?.b ?? null, q.limit + 1],
  );
  const rows = r.rows.slice(0, q.limit);
  const last = rows.at(-1);
  const nextCursor =
    r.rows.length > q.limit && last !== undefined
      ? encodeOpaque({ o: 'redistribution_proposals', t: q.tenantId.toLowerCase(), f: q.state, a: last.sort_key, b: last.id })
      : null;
  return { rows, nextCursor };
}

/**
 * The database wall clock at this statement (`clock_timestamp()`), not the transaction start (`now()`): heartbeats
 * are stamped with the database clock, and a command can wait on the tenant lock after its transaction began, so a
 * heartbeat's age is measured when it is read (review, PR #901).
 */
export async function databaseClock(client: PoolClient): Promise<Date> {
  const r = await client.query<{ now: Date }>(`SELECT clock_timestamp() AS now`);
  return r.rows[0]!.now;
}
