/**
 * RT-1598 (W9 N1) — the independent validator of a redistribution plan (RT-1596 plan §4, P-10).
 *
 * A separate code path: it never imports the engine. It re-reads the raw rows and recomputes the buffer, the
 * source floor and every deficit itself, then checks each line and the plan as a whole:
 *   - no source ends below reorderLevel + buffer once its open drafts are counted;
 *   - no excluded source, no inactive destination, no self-move, no unknown or foreign-tenant store;
 *   - the product is sellable (has a row) at both stores, untracked, with a level, in the line's stocking unit;
 *   - quantity > 0; one line per (product, source, destination); at most the line limit per transfer;
 *   - no destination receives more than its deficit; a store is not both source and destination of a product;
 *   - the residual deficit is at most the deficit before.
 * Pure: no I/O, no clock, never throws.
 */
import { DEFAULT_BUFFER_POLICY_V1, SOURCE_FLOOR_INCLUSIVE, TRANSFER_LINE_MAX } from '../policy';
import { UNIT, formatQty, parseQty } from '../quantity';
import type {
  BufferPolicyV1,
  Qty,
  RedistributionProblemV1,
  RedistributionRowV1,
  RedistributionStoreV1,
  RedistributionViolationV1,
} from '../types';

export interface RedistributionValidationReportV1 {
  readonly passed: boolean;
  readonly violations: ReadonlyArray<RedistributionViolationV1>;
  readonly deficitBefore: Qty;
  readonly deficitAfter: Qty;
}

/** The part of a move the validator reads. */
export interface PlannedLine {
  readonly productId: string;
  readonly sourceStoreId: string;
  readonly destinationStoreId: string;
  readonly quantity: Qty;
  readonly stockingUnit: string;
}

/** A raw row read on the validator's own path; `values` is null when any quantity is malformed. */
interface ReadRow {
  readonly raw: RedistributionRowV1;
  readonly values: { ats: bigint; level: bigint | null; draft: bigint; inbound: bigint } | null;
}

interface Ledger {
  readonly tenantId: string;
  readonly stores: Map<string, RedistributionStoreV1>;
  readonly rows: Map<string, ReadRow>;
  readonly out: Map<string, bigint>;
  readonly into: Map<string, bigint>;
  readonly violations: RedistributionViolationV1[];
}

const keyOf = (storeId: string, productId: string): string => `${storeId}\u0000${productId}`;
const add = (m: Map<string, bigint>, k: string, q: bigint): void => {
  m.set(k, (m.get(k) ?? 0n) + q);
};

export function validateRedistributionPlan(
  problem: RedistributionProblemV1,
  lines: ReadonlyArray<PlannedLine>,
): RedistributionValidationReportV1 {
  const ledger: Ledger = {
    tenantId: problem.tenantId,
    stores: new Map(),
    rows: new Map(),
    out: new Map(),
    into: new Map(),
    violations: [],
  };
  indexInput(ledger, problem);
  checkLines(ledger, lines);
  checkTransferSizes(ledger, lines, lineLimitOf(problem));
  const policy = problem.buffer ?? DEFAULT_BUFFER_POLICY_V1;
  const buffer = bufferFunction(policy);
  if (buffer === null) ledger.violations.push({ code: 'input_invalid_buffer_policy' });
  else checkSourceFloors(ledger, buffer);
  checkDestinations(ledger);
  const { before, after } = deficits(ledger);
  if (after > before) {
    ledger.violations.push({ code: 'deficit_increased', detail: `${formatQty(before)} -> ${formatQty(after)}` });
  }
  return {
    passed: ledger.violations.length === 0,
    violations: ledger.violations,
    deficitBefore: formatQty(before),
    deficitAfter: formatQty(after),
  };
}

/**
 * Indexes stores and rows on the validator's own path. A duplicate store, a duplicate (store, product) row or a
 * row of an unknown store is a violation: the validator never lets a later entry silently replace an earlier one
 * (an excluded store re-listed as eligible, or a short row re-listed as long).
 */
function indexInput(ledger: Ledger, problem: RedistributionProblemV1): void {
  const { stores, rows } = ledger;
  for (const s of problem.stores) {
    if (stores.has(s.storeId)) ledger.violations.push({ code: 'input_duplicate_store', storeId: s.storeId });
    else stores.set(s.storeId, s);
  }
  for (const r of problem.rows) {
    const at = { storeId: r.storeId, productId: r.productId };
    if (!stores.has(r.storeId)) ledger.violations.push({ code: 'input_unknown_store', ...at });
    const key = keyOf(r.storeId, r.productId);
    if (rows.has(key)) ledger.violations.push({ code: 'input_duplicate_row', ...at });
    else rows.set(key, readRow(r));
  }
}

function readRow(raw: RedistributionRowV1): ReadRow {
  const ats = parseQty(raw.availableToSell);
  const level = raw.reorderLevel === null ? null : parseQty(raw.reorderLevel);
  const draft = parseQty(raw.openOutboundDraft);
  const inbound = parseQty(raw.openInbound);
  const malformed =
    ats === null ||
    (raw.reorderLevel !== null && (level === null || level < 0n)) ||
    draft === null ||
    draft < 0n ||
    inbound === null ||
    inbound < 0n;
  return { raw, values: malformed ? null : { ats, level, draft, inbound } };
}

/** The problem's line limit, never above the W3 limit; the W3 limit when the problem's is unusable. */
function lineLimitOf(problem: RedistributionProblemV1): number {
  const n = problem.limits.maxLinesPerTransfer;
  return Number.isInteger(n) && n > 0 && n < TRANSFER_LINE_MAX ? n : TRANSFER_LINE_MAX;
}

function checkLines(ledger: Ledger, lines: ReadonlyArray<PlannedLine>): void {
  const seen = new Set<string>();
  for (const line of lines) {
    const at = { productId: line.productId, sourceStoreId: line.sourceStoreId, destinationStoreId: line.destinationStoreId };
    const flag = (code: RedistributionViolationV1['code'], detail?: string): void => {
      ledger.violations.push(detail === undefined ? { code, ...at } : { code, ...at, detail });
    };
    const quantity = parseQty(line.quantity);
    if (quantity === null) flag('malformed_quantity', line.quantity);
    else if (quantity <= 0n) flag('non_positive_quantity', line.quantity);
    if (line.sourceStoreId === line.destinationStoreId) flag('self_move');
    checkStores(ledger, line, flag);
    checkRow(ledger, line, 'source', flag);
    checkRow(ledger, line, 'destination', flag);
    const lineKey = `${line.productId}\u0000${line.sourceStoreId}\u0000${line.destinationStoreId}`;
    if (seen.has(lineKey)) flag('duplicate_line');
    seen.add(lineKey);
    if (quantity !== null) {
      add(ledger.out, keyOf(line.sourceStoreId, line.productId), quantity);
      add(ledger.into, keyOf(line.destinationStoreId, line.productId), quantity);
    }
  }
}

type Flag = (code: RedistributionViolationV1['code'], detail?: string) => void;

function checkStores(ledger: Ledger, line: PlannedLine, flag: Flag): void {
  for (const [role, id] of [
    ['source', line.sourceStoreId],
    ['destination', line.destinationStoreId],
  ] as const) {
    const store = ledger.stores.get(id);
    if (store === undefined) {
      flag('unknown_store', id);
      continue;
    }
    if (store.tenantId !== ledger.tenantId) flag('tenant_mismatch', id);
    if (role === 'source' && (store.eligibleAsSource !== true || store.exclusion !== undefined)) {
      flag('excluded_source', store.exclusion);
    }
    if (role === 'destination' && store.exclusion === 'inactive') flag('inactive_destination');
  }
}

function checkRow(ledger: Ledger, line: PlannedLine, role: 'source' | 'destination', flag: Flag): void {
  const storeId = role === 'source' ? line.sourceStoreId : line.destinationStoreId;
  const row = ledger.rows.get(keyOf(storeId, line.productId));
  if (row === undefined) {
    flag(role === 'source' ? 'not_sellable_at_source' : 'not_sellable_at_destination');
    return;
  }
  if (row.values === null) flag('input_malformed_quantity', role);
  if (row.raw.tracked) flag('tracked_product', role);
  if (row.raw.reorderLevel === null) flag('reorder_level_missing', role);
  if (row.raw.stockingUnit !== line.stockingUnit) flag('stocking_unit_mismatch', `${role}: ${row.raw.stockingUnit}`);
}

function checkTransferSizes(ledger: Ledger, lines: ReadonlyArray<PlannedLine>, limit: number): void {
  const perPair = new Map<string, { source: string; destination: string; n: number }>();
  for (const l of lines) {
    const k = `${l.sourceStoreId}\u0000${l.destinationStoreId}`;
    const entry = perPair.get(k) ?? { source: l.sourceStoreId, destination: l.destinationStoreId, n: 0 };
    entry.n += 1;
    perPair.set(k, entry);
  }
  for (const p of perPair.values()) {
    if (p.n > limit) {
      ledger.violations.push({
        code: 'transfer_too_many_lines',
        sourceStoreId: p.source,
        destinationStoreId: p.destination,
        detail: `${String(p.n)} > ${String(limit)}`,
      });
    }
  }
}

/** The validator's own buffer: max(minimum, percent% of level) rounded up; null for an unusable policy. */
function bufferFunction(policy: BufferPolicyV1): ((level: bigint) => bigint) | null {
  const minimum = parseQty(policy.minimum);
  const percent = policy.percentOfReorderLevel;
  const usable =
    minimum !== null && minimum >= 0n && Number.isInteger(percent) && percent >= 0 && percent <= 100;
  if (!usable || (policy.rounding !== 'scale' && policy.rounding !== 'whole_unit')) return null;
  return (level) => {
    const product = level * BigInt(percent);
    const share = product % 100n === 0n ? product / 100n : product / 100n + 1n;
    const raw = share < minimum ? minimum : share;
    if (policy.rounding === 'scale' || raw % UNIT === 0n) return raw;
    return (raw / UNIT + 1n) * UNIT;
  };
}

/** Every source must end at or above reorderLevel + buffer after its open drafts and this plan's lines. */
function checkSourceFloors(ledger: Ledger, buffer: (level: bigint) => bigint): void {
  for (const [key, moved] of ledger.out) {
    const row = ledger.rows.get(key);
    if (row === undefined || row.values === null || row.values.level === null) continue; // already flagged per line
    const floor = row.values.level + buffer(row.values.level);
    const end = row.values.ats - row.values.draft - moved;
    const breached = SOURCE_FLOOR_INCLUSIVE ? end < floor : end <= floor;
    if (breached) {
      ledger.violations.push({
        code: 'source_floor_breached',
        storeId: row.raw.storeId,
        productId: row.raw.productId,
        detail: `ends ${formatQty(end)}, floor ${formatQty(floor)}`,
      });
    }
    if (ledger.into.has(key)) {
      ledger.violations.push({
        code: 'store_both_source_and_destination',
        storeId: row.raw.storeId,
        productId: row.raw.productId,
      });
    }
  }
}

/** No destination receives more than its own deficit (that would only move the shortage elsewhere). */
function checkDestinations(ledger: Ledger): void {
  for (const [key, received] of ledger.into) {
    const row = ledger.rows.get(key);
    if (row === undefined || row.values === null || row.values.level === null) continue;
    const gap = row.values.level - row.values.ats - row.values.inbound;
    const deficit = gap > 0n ? gap : 0n;
    if (received > deficit) {
      ledger.violations.push({
        code: 'destination_overfilled',
        storeId: row.raw.storeId,
        productId: row.raw.productId,
        detail: `${formatQty(received)} > ${formatQty(deficit)}`,
      });
    }
  }
}

/** Deficit before and after over every countable row: own tenant, active store, untracked, with a level. */
function deficits(ledger: Ledger): { before: bigint; after: bigint } {
  let before = 0n;
  let after = 0n;
  for (const [key, row] of ledger.rows) {
    const store = ledger.stores.get(row.raw.storeId);
    const countable =
      store !== undefined && store.tenantId === ledger.tenantId && store.exclusion !== 'inactive' && !row.raw.tracked;
    if (!countable || row.values === null || row.values.level === null) continue;
    const gap = row.values.level - row.values.ats - row.values.inbound;
    before += gap > 0n ? gap : 0n;
    const gapAfter = gap - (ledger.into.get(key) ?? 0n);
    after += gapAfter > 0n ? gapAfter : 0n;
  }
  return { before, after };
}
