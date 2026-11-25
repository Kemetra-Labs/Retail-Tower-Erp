/**
 * RT-1600 — build the engine's `RedistributionProblemV1` from the W3 reads (RT-1597 ports) and the freshness gate.
 * Pure: the service does the reads; this file only joins them, so the join is unit-tested without a database.
 *
 * What the snapshot does not carry (RT-1598 README, "What the runtime must supply"):
 *   - `tracked`: from the product's tracking mode. A product whose mode is unknown is treated as TRACKED (skipped by the
 *     engine and counted), never defaulted to untracked.
 *   - `stockingUnit`: the unit established at that store (its first stock movement, the W3 rule), else the one unit the
 *     product has everywhere else (other stores' established units and open Transfer lines). An untracked row whose
 *     unit cannot be resolved to exactly one is skipped and counted (`stocking_unit_mismatch`, detail
 *     `stocking_unit_unresolved`): the engine would otherwise guess a unit.
 *   - `openOutboundDraft` / `openInbound`: the open Transfer quantities of the store and product, summed across units.
 *     Over-counting both only shrinks a surplus and a deficit, so a unit mix-up can never propose more.
 */
import { parseQty, formatQty } from '../redistribution/quantity';
import type { SourceExclusion } from '../redistribution/freshness';
import type {
  BufferPolicyV1,
  RedistributionLimitsV1,
  RedistributionProblemV1,
  RedistributionRowV1,
  RedistributionStoreV1,
  RedistributionWarningV1,
} from '../redistribution/types';

/** The key of one store x product. */
export const cellKey = (storeId: string, productId: string): string => `${storeId.toLowerCase()}\u0000${productId.toLowerCase()}`;

/** One store as the proposal reports it (contract `RedistributionProposalStore`). */
export interface ProposalStore {
  readonly storeId: string;
  readonly readAt: string;
  readonly eligibleAsSource: boolean;
  readonly exclusion: SourceExclusion | null;
}

interface OpenQuantity {
  readonly storeId: string;
  readonly productId: string;
  readonly stockingUnit: string;
  readonly outboundDraft: string;
  readonly inbound: string;
}

export interface ProblemReads {
  readonly tenantId: string;
  readonly computedAt: string;
  readonly limits: RedistributionLimitsV1;
  readonly buffer: BufferPolicyV1;
  /** The stores the snapshot read, with their read time and the freshness gate's verdict. */
  readonly stores: readonly { readonly storeId: string; readonly readAt: string; readonly exclusion: SourceExclusion | null }[];
  /** Requested stores the snapshot found not live: neither source nor destination. */
  readonly inactiveStoreIds: readonly string[];
  readonly rows: readonly {
    readonly storeId: string;
    readonly productId: string;
    readonly availableToSell: string;
    readonly reorderLevel: string | null;
  }[];
  /** productId (lower case, as Postgres prints a uuid) -> tracking mode (`none`, `batch`, `serial`). */
  readonly trackingModes: ReadonlyMap<string, string>;
  /** cellKey -> the stocking unit of the store's first movement of the product. */
  readonly establishedUnits: ReadonlyMap<string, string>;
  readonly open: readonly OpenQuantity[];
}

export interface BuiltProblem {
  readonly problem: RedistributionProblemV1;
  readonly stores: readonly ProposalStore[];
  /** Warnings of the join itself (rows skipped before the engine), to append to the engine's. */
  readonly warnings: readonly RedistributionWarningV1[];
}

/** Sum of the open quantities per store x product, across units. */
function openTotals(open: readonly OpenQuantity[]): Map<string, { outbound: bigint; inbound: bigint }> {
  const totals = new Map<string, { outbound: bigint; inbound: bigint }>();
  for (const o of open) {
    const key = cellKey(o.storeId, o.productId);
    const t = totals.get(key) ?? { outbound: 0n, inbound: 0n };
    t.outbound += parseQty(o.outboundDraft) ?? 0n;
    t.inbound += parseQty(o.inbound) ?? 0n;
    totals.set(key, t);
  }
  return totals;
}

/** productId -> every unit seen for the product (established anywhere, or on an open Transfer line). */
function productUnits(reads: ProblemReads): Map<string, Set<string>> {
  const units = new Map<string, Set<string>>();
  const add = (productId: string, unit: string): void => {
    const id = productId.toLowerCase();
    units.set(id, (units.get(id) ?? new Set<string>()).add(unit));
  };
  for (const [key, unit] of reads.establishedUnits) add(key.split('\u0000')[1]!, unit);
  for (const o of reads.open) add(o.productId, o.stockingUnit);
  return units;
}

function proposalStores(reads: ProblemReads): ProposalStore[] {
  const read = reads.stores.map((s) => ({
    storeId: s.storeId,
    readAt: s.readAt,
    eligibleAsSource: s.exclusion === null,
    exclusion: s.exclusion,
  }));
  const inactive = reads.inactiveStoreIds.map((storeId) => ({
    storeId,
    readAt: reads.computedAt,
    eligibleAsSource: false,
    exclusion: 'inactive' as const,
  }));
  return [...read, ...inactive];
}

export function buildRedistributionProblem(reads: ProblemReads): BuiltProblem {
  const totals = openTotals(reads.open);
  const units = productUnits(reads);
  const unresolved = new Map<string, number>();
  const rows: RedistributionRowV1[] = [];
  for (const r of reads.rows) {
    // Unknown mode (product not found) is tracked: never default to untracked.
    const tracked = reads.trackingModes.get(r.productId) !== 'none';
    const candidates = units.get(r.productId.toLowerCase());
    const unit =
      reads.establishedUnits.get(cellKey(r.storeId, r.productId)) ??
      (candidates !== undefined && candidates.size === 1 ? [...candidates][0]! : null);
    if (unit === null && !tracked) {
      unresolved.set(r.productId, (unresolved.get(r.productId) ?? 0) + 1);
      continue;
    }
    const open = totals.get(cellKey(r.storeId, r.productId));
    rows.push({
      storeId: r.storeId,
      productId: r.productId,
      stockingUnit: unit ?? '',
      tracked,
      availableToSell: r.availableToSell,
      reorderLevel: r.reorderLevel,
      openOutboundDraft: formatQty(open?.outbound ?? 0n),
      openInbound: formatQty(open?.inbound ?? 0n),
    });
  }
  const stores = proposalStores(reads);
  const engineStores: RedistributionStoreV1[] = stores.map((s) => ({
    storeId: s.storeId,
    tenantId: reads.tenantId,
    readAt: s.readAt,
    eligibleAsSource: s.eligibleAsSource,
    ...(s.exclusion === null ? {} : { exclusion: s.exclusion }),
  }));
  const warnings: RedistributionWarningV1[] = [...unresolved].map(([productId, count]) => ({
    code: 'stocking_unit_mismatch',
    productId,
    count,
    detail: 'stocking_unit_unresolved',
  }));
  return {
    problem: {
      kind: 'store_redistribution',
      version: 1,
      tenantId: reads.tenantId,
      computedAt: reads.computedAt,
      stores: engineStores,
      rows,
      limits: reads.limits,
      buffer: reads.buffer,
    },
    stores,
    warnings,
  };
}
