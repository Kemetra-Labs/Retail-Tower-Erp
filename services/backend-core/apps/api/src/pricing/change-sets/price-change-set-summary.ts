/**
 * RT-1484 (RT-282 PR-10a, PR-4b) — the Impact Preview's summary (`PreviewSummary`, spec 042 §6) and
 * the canonical form of the preview the `previewHash` is taken over. Pure.
 *
 * Counting rules: `lines` counts the stored lines (moves included); `increases` / `decreases` and
 * the max deltas are over preview rows with both an old and a new price; `unchanged` counts the
 * lines dropped as unchanged; `findings` counts lines by class; `devices` sums the active devices
 * of the target Stores; `earliestEffectiveAt` is the earliest per-Store instant (UTC).
 */
import { compareDelta, comparePrices } from "./price-change-set-money";
import { previewHash, type Json, type TargetStore } from "./price-change-set-hashes";
import {
  isBlocking,
  type ChangeSetKindForValidation,
  type LineClass,
  type MaterializedLine,
  type MembershipChange,
  type PreviewRow,
  type PreviewSummary,
} from "./price-change-set-validation.types";

/** The smallest value, or null for none (a loop: spreading ~130k values into Math.min overflows the stack). */
function minOf(values: readonly number[]): number | null {
  let min: number | null = null;
  for (const v of values) if (min === null || v < min) min = v;
  return min;
}

function deltas(rows: readonly PreviewRow[]): Pick<PreviewSummary, "increases" | "decreases" | "maxIncreasePct" | "maxDecreasePct"> {
  let increases = 0;
  let decreases = 0;
  let maxIncreasePct: string | null = null;
  let maxDecreasePct: string | null = null;
  for (const r of rows) {
    if (r.oldPrice === null || r.newPrice === null) continue;
    const c = comparePrices(r.newPrice, r.oldPrice);
    if (c > 0) increases += 1;
    if (c < 0) decreases += 1;
    if (r.deltaPct === null) continue;
    if (c > 0 && (maxIncreasePct === null || compareDelta(r.deltaPct, maxIncreasePct) > 0)) maxIncreasePct = r.deltaPct;
    if (c < 0 && (maxDecreasePct === null || compareDelta(r.deltaPct, maxDecreasePct) < 0)) maxDecreasePct = r.deltaPct;
  }
  return { increases, decreases, maxIncreasePct, maxDecreasePct };
}

export function summarize(input: {
  readonly lines: readonly MaterializedLine[];
  readonly rows: readonly PreviewRow[];
  readonly targets: readonly TargetStore[];
  readonly unchanged: number;
  readonly effectiveMs: readonly number[];
  readonly devices: ReadonlyMap<string, number>;
  readonly kind: ChangeSetKindForValidation;
}): PreviewSummary {
  const { lines } = input;
  const count = (c: LineClass): number => lines.filter((l) => l.class === c).length;
  const earliest = minOf(input.effectiveMs);
  return {
    lines: lines.length,
    stores: input.targets.length,
    devices: input.targets.reduce((n, s) => n + (input.devices.get(s.storeId) ?? 0), 0),
    products: new Set(lines.flatMap((l) => (l.productId === null ? [] : [l.productId]))).size,
    ...deltas(input.rows),
    unchanged: input.unchanged,
    earliestEffectiveAt: earliest === null ? null : new Date(earliest).toISOString(),
    findings: {
      replaces: count("replaces"),
      shadowed: count("shadowed"),
      invalidates_dependent: count("invalidates_dependent"),
      conflicts_pending: count("conflicts_pending"),
      past_dated: count("past_dated"),
      invalid: count("invalid"),
    },
    blocking: lines.some((l) => isBlocking(l.class, input.kind)),
  };
}

const isoOrNull = (v: string | null): string | null => (v === null ? null : new Date(v).toISOString());

function lineJson(l: MaterializedLine): Json {
  return {
    lineNo: l.lineNo,
    itemPosition: l.itemPosition,
    op: l.op,
    scope: l.scope,
    priceZoneId: l.priceZoneId,
    storeId: l.storeId,
    productId: l.productId,
    sellUnit: l.sellUnit,
    timeBasis: l.timeBasis,
    effectiveFrom: isoOrNull(l.effectiveFrom),
    effectiveTo: isoOrNull(l.effectiveTo),
    effectiveFromLocal: l.effectiveFromLocal,
    effectiveToLocal: l.effectiveToLocal,
    newPrice: l.newPrice,
    roundedFrom: l.roundedFrom,
    class: l.class,
    messages: [...l.messages],
    replacedIds: [...l.replacedIds],
  };
}

function rowJson(r: PreviewRow): Json {
  return {
    rowNo: r.rowNo,
    lineNo: r.lineNo,
    storeId: r.storeId,
    productId: r.productId,
    sellUnit: r.sellUnit,
    oldPrice: r.oldPrice,
    oldSourceScope: r.oldSourceScope,
    newPrice: r.newPrice,
    newSourceScope: r.newSourceScope,
    deltaPct: r.deltaPct,
    roundedFrom: r.roundedFrom,
    effectiveFromMs: r.effectiveFromMs,
    class: r.class,
    messages: [...r.messages],
  };
}

function membershipJson(m: MembershipChange): Json {
  return {
    lineNo: m.lineNo,
    storeId: m.storeId,
    fromZoneId: m.fromZoneId,
    toZoneId: m.toZoneId,
    effectiveFrom: new Date(m.effectiveFrom).toISOString(),
    effectiveTo: isoOrNull(m.effectiveTo),
    supersededMembershipIds: [...m.supersededMembershipIds],
  };
}

/** The `previewHash` of a validation (spec 042 §6): its lines, preview rows and moves, bound to the revision and Stores. */
export function hashPreview(input: {
  readonly validatedAtRevision: number;
  readonly targetStoreSetHash: string;
  readonly lines: readonly MaterializedLine[];
  readonly rows: readonly PreviewRow[];
  readonly membershipChanges: readonly MembershipChange[];
}): string {
  return previewHash({
    validatedAtRevision: input.validatedAtRevision,
    targetStoreSetHash: input.targetStoreSetHash,
    lines: input.lines.map(lineJson),
    previewRows: input.rows.map(rowJson),
    membershipChanges: input.membershipChanges.map(membershipJson),
  });
}
