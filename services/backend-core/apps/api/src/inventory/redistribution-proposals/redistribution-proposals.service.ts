/**
 * RedistributionProposalsService — Jira RT-1600 (W9 slice A, N3): the runtime of the RT-1599 contract
 * `inventory/redistribution-proposals.yaml`.
 *
 *   - compute: reads the W3 ports (RT-1597: the tenant availability snapshot, open Transfer quantities) and each
 *     store's device freshness, builds the engine's problem, runs the RT-1598 engine and its independent validator, and
 *     stores a `proposed` result with its read times, exclusions and warnings. Every successful compute retires the
 *     tenant's live proposal (superseded, or expired when past its expiry), including one that finds nothing to move.
 *   - review (shadow): records "would accept" / "would reject" per line; creates nothing.
 *   - accept (live): in ONE transaction re-checks each listed line against current state, drops or reduces it, and
 *     creates W3 draft Transfers through `createDraftTransfer` (never approves, dispatches or reserves). Either every
 *     listed line gets its outcome and its Transfers exist, or nothing is written.
 *   - reject: closes the proposal with a reason.
 *
 * Every operation needs tenant-wide store access (a store-scoped owner or tenant_admin gets the non-disclosing 404;
 * `redistribution-scope.ts`). Every command runs in one `runWithTenantContext` transaction under the tenant's proposal
 * advisory lock, so computes and commands of one tenant serialise. Audit actions: `create` on a stored proposal,
 * `supersede` / `expire` on the proposal a compute retires, `review`, `accept`, `reject`. Expiry is computed on read (no sweep): a live proposal past `expiresAt` is
 * reported `expired`, and every command on it is 409 `proposal_expired` before any other 409.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import { newId, type Logger } from '@data-pulse-2/shared';
import type { Pool, PoolClient } from 'pg';

import { readStoreSellableProducts, trackingModesOfProducts } from '../../catalog';
import { ROOT_LOGGER } from '../../common/logging.interceptor';
import { MembershipRepository, callerStoreScope } from '../../context';
import { PG_POOL } from '../../database';
import { readStoreDeviceFacts } from '../../device-health';
import { composeStoreAvailabilityItem } from '../availability/availability.rules';
import { readAvailabilityFactsOfPage } from '../availability/availability.snapshot.query';
import { readTenantAvailabilitySnapshot, type TenantAvailabilitySnapshot } from '../availability/tenant-availability.snapshot';
import { authorizeDestinationStoreAccess } from '../destination-store-access';
import { INVENTORY_STORE_DIRECTORY, type InventoryStoreDirectory } from '../inventory-store-directory.port';
import { readEstablishedUnits } from '../inventory-write.helpers';
import { writeAudit } from '../position-events/position-event.writer';
import { classifyStoreFreshness } from '../redistribution/freshness';
import {
  DEFAULT_BUFFER_POLICY_V1,
  DEFAULT_LIMITS_V1,
  HEARTBEAT_STALE_AFTER_MS,
  PROPOSAL_TTL_MS,
} from '../redistribution/policy';
import { proposeRedistribution } from '../redistribution/propose';
import { parseQty } from '../redistribution/quantity';
import type { BufferPolicyV1, RedistributionResultV1 } from '../redistribution/types';
import { readOpenTransferQuantities } from '../shipment-transfers/open-transfer-quantities';
import {
  readAccess,
  requireStoreAuthority,
  shipmentTransfersEnabled,
  toHttp,
  type TransferCaller,
} from '../shipment-transfers/shipment-transfer.access';
import { createDraftTransfer } from '../shipment-transfers/shipment-transfer.draft';
import { groupIntoTransfers, planAccept, type AcceptDecision, type AcceptFacts, type AcceptLine } from './redistribution-accept.plan';
import { REDISTRIBUTION_ALLOWLIST, isLiveListed, type RedistributionAllowlist } from './redistribution-allowlist.config';
import { buildRedistributionProblem, cellKey, type BuiltProblem, type ProblemReads } from './redistribution-problem';
import { acceptOutcomeOf, proposalBody, proposalSummary } from './redistribution-proposals.projection';
import { hasTenantWideAccess } from './redistribution-scope';
import {
  effectiveState,
  insertProposal,
  listProposals,
  loadLines,
  loadProposal,
  lockTenantProposals,
  recordOutcomes,
  recordReviews,
  retireLiveProposal,
  setProposalState,
  databaseClock,
  type LineRow,
  type ProposalRow,
} from './redistribution-proposals.store';

export type RedistributionCaller = TransferCaller;

type Body = Record<string, unknown>;

const AUDIT_TARGET = 'redistribution_proposal';

// ---- Errors of the RT-1599 envelope --------------------------------------------------------------------------------

const notFound = (): Error => new NotFoundException('Not Found');
const invalid = (message: string): Error => new BadRequestException({ code: 'validation_error', message });
const conflict = (code: string, message: string): Error => new ConflictException({ code, message });
const COMPUTE_REFUSALS: Readonly<Record<string, readonly [string, string]>> = {
  refused_too_large: ['redistribution_too_large', 'Too many stores or rows for one proposal.'],
  deadline_exceeded: ['redistribution_deadline_exceeded', 'The compute took too long.'],
  invalid: ['redistribution_plan_invalid', 'The plan failed validation.'],
};
const refusedCompute = (status: string): Error => {
  const [code, message] = COMPUTE_REFUSALS[status] ?? COMPUTE_REFUSALS['invalid']!;
  return new UnprocessableEntityException({ code, message });
};

/** The 409 of a proposal that no command may change any more, by its REPORTED state; null when it is live. */
function terminalConflict(reported: string): Error | null {
  if (reported === 'expired') return conflict('proposal_expired', 'The proposal has expired.');
  if (reported === 'superseded') return conflict('proposal_superseded', 'The proposal was superseded.');
  if (reported === 'accepted' || reported === 'rejected') return conflict('proposal_state_conflict', 'The proposal is already decided.');
  return null;
}

/** The listed lines of the proposal, in request order; an id not on it, or listed twice, is 400. */
function listedLines(all: readonly LineRow[], ids: readonly string[]): LineRow[] {
  const byId = new Map(all.map((l) => [l.id, l] as const));
  const seen = new Set<string>();
  return ids.map((raw) => {
    const id = raw.toLowerCase();
    const line = byId.get(id);
    if (line === undefined) throw invalid('A line id is not a line of this proposal.');
    if (seen.has(id)) throw invalid('A line id is listed more than once.');
    seen.add(id);
    return line;
  });
}

function assertUndecided(lines: readonly LineRow[]): void {
  if (lines.some((l) => l.accept_outcome !== null)) {
    throw conflict('proposal_line_already_decided', 'A line is already decided.');
  }
}

const toAcceptLine = (l: LineRow): AcceptLine => ({
  id: l.id,
  lineSeq: l.line_seq,
  productId: l.product_id,
  sourceStoreId: l.source_store_id,
  destinationStoreId: l.destination_store_id,
  quantity: l.quantity,
  stockingUnit: l.stocking_unit,
});

/** cellKey -> scaled sum, over rows with a store, a product and a decimal quantity. */
function sumByCell<T extends { storeId: string; productId: string }>(rows: readonly T[], pick: (r: T) => string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const r of rows) {
    const key = cellKey(r.storeId, r.productId);
    out.set(key, (out.get(key) ?? 0n) + (parseQty(pick(r)) ?? 0n));
  }
  return out;
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/** A product with no movement and no reservation (the facts read returns every requested id; this is a fallback). */
const NO_FACTS = { primarySellable: '0.0000', expiredTrackedSellable: '0.0000', activeReserved: '0.0000' } as const;

/** What one compute run logs (`logRun`). */
type ComputeRun = {
  status: string;
  startedMs: number;
  built?: BuiltProblem;
  proposalId?: string;
  lines?: number;
  violations?: readonly string[];
};

@Injectable()
export class RedistributionProposalsService {
  /** The clock (epoch ms). A spec may pin it. */
  clock: () => number = () => Date.now();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly memberships: MembershipRepository,
    @Inject(INVENTORY_STORE_DIRECTORY) private readonly directory: InventoryStoreDirectory,
    @Inject(REDISTRIBUTION_ALLOWLIST) private readonly allowlist: RedistributionAllowlist,
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Logger,
  ) {}

  /**
   * One tenant transaction under the tenant's proposal lock: exclusive for a command, shared for a read. Before any
   * read, the caller's store
   * scope must be tenant-wide (`redistribution-scope.ts`), else the non-disclosing 404. Rule errors map to the envelope.
   */
  private async inTenant<T>(caller: RedistributionCaller, command: boolean, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await runWithTenantContext(this.pool, { tenantId: caller.tenantId, isPlatformAdmin: false }, async (client) => {
        const scope = await callerStoreScope(client, this.memberships, { tenantId: caller.tenantId, context: caller.context });
        if (!hasTenantWideAccess(caller.context, scope)) throw notFound();
        await lockTenantProposals(client, caller.tenantId, command ? 'exclusive' : 'shared');
        return await fn(client);
      });
    } catch (err) {
      throw toHttp(err);
    }
  }

  /** The tenant's phase now: live listed AND W3 shipment transfers activated. */
  private async acceptEnabled(client: PoolClient, tenantId: string): Promise<boolean> {
    return isLiveListed(this.allowlist, tenantId) && (await shipmentTransfersEnabled(client, tenantId));
  }

  private async body(client: PoolClient, caller: RedistributionCaller, id: string, nowMs: number): Promise<Body> {
    const p = await loadProposal(client, id, false);
    if (p === null) throw notFound();
    return proposalBody(p, await loadLines(client, id), nowMs, await this.acceptEnabled(client, caller.tenantId));
  }

  private async audit(client: PoolClient, caller: RedistributionCaller, action: string, targetId: string, metadata: Body): Promise<void> {
    await writeAudit(client, {
      tenantId: caller.tenantId,
      userId: caller.userId,
      action: `inventory.redistribution_proposal.${action}`,
      targetType: AUDIT_TARGET,
      targetId,
      metadata,
    });
  }

  // ---- compute ------------------------------------------------------------------------------------------------------

  async compute(caller: RedistributionCaller, storeIds: readonly string[] | undefined): Promise<{ status: 200 | 201; body: Body }> {
    const startedMs = this.clock();
    // A stored or nothing_to_move result is logged only once its transaction has committed; a refusal logs on its path.
    const { run, ...response } = await this.inTenant(caller, true, async (client) => {
      const now = new Date(this.clock());
      const requested = storeIds === undefined ? undefined : unique(storeIds.map((s) => s.toLowerCase()));
      if (requested !== undefined) await this.assertLiveStores(client, caller.tenantId, requested);
      const limits = DEFAULT_LIMITS_V1;
      const snapshot = await readTenantAvailabilitySnapshot(
        client,
        { tenantId: caller.tenantId, storeIds: requested, limits: { maxStores: limits.maxStores, maxRows: limits.maxRows } },
        { stores: this.directory },
      );
      if (snapshot.kind === 'refused_too_large') {
        this.logRun(caller, { status: 'refused_too_large', startedMs });
        throw refusedCompute('refused_too_large');
      }
      // The snapshot reads live stores only; a scoped store that went away since the check above fails closed (400).
      if (snapshot.excludedStores.length > 0) throw invalid('storeIds must name active stores of the tenant.');
      const built = buildRedistributionProblem(await this.problemReads(client, caller.tenantId, snapshot, now));
      const result = proposeRedistribution(built.problem, { now: this.clock });
      return await this.storeResult(client, caller, now, built, result, startedMs);
    });
    this.logRun(caller, run);
    return response;
  }

  /** A requested store that is not a live store of the tenant is 400, never saying whether it exists elsewhere. */
  private async assertLiveStores(client: PoolClient, tenantId: string, storeIds: readonly string[]): Promise<void> {
    if (storeIds.length < 2) throw invalid('storeIds must name at least two stores.');
    const known = await this.directory.liveAndNamedStores(client, tenantId, storeIds);
    const live = new Set(known.filter((s) => s.live).map((s) => s.id.toLowerCase()));
    if (storeIds.some((id) => !live.has(id))) throw invalid('storeIds must name active stores of the tenant.');
  }

  /** Every read the problem needs, for the stores the snapshot read. */
  private async problemReads(
    client: PoolClient,
    tenantId: string,
    snapshot: Extract<TenantAvailabilitySnapshot, { kind: 'snapshot' }>,
    now: Date,
  ): Promise<ProblemReads> {
    const storeIds = snapshot.stores.map((s) => s.storeId);
    const productIds = unique(snapshot.rows.map((r) => r.productId));
    const exclusions = await this.freshness(client, tenantId, storeIds);
    const stores = snapshot.stores.map((s) => ({ storeId: s.storeId, readAt: s.readAt, exclusion: exclusions.get(s.storeId) ?? null }));
    return {
      tenantId,
      computedAt: now.toISOString(),
      limits: DEFAULT_LIMITS_V1,
      buffer: DEFAULT_BUFFER_POLICY_V1,
      stores,
      rows: snapshot.rows,
      trackingModes: productIds.length === 0 ? new Map() : await trackingModesOfProducts(client, productIds),
      establishedUnits: await this.establishedUnits(client, storeIds, productIds),
      open: await readOpenTransferQuantities(client, { storeIds }),
    };
  }

  /**
   * The freshness gate of each store. The database clock is sampled after every device fact is read, so a heartbeat
   * that ages out while the command waited on the tenant lock, or during the reads, is stale (fails closed).
   */
  private async freshness(
    client: PoolClient,
    tenantId: string,
    storeIds: readonly string[],
  ): Promise<Map<string, ReturnType<typeof classifyStoreFreshness>>> {
    const facts = [];
    for (const storeId of storeIds) facts.push({ storeId, devices: await readStoreDeviceFacts(client, { tenantId, storeId }) });
    const dbNowMs = (await databaseClock(client)).getTime();
    return new Map(facts.map((f) => [f.storeId, classifyStoreFreshness(f.devices, dbNowMs, HEARTBEAT_STALE_AFTER_MS)] as const));
  }

  /**
   * Retire the live proposal and audit it: `supersede` (naming the new proposal, or null for nothing_to_move) or
   * `expire` (past its expiry). Returns the id of the proposal it superseded, or null.
   */
  private async retire(client: PoolClient, caller: RedistributionCaller, now: Date, replacement: string | null): Promise<string | null> {
    const retired = await retireLiveProposal(client, now, replacement);
    if (retired === null) return null;
    if (retired.became === 'expired') {
      await this.audit(client, caller, 'expire', retired.id, {});
      return null;
    }
    await this.audit(client, caller, 'supersede', retired.id, { supersededBy: replacement });
    return retired.id;
  }

  private async establishedUnits(client: PoolClient, storeIds: readonly string[], productIds: readonly string[]): Promise<Map<string, string>> {
    const rows = await readEstablishedUnits(client, storeIds, productIds);
    return new Map(rows.map((r) => [cellKey(r.storeId, r.productId), r.unit] as const));
  }

  /** Store a `proposed` result (201), report `nothing_to_move` (200), or refuse (422, nothing stored or retired). */
  private async storeResult(
    client: PoolClient,
    caller: RedistributionCaller,
    now: Date,
    built: BuiltProblem,
    result: RedistributionResultV1,
    startedMs: number,
  ): Promise<{ status: 200 | 201; body: Body; run: ComputeRun }> {
    const warnings = [...result.warnings, ...built.warnings];
    if (result.status !== 'proposed' && result.status !== 'nothing_to_move') {
      const violations = result.validator?.violations.map((v) => v.code) ?? [];
      this.logRun(caller, { status: result.status, startedMs, built, violations });
      throw refusedCompute(result.status);
    }
    if (result.status === 'nothing_to_move' || result.objective === null) {
      const superseded = await this.retire(client, caller, now, null);
      const body = { result: 'nothing_to_move', supersededProposalId: superseded, rule: result.rule, computedAt: now.toISOString(), stores: built.stores, warnings };
      return { status: 200, body, run: { status: 'nothing_to_move', startedMs, built } };
    }
    const id = newId();
    const superseded = await this.retire(client, caller, now, id);
    await insertProposal(client, {
      id,
      tenantId: caller.tenantId,
      createdBy: caller.userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
      computedAt: now,
      rule: result.rule,
      limits: built.problem.limits,
      buffer: built.problem.buffer ?? DEFAULT_BUFFER_POLICY_V1,
      stores: built.stores,
      warnings,
      objective: result.objective,
      moves: result.moves,
    });
    await this.audit(client, caller, 'create', id, {
      result: 'proposed',
      lineCount: result.moves.length,
      storePairs: result.objective.storePairs,
      supersededProposalId: superseded,
    });
    const run = { status: 'proposed', startedMs, built, proposalId: id, lines: result.moves.length };
    return { status: 201, body: await this.body(client, caller, id, now.getTime()), run };
  }

  /** One structured line per compute run: ids, counts and the outcome only (no PII, no quantities). */
  private logRun(caller: RedistributionCaller, run: ComputeRun): void {
    const stores = run.built?.stores ?? [];
    this.logger?.info(
      {
        action: 'inventory.redistribution_proposal.compute',
        tenant_id: caller.tenantId,
        status: run.status,
        proposal_id: run.proposalId ?? null,
        store_count: stores.length,
        excluded_store_count: stores.filter((s) => s.exclusion !== null).length,
        row_count: run.built?.problem.rows.length ?? 0,
        line_count: run.lines ?? 0,
        violation_codes: run.violations ?? [],
        duration_ms: Math.max(0, this.clock() - run.startedMs),
      },
      'redistribution: compute',
    );
  }

  // ---- reads --------------------------------------------------------------------------------------------------------

  async list(
    caller: RedistributionCaller,
    q: { readonly state: string | null; readonly cursor: string | null; readonly limit: number },
  ): Promise<Body> {
    return await this.inTenant(caller, false, async (client) => {
      const now = new Date(this.clock());
      const page = await listProposals(client, { tenantId: caller.tenantId, ...q, now });
      const enabled = await this.acceptEnabled(client, caller.tenantId);
      return { items: page.rows.map((p) => proposalSummary(p, now.getTime(), enabled)), nextCursor: page.nextCursor };
    });
  }

  async get(caller: RedistributionCaller, id: string): Promise<Body> {
    return await this.inTenant(caller, false, (client) => this.body(client, caller, id, this.clock()));
  }

  // ---- commands -----------------------------------------------------------------------------------------------------

  /** The proposal, locked, if a command may still change it: 404 when unknown, the state's 409 when it is not live. */
  private async commandable(client: PoolClient, id: string, nowMs: number): Promise<ProposalRow> {
    const p = await loadProposal(client, id, true);
    if (p === null) throw notFound();
    const refusal = terminalConflict(effectiveState(p, nowMs));
    if (refusal !== null) throw refusal;
    return p;
  }

  async review(
    caller: RedistributionCaller,
    id: string,
    decisions: readonly { readonly lineId: string; readonly decision: string; readonly note?: string | undefined }[],
  ): Promise<Body> {
    return await this.inTenant(caller, true, async (client) => {
      const now = new Date(this.clock());
      const p = await this.commandable(client, id, now.getTime());
      const lines = listedLines(await loadLines(client, p.id), decisions.map((d) => d.lineId));
      assertUndecided(lines);
      const recorded = decisions.map((d, i) => ({ lineId: lines[i]!.id, decision: d.decision, note: d.note ?? null }));
      await recordReviews(client, p.id, recorded, { userId: caller.userId, at: now });
      if (p.state === 'open') await setProposalState(client, p.id, { state: 'reviewed', at: now, decidedAt: null });
      await this.audit(client, caller, 'review', p.id, {
        lineCount: recorded.length,
        wouldAccept: recorded.filter((d) => d.decision === 'would_accept').length,
        wouldReject: recorded.filter((d) => d.decision === 'would_reject').length,
      });
      return await this.body(client, caller, p.id, now.getTime());
    });
  }

  async reject(caller: RedistributionCaller, id: string, reason: string): Promise<Body> {
    return await this.inTenant(caller, true, async (client) => {
      const now = new Date(this.clock());
      const p = await this.commandable(client, id, now.getTime());
      await setProposalState(client, p.id, { state: 'rejected', at: now, decidedAt: now, rejectReason: reason });
      await this.audit(client, caller, 'reject', p.id, { previousState: p.state });
      return await this.body(client, caller, p.id, now.getTime());
    });
  }

  async accept(caller: RedistributionCaller, id: string, lineIds: readonly string[]): Promise<Body> {
    return await this.inTenant(caller, true, async (client) => {
      const now = new Date(this.clock());
      // The live phase also needs W3 shipment transfers on; otherwise the non-disclosing 404 (RT-1599 PHASES).
      if (!(await shipmentTransfersEnabled(client, caller.tenantId))) throw notFound();
      const p = await this.commandable(client, id, now.getTime());
      const all = await loadLines(client, p.id);
      const listed = listedLines(all, lineIds);
      assertUndecided(listed);
      const facts = await this.acceptFacts(client, caller, listed, p.buffer);
      const decisions = planAccept(listed.map(toAcceptLine), facts);
      if (decisions.every((d) => d.outcome === 'dropped')) {
        throw conflict('proposal_stale', 'The proposal no longer matches current stock.');
      }
      const transferOf = await this.createDrafts(client, caller, p.id, listed, decisions);
      const outcomes = decisions.map((decision) => ({ decision, transferId: transferOf.get(decision.lineId) ?? null }));
      await recordOutcomes(client, p.id, outcomes, { userId: caller.userId, at: now });
      const decided = new Set([...all.filter((l) => l.accept_outcome !== null).map((l) => l.id), ...listed.map((l) => l.id)]);
      const complete = decided.size === all.length;
      await setProposalState(client, p.id, {
        state: complete ? 'accepted' : 'partially_accepted',
        at: now,
        decidedAt: complete ? now : null,
      });
      const transferIds = unique([...transferOf.values()]);
      await this.audit(client, caller, 'accept', p.id, {
        lineCount: decisions.length,
        created: decisions.filter((d) => d.outcome === 'created').length,
        reduced: decisions.filter((d) => d.outcome === 'reduced').length,
        dropped: decisions.filter((d) => d.outcome === 'dropped').length,
        transferIds,
      });
      const after = new Map((await loadLines(client, p.id)).map((l) => [l.id, l] as const));
      return {
        lines: decisions.map((d) => ({ lineId: d.lineId, outcome: acceptOutcomeOf(after.get(d.lineId)!) })),
        transferIds,
        proposal: await this.body(client, caller, p.id, now.getTime()),
      };
    });
  }

  /** The current state every listed line is re-checked against, read in the accept's transaction. */
  private async acceptFacts(
    client: PoolClient,
    caller: RedistributionCaller,
    lines: readonly LineRow[],
    buffer: BufferPolicyV1,
  ): Promise<AcceptFacts> {
    const storeIds = unique(lines.flatMap((l) => [l.source_store_id, l.destination_store_id]));
    const productIds = unique(lines.map((l) => l.product_id));
    const sources = await this.freshness(client, caller.tenantId, unique(lines.map((l) => l.source_store_id)));
    const freshStores = new Set([...sources].filter(([, exclusion]) => exclusion === null).map(([storeId]) => storeId));
    const open = await readOpenTransferQuantities(client, { storeIds });
    const access = await readAccess(client, this.memberships, caller);
    return {
      freshStores,
      rows: await this.currentRows(client, caller.tenantId, lines),
      openOutbound: sumByCell(open, (r) => r.outboundDraft),
      openInbound: sumByCell(open, (r) => r.inbound),
      trackingModes: await trackingModesOfProducts(client, productIds),
      establishedUnits: await this.establishedUnits(client, storeIds, productIds),
      authorized: (source, destination) => {
        try {
          requireStoreAuthority(access, source);
          authorizeDestinationStoreAccess(caller.context, destination);
          return true;
        } catch {
          return false;
        }
      },
      buffer,
    };
  }

  /**
   * The current Available-to-Sell and reorder level of the LISTED products at their stores, and only those: the same
   * sellability rule (`readStoreSellableProducts`), facts (`readAvailabilityFactsOfPage`) and formula
   * (`composeStoreAvailabilityItem`) as the W3 snapshot, so a catalogue past the snapshot's row limit cannot make an
   * accept stale. A store that is no longer live, or a product no longer sellable there, has no row
   * (`product_not_sellable`). `app.current_store` is left as it was found, as the snapshot does.
   */
  private async currentRows(
    client: PoolClient,
    tenantId: string,
    lines: readonly LineRow[],
  ): Promise<Map<string, { readonly availableToSell: string; readonly reorderLevel: string | null }>> {
    const productsAt = new Map<string, Set<string>>();
    for (const l of lines) {
      for (const storeId of [l.source_store_id, l.destination_store_id]) {
        productsAt.set(storeId, (productsAt.get(storeId) ?? new Set<string>()).add(l.product_id));
      }
    }
    const known = await this.directory.liveAndNamedStores(client, tenantId, [...productsAt.keys()]);
    const live = new Set(known.filter((s) => s.live).map((s) => s.id.toLowerCase()));
    const pinned = await client.query<{ store: string | null }>(`SELECT current_setting('app.current_store', true) AS store`);
    const rows = new Map<string, { readonly availableToSell: string; readonly reorderLevel: string | null }>();
    for (const [storeId, ids] of productsAt) {
      if (!live.has(storeId.toLowerCase())) continue;
      const sellable = await readStoreSellableProducts(client, { tenantId, storeId, productIds: [...ids] });
      const facts = await readAvailabilityFactsOfPage(client, { storeId, productIds: sellable.map((p) => p.productId) });
      for (const p of sellable) {
        const item = composeStoreAvailabilityItem(p.productId, facts.byProduct.get(p.productId) ?? NO_FACTS, p.lowStockLevel);
        rows.set(cellKey(storeId, p.productId), { availableToSell: item.availableToSell, reorderLevel: p.lowStockLevel });
      }
    }
    await client.query(`SELECT set_config('app.current_store', $1, true)`, [pinned.rows[0]?.store ?? '']);
    return rows;
  }

  /** One W3 draft Transfer per store pair and 100 lines, in this transaction; line id -> Transfer id. */
  private async createDrafts(
    client: PoolClient,
    caller: RedistributionCaller,
    proposalId: string,
    listed: readonly LineRow[],
    decisions: readonly AcceptDecision[],
  ): Promise<Map<string, string>> {
    const byId = new Map(listed.map((l) => [l.id, toAcceptLine(l)] as const));
    const kept = decisions.flatMap((d) => (d.outcome === 'dropped' ? [] : [{ line: byId.get(d.lineId)!, quantity: d.createdQuantity }]));
    const transferOf = new Map<string, string>();
    for (const group of groupIntoTransfers(kept)) {
      const transfer = await createDraftTransfer(
        client,
        caller,
        {
          sourceStoreId: group.sourceStoreId,
          destinationStoreId: group.destinationStoreId,
          reason: `Redistribution proposal ${proposalId}`,
          lines: group.lines.map((k) => ({
            tenantProductRef: k.line.productId,
            quantity: k.quantity,
            stockingUnit: k.line.stockingUnit,
            trackingIdentityId: null,
          })),
        },
        { memberships: this.memberships },
      );
      for (const k of group.lines) transferOf.set(k.line.id, transfer.id);
    }
    return transferOf;
  }
}
