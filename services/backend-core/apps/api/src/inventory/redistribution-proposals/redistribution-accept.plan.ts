/**
 * RT-1600 — the accept re-check of each listed line, and the grouping of the kept lines into W3 draft Transfers
 * (RT-1599 `acceptRedistributionProposal`). Pure: the service reads the current state in the accept's transaction and
 * passes it here.
 *
 * Per line, in line order, the first refusal drops it with its reason:
 *   1. the source store is no longer fresh                                    -> `source_not_fresh`;
 *   2. the product is no longer sellable at the source or the destination     -> `product_not_sellable`;
 *   3. the product is tracked now (or its mode is unknown): the W3 create
 *      command needs a tracking identity per line, which a proposal has none of -> `transfer_rule_refused`;
 *   4. the unit established at either store differs from the line's           -> `stocking_unit_changed`;
 *   5. the caller has no W3 authority over the source or the destination      -> `transfer_rule_refused`.
 * Then the quantity: the line gets at most the source's surplus (ATS - reorder level - buffer - open outbound drafts,
 * the engine's own floor) and at most the destination's gap (reorder level - ATS - open inbound), each net of what the
 * earlier lines of this accept already took. A store with no reorder level has neither a surplus nor a gap. All of it
 * is `created`; part of it is `reduced` with the reason of the binding side; none of it is `dropped` with that reason.
 * A quantity above what one ERP Stock Entry row carries (13 integer digits) is `transfer_rule_refused`.
 */
import { bufferOf } from '../redistribution/engine/reorder-gap-greedy';
import { TRANSFER_LINE_MAX } from '../redistribution/policy';
import { UNIT, formatQty, parseQty } from '../redistribution/quantity';
import type { BufferPolicyV1 } from '../redistribution/types';
import { cellKey } from './redistribution-problem';

/** The largest scaled quantity an ERP Stock Entry row carries (13 integer digits; W3 `assertErpQuantity`). */
const ERP_QUANTITY_LIMIT = 10n ** 13n * UNIT;

export interface AcceptLine {
  readonly id: string;
  readonly lineSeq: number;
  readonly productId: string;
  readonly sourceStoreId: string;
  readonly destinationStoreId: string;
  readonly quantity: string;
  readonly stockingUnit: string;
}

export interface AcceptFacts {
  /** Source stores that pass the freshness gate now. */
  readonly freshStores: ReadonlySet<string>;
  /** cellKey -> the store's current row (present only where the product is sellable at a live store). */
  readonly rows: ReadonlyMap<string, { readonly availableToSell: string; readonly reorderLevel: string | null }>;
  /** cellKey -> open outbound draft quantity (scaled), every unit. */
  readonly openOutbound: ReadonlyMap<string, bigint>;
  /** cellKey -> open inbound quantity (scaled), every unit. */
  readonly openInbound: ReadonlyMap<string, bigint>;
  /** productId -> tracking mode. */
  readonly trackingModes: ReadonlyMap<string, string>;
  /** cellKey -> established stocking unit. */
  readonly establishedUnits: ReadonlyMap<string, string>;
  /** Whether the caller may create a W3 Transfer between these two stores. */
  readonly authorized: (sourceStoreId: string, destinationStoreId: string) => boolean;
  readonly buffer: BufferPolicyV1;
}

export type AcceptDecision =
  | { readonly lineId: string; readonly outcome: 'created'; readonly createdQuantity: string; readonly reason: null }
  | { readonly lineId: string; readonly outcome: 'reduced'; readonly createdQuantity: string; readonly reason: string }
  | { readonly lineId: string; readonly outcome: 'dropped'; readonly createdQuantity: null; readonly reason: string };

const dropped = (lineId: string, reason: string): AcceptDecision => ({ lineId, outcome: 'dropped', createdQuantity: null, reason });

/** The first rule that refuses the line outright (checks 1 to 5), or null. */
function refusalOf(line: AcceptLine, facts: AcceptFacts): string | null {
  if (!facts.freshStores.has(line.sourceStoreId)) return 'source_not_fresh';
  const source = cellKey(line.sourceStoreId, line.productId);
  const destination = cellKey(line.destinationStoreId, line.productId);
  if (!facts.rows.has(source) || !facts.rows.has(destination)) return 'product_not_sellable';
  if (facts.trackingModes.get(line.productId) !== 'none') return 'transfer_rule_refused';
  for (const key of [source, destination]) {
    const unit = facts.establishedUnits.get(key);
    if (unit !== undefined && unit !== line.stockingUnit) return 'stocking_unit_changed';
  }
  if (!facts.authorized(line.sourceStoreId, line.destinationStoreId)) return 'transfer_rule_refused';
  return null;
}

/** What a store can still give (source) or still needs (destination), net of this accept's earlier lines. */
class Budget {
  private readonly used = new Map<string, bigint>();

  constructor(private readonly facts: AcceptFacts) {}

  surplus(key: string): bigint {
    const row = this.facts.rows.get(key)!;
    const level = row.reorderLevel === null ? null : parseQty(row.reorderLevel);
    const ats = parseQty(row.availableToSell);
    if (level === null || ats === null) return 0n;
    const s = ats - level - bufferOf(level, this.facts.buffer) - (this.facts.openOutbound.get(key) ?? 0n) - this.taken(key);
    return s > 0n ? s : 0n;
  }

  gap(key: string): bigint {
    const row = this.facts.rows.get(key)!;
    const level = row.reorderLevel === null ? null : parseQty(row.reorderLevel);
    const ats = parseQty(row.availableToSell);
    if (level === null || ats === null) return 0n;
    const g = level - ats - (this.facts.openInbound.get(key) ?? 0n) - this.taken(key);
    return g > 0n ? g : 0n;
  }

  take(key: string, quantity: bigint): void {
    this.used.set(key, this.taken(key) + quantity);
  }

  private taken(key: string): bigint {
    return this.used.get(key) ?? 0n;
  }
}

function decide(line: AcceptLine, facts: AcceptFacts, budget: Budget): AcceptDecision {
  const refusal = refusalOf(line, facts);
  if (refusal !== null) return dropped(line.id, refusal);
  const proposed = parseQty(line.quantity)!;
  const source = cellKey(line.sourceStoreId, line.productId);
  const destination = cellKey(line.destinationStoreId, line.productId);
  const surplus = budget.surplus(source);
  const gap = budget.gap(destination);
  const quantity = [proposed, surplus, gap].reduce((a, b) => (b < a ? b : a));
  const reason = surplus <= gap ? 'source_available_insufficient' : 'destination_gap_closed';
  if (quantity <= 0n) return dropped(line.id, reason);
  if (quantity >= ERP_QUANTITY_LIMIT) return dropped(line.id, 'transfer_rule_refused');
  budget.take(source, quantity);
  budget.take(destination, quantity);
  if (quantity === proposed) return { lineId: line.id, outcome: 'created', createdQuantity: formatQty(quantity), reason: null };
  return { lineId: line.id, outcome: 'reduced', createdQuantity: formatQty(quantity), reason };
}

/** One decision per listed line, in line order. */
export function planAccept(lines: readonly AcceptLine[], facts: AcceptFacts): AcceptDecision[] {
  const budget = new Budget(facts);
  return [...lines].sort((a, b) => a.lineSeq - b.lineSeq).map((line) => decide(line, facts, budget));
}

/** One W3 draft Transfer to create: a store pair and at most `TRANSFER_LINE_MAX` lines, each product once. */
export interface TransferGroup {
  readonly sourceStoreId: string;
  readonly destinationStoreId: string;
  readonly lines: readonly { readonly line: AcceptLine; readonly quantity: string }[];
}

/**
 * The kept lines grouped by (source, destination), in line order, split into Transfers of at most
 * `TRANSFER_LINE_MAX` lines; a product already on the current Transfer of a pair starts a new one (W3 allows each
 * product once per Transfer).
 */
export function groupIntoTransfers(
  kept: readonly { readonly line: AcceptLine; readonly quantity: string }[],
  maxLines: number = TRANSFER_LINE_MAX,
): TransferGroup[] {
  const ordered = [...kept].sort(
    (a, b) =>
      cmp(a.line.sourceStoreId, b.line.sourceStoreId) ||
      cmp(a.line.destinationStoreId, b.line.destinationStoreId) ||
      a.line.lineSeq - b.line.lineSeq,
  );
  const groups: { sourceStoreId: string; destinationStoreId: string; lines: TransferGroup['lines'][number][]; products: Set<string> }[] = [];
  for (const k of ordered) {
    const last = groups.at(-1);
    const samePair = last !== undefined && last.sourceStoreId === k.line.sourceStoreId && last.destinationStoreId === k.line.destinationStoreId;
    if (samePair && last.lines.length < maxLines && !last.products.has(k.line.productId)) {
      last.lines.push(k);
      last.products.add(k.line.productId);
    } else {
      groups.push({ sourceStoreId: k.line.sourceStoreId, destinationStoreId: k.line.destinationStoreId, lines: [k], products: new Set([k.line.productId]) });
    }
  }
  return groups.map(({ sourceStoreId, destinationStoreId, lines }) => ({ sourceStoreId, destinationStoreId, lines }));
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
