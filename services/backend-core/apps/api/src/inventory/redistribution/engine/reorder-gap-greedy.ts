/**
 * RT-1598 (W9 N1) — the stage-1 redistribution rule `reorder_gap_greedy` (RT-1596 plan §3.1, §4; P-1, P-9,
 * P-10). Pure: no I/O, no database, no framework; the clock is injected so the deadline can be tested.
 *
 * Per store x product (exact scaled bigints, never `Number`):
 *   buffer  = max(minimum, percent% of reorderLevel), rounded up        (P-10 placeholder, a parameter)
 *   surplus = max(0, ATS - reorderLevel - buffer - openOutboundDraft)    (source stays at or above level + buffer)
 *   deficit = max(0, reorderLevel - ATS - openInbound)
 *
 * Objective, lexicographic: residual deficit, then store pairs, then lines. Order: products by id (then
 * unit); per product, largest deficit first, each served from a store pair already chosen if one has
 * surplus, else from the largest surplus; ties on store id. Deterministic for any input order. A heuristic:
 * no optimality claim beyond objective 1 when no pair line limit binds.
 */
import { DEFAULT_BUFFER_POLICY_V1, SOURCE_FLOOR_INCLUSIVE } from '../policy';
import { QTY_MAX, UNIT, compareIds, formatQty, parseQty } from '../quantity';
import type {
  BufferPolicyV1,
  RedistributionMoveV1,
  RedistributionObjectiveV1,
  RedistributionProblemV1,
  RedistributionStoreV1,
  RedistributionViolationV1,
  RedistributionWarningV1,
} from '../types';
import { checkProblemInput, checkProblemShape } from './problem-check';
import { WarningTally } from './warning-tally';

export interface EngineOptions {
  readonly now?: () => number;
}

export type EnginePlan =
  | { readonly kind: 'refused_too_large' }
  | { readonly kind: 'deadline_exceeded' }
  | { readonly kind: 'input_invalid'; readonly violations: ReadonlyArray<RedistributionViolationV1> }
  | {
      readonly kind: 'planned';
      readonly startedAt: number;
      readonly moves: ReadonlyArray<RedistributionMoveV1>;
      readonly objective: RedistributionObjectiveV1;
      readonly warnings: ReadonlyArray<RedistributionWarningV1>;
    };

/** The clock is read once per product and once every this many allocation steps. */
const DEADLINE_CHECK_EVERY = 1024;

const DEADLINE: EnginePlan = { kind: 'deadline_exceeded' };

/** One eligible row: active store, untracked, with a reorder level. */
interface Cell {
  readonly storeId: string;
  readonly canSource: boolean;
  readonly ats: bigint;
  readonly level: bigint;
  readonly buffer: bigint;
  readonly draft: bigint;
  readonly inbound: bigint;
}

interface Group {
  readonly productId: string;
  readonly unit: string;
  readonly cells: Cell[];
}

interface Source {
  readonly cell: Cell;
  remaining: bigint;
}

interface RawMove {
  readonly group: Group;
  readonly source: Cell;
  readonly destinationStoreId: string;
  readonly quantity: bigint;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** P-10 buffer of a (non-negative) reorder level, rounded up toward protecting the source. `policy` is checked. */
export function bufferOf(level: bigint, policy: BufferPolicyV1): bigint {
  const share = ceilDiv(level * BigInt(policy.percentOfReorderLevel), 100n);
  const minimum = parseQty(policy.minimum)!;
  const buffer = share > minimum ? share : minimum;
  return policy.rounding === 'whole_unit' ? ceilDiv(buffer, UNIT) * UNIT : buffer;
}

function surplusOf(c: Cell): bigint {
  const strictMargin = SOURCE_FLOOR_INCLUSIVE ? 0n : 1n;
  const s = c.ats - c.level - c.buffer - c.draft - strictMargin;
  return s > 0n ? s : 0n;
}

function deficitOf(c: Cell): bigint {
  const d = c.level - c.ats - c.inbound;
  return d > 0n ? d : 0n;
}

function totalDeficit(groups: ReadonlyArray<Group>): bigint {
  let total = 0n;
  for (const g of groups) for (const c of g.cells) total += deficitOf(c);
  return total;
}

const canSource = (s: RedistributionStoreV1): boolean => s.eligibleAsSource && s.exclusion === undefined;

export function planReorderGapGreedy(problem: RedistributionProblemV1, options: EngineOptions = {}): EnginePlan {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const shape = checkProblemShape(problem);
  if (shape.length > 0) return { kind: 'input_invalid', violations: shape };
  if (problem.stores.length > problem.limits.maxStores || problem.rows.length > problem.limits.maxRows) {
    return { kind: 'refused_too_large' };
  }
  const policy = problem.buffer ?? DEFAULT_BUFFER_POLICY_V1;
  const input = checkProblemInput(problem, policy);
  if (input.length > 0) return { kind: 'input_invalid', violations: input };

  const tally = new WarningTally();
  const groups = collectGroups(problem, policy, tally);
  // The objective totals must fit numeric(19,4) like every other Qty (moves always do: each is <= a surplus).
  if (totalDeficit(groups) > QTY_MAX) return { kind: 'refused_too_large' };
  const pastDeadline = (): boolean => now() > startedAt + problem.limits.deadlineMs;
  const allocation = allocate(groups, problem.limits.maxLinesPerTransfer, pastDeadline);
  if (allocation === null) return DEADLINE;
  return { kind: 'planned', startedAt, ...finish(groups, allocation), warnings: tally.list() };
}

/** Groups eligible rows by (product, stocking unit), sorted; skipped rows become counted warnings. */
function collectGroups(problem: RedistributionProblemV1, policy: BufferPolicyV1, tally: WarningTally): Group[] {
  const stores = new Map(problem.stores.map((s) => [s.storeId, s]));
  for (const s of problem.stores) {
    if (canSource(s)) continue;
    const note = { code: 'store_excluded_as_source', storeId: s.storeId } as const;
    tally.note(s.exclusion === undefined ? note : { ...note, detail: s.exclusion });
  }
  const groups = new Map<string, Group>();
  const unitsOf = new Map<string, Set<string>>();
  for (const r of problem.rows) {
    const store = stores.get(r.storeId)!;
    if (store.exclusion === 'inactive') continue;
    if (r.tracked) tally.count('tracked_product_skipped', r.storeId);
    else if (r.reorderLevel === null) tally.count('reorder_level_missing', r.storeId);
    else {
      const ats = parseQty(r.availableToSell)!;
      if (ats < 0n) tally.count('negative_available_to_sell', r.storeId);
      const level = parseQty(r.reorderLevel)!;
      const key = `${r.productId}\u0000${r.stockingUnit}`;
      const group = groups.get(key) ?? { productId: r.productId, unit: r.stockingUnit, cells: [] };
      groups.set(key, group);
      group.cells.push({
        storeId: r.storeId,
        canSource: canSource(store),
        ats,
        level,
        buffer: bufferOf(level, policy),
        draft: parseQty(r.openOutboundDraft)!,
        inbound: parseQty(r.openInbound)!,
      });
      unitsOf.set(r.productId, (unitsOf.get(r.productId) ?? new Set()).add(r.stockingUnit));
    }
  }
  for (const [productId, units] of unitsOf) {
    if (units.size > 1) tally.note({ code: 'stocking_unit_mismatch', productId });
  }
  return [...groups.values()].sort((a, b) => compareIds(a.productId, b.productId) || compareIds(a.unit, b.unit));
}

interface Allocation {
  readonly moves: RawMove[];
  readonly pairLines: Map<string, number>;
}

const pairKey = (source: string, destination: string): string => `${source}\u0000${destination}`;

/** The greedy itself; `null` when the deadline passed (never a partial result). */
function allocate(groups: Group[], maxLines: number, pastDeadline: () => boolean): Allocation | null {
  const pairLines = new Map<string, number>();
  const moves: RawMove[] = [];
  let steps = 0;
  for (const group of groups) {
    if (pastDeadline()) return null;
    const sources: Source[] = group.cells
      .filter((c) => c.canSource && surplusOf(c) > 0n)
      .sort((a, b) => compareIds(a.storeId, b.storeId))
      .map((cell) => ({ cell, remaining: surplusOf(cell) }));
    const destinations = group.cells
      .filter((c) => deficitOf(c) > 0n)
      .sort((a, b) => compareBigDesc(deficitOf(a), deficitOf(b)) || compareIds(a.storeId, b.storeId));
    for (const destination of destinations) {
      let need = deficitOf(destination);
      while (need > 0n) {
        steps += 1;
        if (steps % DEADLINE_CHECK_EVERY === 0 && pastDeadline()) return null;
        const source = pickSource(sources, destination.storeId, pairLines, maxLines);
        if (source === null) break;
        const quantity = need < source.remaining ? need : source.remaining;
        source.remaining -= quantity;
        need -= quantity;
        const key = pairKey(source.cell.storeId, destination.storeId);
        pairLines.set(key, (pairLines.get(key) ?? 0) + 1);
        moves.push({ group, source: source.cell, destinationStoreId: destination.storeId, quantity });
      }
    }
  }
  return { moves, pairLines };
}

const compareBigDesc = (a: bigint, b: bigint): number => (a > b ? -1 : a < b ? 1 : 0);

/** A pair already chosen first (fewer pairs), then the largest surplus (fewer lines), then the lower store id. */
function pickSource(
  sources: ReadonlyArray<Source>,
  destinationStoreId: string,
  pairLines: ReadonlyMap<string, number>,
  maxLines: number,
): Source | null {
  let best: Source | null = null;
  let bestPaired = false;
  for (const s of sources) {
    if (s.remaining === 0n) continue;
    const lines = pairLines.get(pairKey(s.cell.storeId, destinationStoreId)) ?? 0;
    if (lines >= maxLines) continue;
    const paired = lines > 0;
    if (best === null || isBetter(s, paired, best, bestPaired)) {
      best = s;
      bestPaired = paired;
    }
  }
  return best;
}

function isBetter(a: Source, aPaired: boolean, b: Source, bPaired: boolean): boolean {
  if (aPaired !== bPaired) return aPaired;
  if (a.remaining !== b.remaining) return a.remaining > b.remaining;
  return a.cell.storeId < b.cell.storeId;
}

/** Formats the moves (sorted), attaches the near-reorder-level warning and computes the objective. */
function finish(
  groups: ReadonlyArray<Group>,
  allocation: Allocation,
): { moves: RedistributionMoveV1[]; objective: RedistributionObjectiveV1 } {
  const movedOut = new Map<Cell, bigint>();
  let moved = 0n;
  for (const m of allocation.moves) {
    movedOut.set(m.source, (movedOut.get(m.source) ?? 0n) + m.quantity);
    moved += m.quantity;
  }
  const deficitBefore = totalDeficit(groups);
  const moves = allocation.moves
    .map((m): RedistributionMoveV1 => {
      const end = m.source.ats - m.source.draft - movedOut.get(m.source)!;
      const near = end <= m.source.level + 2n * m.source.buffer;
      return {
        productId: m.group.productId,
        sourceStoreId: m.source.storeId,
        destinationStoreId: m.destinationStoreId,
        quantity: formatQty(m.quantity),
        stockingUnit: m.group.unit,
        warnings: near ? ['source_near_reorder_level'] : [],
      };
    })
    .sort(
      (a, b) =>
        compareIds(a.productId, b.productId) ||
        compareIds(a.sourceStoreId, b.sourceStoreId) ||
        compareIds(a.destinationStoreId, b.destinationStoreId),
    );
  const objective = {
    deficitBefore: formatQty(deficitBefore),
    deficitAfter: formatQty(deficitBefore - moved),
    storePairs: allocation.pairLines.size,
    lines: moves.length,
  };
  return { moves, objective };
}
