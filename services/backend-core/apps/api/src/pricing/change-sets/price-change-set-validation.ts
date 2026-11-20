/**
 * RT-1484 (RT-282 PR-10a, PR-4b) — the pure core of `validate` (spec 042 §4.3, §5, §6): it
 * materializes a set's items into lines, reaches each line's Stores, prices each (Store, line)
 * through the resolver (`../resolution`), classifies every line and builds the Impact Preview
 * with its summary, hashes and sensitivity. No I/O and no clock: the repository loads a
 * `ValidationContext` at the head revision and the service persists the result.
 *
 * Decisions (RT-1484 comments 17881 and 17882, and the lead's review-round-1 decisions on #746):
 *   - Head timeline only. Fan-out and old prices use the Pricing data visible at the tenant's head
 *     revision (§6); the set's own Zone moves do not count in v1.
 *   - Store reach. A `book` line reaches every live Store; a `stores` line its named Stores; a
 *     `zone` line every live Store whose membership visible at the head overlaps the line's
 *     interval in that Zone (a Store with no membership over part of it is in the Book's default
 *     Zone there). The Store's `effectiveFrom` is the later of the line's start and the
 *     membership's start, the line's start converted in the Store's time zone for `store_local`.
 *     v1: an ambiguous membership anywhere in the line's interval invalidates that Store.
 *     A line that reaches no live Store refuses the whole set (`422 change_set_no_target_store`,
 *     naming the item's position), and so do an id the tenant does not have (a Store, Zone or
 *     product) and a category with no live product: nothing is stored.
 *   - Budgets: at most `MAX_LINES` lines (checked before expanding an item) and
 *     `MAX_PREVIEW_ROWS` preview rows (`checkBudget`, before the events are loaded); over either
 *     is `422 change_set_too_large`.
 *   - Classes, most severe first: `invalid` (not representable, `price_not_positive`,
 *     `mixed_time_basis`, an ambiguous Zone membership, a product, Store or Zone that is not
 *     live, an interval empty in a Store's time zone, an overlap with another line of the same
 *     set, an end that ends nothing), `past_dated`, `replaces`, `conflicts_pending`, `shadowed`,
 *     `invalidates_dependent`, `new`. A line takes the most severe class any of its Stores gives
 *     it; its preview rows carry it (0123 ties a preview row's class to its line's), and each
 *     row's `messages` hold the line-wide findings plus that Store's own.
 *   - Unchanged. A priced line is unchanged when an active event already holds the same key,
 *     scope target, price and time basis over an interval that covers the line's, at every Store.
 *     It is dropped and counted in `summary.unchanged`. An `invalid` line is never dropped.
 *   - Helpers (round 3, MAJOR-2, which reverses round 1's m3). A helper's price is computed per
 *     reached Store, from the price its scope target holds at the line's start in that Store's
 *     time zone (its own layer, else the less specific ones). Publish writes one event per line,
 *     so the line has one price: when every Store gives the same, that is the line's
 *     `new_price` and every preview row shows it; when they differ the line is `invalid` with
 *     `helper_base_varies_by_store` (the author uses `set_price` or splits by Zone or Store).
 *   - A Zone line naming a retired Zone is `422 change_set_no_target_store` (`zone_not_live` in
 *     the message), checked before reach (round 3, minor 1).
 *   - In-set overlaps: an end or reset is the instant it takes effect (round 3, MAJOR-1; see
 *     `price-change-set-in-set.ts`), compared in the zones of the Stores each line reaches.
 */
import { compareCodeUnits } from "../../common/compare-code-units";
import { minorUnitExponent } from "../../common/money/iso4217-minor-units";
import { representablePrice } from "../resolution/representable-price";
import { eventInterval, membershipInterval, resolvePrice, visibleAt, type Interval } from "../resolution/resolve";
import { formatInstantInZone } from "../resolution/store-local-time";
import type {
  PriceResolution,
  PriceScope,
  ResolutionData,
  ResolutionPriceEvent,
  ResolutionStore,
  ResolutionZoneMembership,
} from "../resolution/types";
import type { PriceChangeItem } from "./price-change-sets.dto";
import { boundsOf, clip, covers, intervalIn, isEmpty, rawInterval, type Bounds, type PricedItem } from "./price-change-set-bounds";
import { sortTargetStores, targetStoreSetHash, type TargetStore } from "./price-change-set-hashes";
import { inSetFindings, type InSetLine } from "./price-change-set-in-set";
import { comparePrices, deltaPercent, helperPrice, isPositivePrice, normalizePrice } from "./price-change-set-money";
import { hashPreview, summarize } from "./price-change-set-summary";
import {
  INVALID_MESSAGES,
  MAX_LINES,
  MAX_PREVIEW_ROWS,
  mostSevere,
  noTarget,
  overlaps,
  RefusalError,
  sensitivityReasons,
  type LineClass,
  type MaterializedLine,
  type MembershipChange,
  type PendingLine,
  type PositionedItem,
  type PreviewRow,
  type ValidationContext,
  type ValidationRefusal,
  type ValidationResult,
} from "./price-change-set-validation.types";
import { materializeMove } from "./price-change-set-zone-moves";

const SELL_UNIT = "each";
const SCOPE_RANK: Readonly<Record<PriceScope, number>> = { book: 0, zone: 1, store: 2 };
const PRICED_OPS: ReadonlySet<string> = new Set(["set_price", "adjust_amount", "adjust_percent"]);
/** Pseudo-event id of the line being simulated (never a real UUID). */
const LINE_EVENT_ID = "line";

type ValidationStore = ValidationContext["stores"] extends ReadonlyMap<string, infer S> ? S : never;
type MoveItem = Extract<PriceChangeItem, { op: "move_store_zone" }>;
type Entry = { position: number; target: Target } | { position: number; move: MoveItem };

/** A (scope target, product) line before classification. */
interface Target {
  readonly position: number;
  readonly item: PricedItem;
  readonly scope: PriceScope;
  readonly priceZoneId: string | null;
  readonly storeId: string | null;
  readonly productId: string;
}

/** A Store a line reaches, at its exact activation instant there, and the line's interval there. */
interface Reach {
  readonly store: ValidationStore;
  readonly fromMs: number;
  readonly interval: Interval;
  readonly messages: readonly string[];
}

/** One Store's concrete price for the line (a helper's differs per Store). */
interface StorePrice {
  readonly price: string | null;
  readonly roundedFrom: string | null;
}

/** A priced, ended or reset line while it is being classified. */
interface Draft {
  readonly t: Target;
  readonly bounds: Bounds;
  readonly reached: readonly Reach[];
  readonly events: readonly ResolutionPriceEvent[];
  readonly replaced: readonly ResolutionPriceEvent[];
  /** Each reached Store's price (priced ops). */
  readonly prices: ReadonlyMap<string, StorePrice>;
  /** Every finding of the line (line-wide and per Store): the stored line's `messages`. */
  readonly messages: ReadonlySet<string>;
  /** The findings that hold at every reached Store. */
  readonly lineMessages: ReadonlySet<string>;
  /** Each Store's own findings (reach, helper price). */
  readonly storeMessages: ReadonlyMap<string, readonly string[]>;
  readonly invalid: boolean;
}

const lower = (id: string): string => id.toLowerCase();
const NO_PRICE: StorePrice = { price: null, roundedFrom: null };

function firstGap(own: readonly Interval[], interval: Interval): number | null {
  let cursor = interval.from;
  for (const i of own) {
    if (i.from > cursor) return cursor;
    if (i.to === null) return null;
    cursor = Math.max(cursor, i.to);
  }
  return interval.to === null || cursor < interval.to ? cursor : null;
}

function pricedOf(r: PriceResolution): { price: string | null; scope: PriceScope | null; eventId: string | null } {
  return r.status === "priced"
    ? { price: r.price, scope: r.provenance.sourceScope, eventId: r.provenance.priceEventId }
    : { price: null, scope: null, eventId: null };
}

function sameTarget(e: { scope: string; priceZoneId: string | null; storeId: string | null }, t: Target): boolean {
  return e.scope === t.scope && (t.scope !== "zone" || e.priceZoneId === t.priceZoneId) && (t.scope !== "store" || e.storeId === t.storeId);
}

/** The key that groups lines of one price key (in-set overlaps, pending conflicts). */
const keyOf = (t: { scope: string; priceZoneId: string | null; storeId: string | null; productId: string | null }): string =>
  `${t.scope}|${t.priceZoneId ?? ""}|${t.storeId ?? ""}|${t.productId ?? ""}`;
const moveKey = (storeId: string): string => `move|${storeId}`;

const emptyMessage = (i: Interval): string[] => (isEmpty(i) ? ["empty_interval"] : []);
const tooLarge = (what = `${MAX_LINES} lines`): RefusalError =>
  new RefusalError("change_set_too_large", `The Change Set materializes more than ${what}; split it.`);
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort(compareCodeUnits);

/** The line's one price (its first Store's by id; every Store's when the line is valid). */
const linePriceOf = (d: { readonly prices: ReadonlyMap<string, StorePrice>; readonly reached: readonly { readonly store: { readonly id: string } }[] }): StorePrice =>
  d.prices.get(d.reached[0]!.store.id) ?? NO_PRICE;

function appendTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

class Validator {
  private readonly eventsByProduct = new Map<string, ResolutionPriceEvent[]>();
  private readonly membershipsByStore = new Map<string, ResolutionZoneMembership[]>();
  /** Lines of other pending sets by key (review round 1, M2: no lines × pending scan). */
  private readonly pendingByKey = new Map<string, PendingLine[]>();
  private readonly liveZones: readonly string[];
  /** Live Stores in id order. */
  private readonly liveStores: readonly ValidationStore[];
  /** Live Stores with a visible membership in each Zone (round 2: a Zone line scans only these). */
  private readonly storesByZone = new Map<string, ValidationStore[]>();
  /** Reach per distinct target (scope, Zone or Store, bounds), computed once (round 2). */
  private readonly reachCache = new Map<string, Reach[]>();
  /** How many distinct targets reach was computed for (the unit spec's complexity guard). */
  reachComputations = 0;
  /** The bounds of the set's own ends and resets, by key (round 4: they defeat "unchanged"). */
  private readonly endsByKey = new Map<string, Bounds[]>();
  private readonly minorUnit: number;

  constructor(private readonly ctx: ValidationContext) {
    for (const e of ctx.events) {
      if (e.priceBookId !== ctx.book.id || e.priceKind !== "regular" || e.sellUnit !== SELL_UNIT || !visibleAt(e, ctx.headRevision)) continue;
      appendTo(this.eventsByProduct, e.productId, e);
    }
    for (const m of ctx.memberships) {
      if (m.priceBookId !== ctx.book.id || !visibleAt(m, ctx.headRevision)) continue;
      appendTo(this.membershipsByStore, m.storeId, m);
    }
    for (const p of ctx.pendingLines) {
      appendTo(this.pendingByKey, p.op === "move_store_zone" ? moveKey(p.storeId ?? "") : keyOf(p), p);
    }
    this.liveStores = [...ctx.stores.values()].filter((s) => s.live).sort((x, y) => compareCodeUnits(x.id, y.id));
    this.liveZones = sorted(this.liveStores.map((s) => s.timezone));
    // One pass over the live Stores and their memberships: Zone → the Stores it can reach.
    for (const store of this.liveStores) {
      for (const zoneId of new Set(this.membershipsOf(store.id).map((m) => m.priceZoneId))) appendTo(this.storesByZone, zoneId, store);
    }
    this.minorUnit = minorUnitExponent(ctx.book.currencyCode) ?? -1;
  }

  run<T>(work: () => T): T | ValidationRefusal {
    try {
      return work();
    } catch (err) {
      if (err instanceof RefusalError) return { ok: false, code: err.code, message: err.message };
      throw err;
    }
  }

  /** M2: the preview-row count (the Stores each line reaches) without pricing anything. */
  budget(items: readonly PositionedItem[]): null {
    let rows = 0;
    for (const entry of this.materialize(items)) {
      if ("move" in entry) continue;
      rows += this.reach(entry.target, boundsOf(entry.target.item).bounds).length;
      if (rows > MAX_PREVIEW_ROWS) throw tooLarge(`${MAX_PREVIEW_ROWS} preview rows (Stores × lines)`);
    }
    return null;
  }

  validate(items: readonly PositionedItem[]): ValidationResult {
    const entries = this.materialize(items);
    const inSet = inSetFindings(entries.map((e) => this.inSetLine(e)));
    for (const e of entries) {
      if (!("move" in e) && !PRICED_OPS.has(e.target.item.op)) appendTo(this.endsByKey, keyOf(e.target), boundsOf(e.target.item).bounds);
    }
    const lines: MaterializedLine[] = [];
    const rows: Omit<PreviewRow, "rowNo">[] = [];
    const membershipChanges: MembershipChange[] = [];
    let unchanged = 0;
    entries.forEach((entry, index) => {
      const lineNo = lines.length + 1;
      const found = inSet.get(index) ?? [];
      if ("move" in entry) {
        const storeId = lower(entry.move.storeId);
        const scope = { memberships: this.membershipsOf(storeId), pending: this.pendingByKey.get(moveKey(storeId)) ?? [], inSet: found };
        const { line, change } = materializeMove(this.ctx, scope, lineNo, entry.position, entry.move);
        lines.push(line);
        membershipChanges.push(change);
        return;
      }
      const priced = this.pricedLine(lineNo, entry.target, found);
      if (priced === null) unchanged += 1;
      else {
        lines.push(priced.line);
        for (const row of priced.rows) rows.push(row);
      }
    });
    const previewRows: PreviewRow[] = [...rows]
      .sort((x, y) => compareCodeUnits(x.storeId, y.storeId) || compareCodeUnits(x.productId, y.productId) || x.effectiveFromMs - y.effectiveFromMs || x.lineNo - y.lineNo)
      .map((r, i) => ({ ...r, rowNo: i + 1 }));
    return this.assemble(lines, previewRows, membershipChanges, unchanged);
  }

  private assemble(
    lines: readonly MaterializedLine[],
    previewRows: readonly PreviewRow[],
    membershipChanges: readonly MembershipChange[],
    unchanged: number,
  ): ValidationResult {
    const byId = new Map<string, TargetStore>();
    for (const storeId of [...previewRows.map((r) => r.storeId), ...membershipChanges.map((m) => m.storeId)]) {
      byId.set(storeId, { storeId, timezone: this.store(storeId).timezone });
    }
    const targetStores = sortTargetStores([...byId.values()]);
    const storeHash = targetStoreSetHash(targetStores);
    const effectiveMs = [...previewRows.map((r) => r.effectiveFromMs), ...membershipChanges.map((m) => Date.parse(m.effectiveFrom))];
    return {
      ok: true,
      lines,
      previewRows,
      membershipChanges,
      targetStores,
      summary: summarize({ lines, rows: previewRows, targets: targetStores, unchanged, effectiveMs, devices: this.ctx.devices, kind: this.ctx.kind }),
      targetStoreSetHash: storeHash,
      previewHash: hashPreview({ validatedAtRevision: this.ctx.headRevision, targetStoreSetHash: storeHash, lines, rows: previewRows, membershipChanges }),
      sensitive: true,
      sensitivityReasons: sensitivityReasons(lines, this.ctx.kind),
      effectiveMs,
    };
  }

  /**
   * RT-1484 PR-10b (spec 042 §3, Q-B8): the target Stores the stored lines reach now, computed by
   * the same reach rule as `validate`, or null when a line can no longer be published as validated
   * (its Zone was retired, it reaches no live Store, or a Store it reaches is no longer live).
   */
  targetStoresOf(lines: readonly StoredLineReach[]): TargetStore[] | null {
    const byId = new Map<string, TargetStore>();
    const add = (store: ValidationStore): boolean => {
      byId.set(store.id, { storeId: store.id, timezone: store.timezone });
      return store.live;
    };
    const zoneLive = (id: string | null): boolean => this.ctx.zones.get(id ?? "")?.live ?? false;
    for (const l of lines) {
      if (l.op === "move_store_zone") {
        // A move into a Zone retired since validation is stale too (contract: publish).
        const store = this.ctx.stores.get(l.storeId ?? "");
        if (store === undefined || !add(store) || !zoneLive(l.priceZoneId)) return null;
        continue;
      }
      if (l.scope === "zone" && !zoneLive(l.priceZoneId)) return null;
      const target: Target = { position: 0, item: undefined as never, scope: l.scope, priceZoneId: l.priceZoneId, storeId: l.storeId, productId: "" };
      const reached = this.reach(target, l.bounds);
      if (reached.length === 0 || !reached.every((r) => add(r.store))) return null;
    }
    return sortTargetStores([...byId.values()]);
  }

  // ---- materialization ----------------------------------------------------

  /** Every line before classification, in item order (a move keeps its item's place); 422 over the limit. */
  private materialize(items: readonly PositionedItem[]): Entry[] {
    const out: Entry[] = [];
    for (const { position, item } of items) {
      if (item.op === "move_store_zone") out.push({ position, move: item });
      else for (const target of this.targetsOf(position, item, out.length)) out.push({ position, target });
      if (out.length > MAX_LINES) throw tooLarge();
    }
    return out;
  }

  /** M1: a line as the in-set overlap check sees it (its key, bounds and the zones it applies in). */
  private inSetLine(entry: Entry): InSetLine {
    if ("move" in entry) {
      const m = entry.move;
      const bounds: Bounds = {
        timeBasis: "absolute",
        effectiveFrom: new Date(m.effectiveFrom),
        effectiveTo: m.effectiveTo === undefined ? null : new Date(m.effectiveTo),
        effectiveFromLocal: null,
        effectiveToLocal: null,
      };
      return { key: moveKey(lower(m.storeId)), bounds, point: false, zones: ["UTC"] };
    }
    const t = entry.target;
    const { bounds } = boundsOf(t.item);
    // Round 3, minor 2: the zones of the Stores the line reaches (cached), not every live zone.
    const zones = sorted(this.reach(t, bounds).map((r) => r.store.timezone));
    // Round 3, MAJOR-1: an end or reset is the instant it takes effect.
    return { key: keyOf(t), bounds, point: !PRICED_OPS.has(t.item.op), zones };
  }

  private store(id: string): ValidationStore {
    const s = this.ctx.stores.get(id);
    if (s === undefined) throw new Error(`store ${id} not loaded`);
    return s;
  }

  private membershipsOf(storeId: string): ResolutionZoneMembership[] {
    return this.membershipsByStore.get(storeId) ?? [];
  }

  /**
   * The (scope target, product) lines of one priced, ended or reset item (§4.3); ids in lower case.
   * Refuses before expanding when the set would pass `MAX_LINES` (`queued` lines so far), and when
   * the item names no product (an empty or unknown category: it reaches no live Store).
   */
  private targetsOf(position: number, item: PricedItem, queued: number): Target[] {
    const products = this.productsOf(position, item.products);
    if (products.length === 0) throw noTarget(position, "names a category with no live product, so it reaches no live Store");
    const scopes: { scope: PriceScope; priceZoneId: string | null; storeId: string | null }[] = [];
    if (item.scope.kind === "book") scopes.push({ scope: "book", priceZoneId: null, storeId: null });
    else if (item.scope.kind === "zone") {
      const zoneId = lower(item.scope.zoneId);
      if (!this.ctx.zones.has(zoneId)) throw noTarget(position, "names a Zone that is not in the tenant's Price Book, so it reaches no live Store");
      // Round 3, minor 1: a retired Zone is refused before reach (a retired Zone has no live member).
      if (!this.ctx.zones.get(zoneId)!.live) throw noTarget(position, "names a retired Zone (zone_not_live), so it reaches no live Store");
      scopes.push({ scope: "zone", priceZoneId: zoneId, storeId: null });
    } else {
      for (const storeId of item.scope.storeIds.map(lower)) {
        if (!this.ctx.stores.has(storeId)) throw noTarget(position, "names a Store that is not the tenant's, so it reaches no live Store");
        scopes.push({ scope: "store", priceZoneId: null, storeId });
      }
    }
    if (queued + scopes.length * products.length > MAX_LINES) throw tooLarge();
    return scopes.flatMap((s) => products.map((productId) => ({ position, item, ...s, productId })));
  }

  private productsOf(position: number, selector: PricedItem["products"]): string[] {
    if (selector.kind === "category") return [...(this.ctx.categoryProducts.get(lower(selector.categoryId)) ?? [])];
    return selector.productIds.map((raw) => {
      const id = lower(raw);
      if (!this.ctx.products.has(id)) throw noTarget(position, "names a product that is not the tenant's, so it prices no live Store");
      return id;
    });
  }

  // ---- Store reach ----------------------------------------------------------

  /**
   * The Stores a line reaches, in id order, and its activation instant in each (comment 17882). A
   * `store_local` line whose bounds fall in one DST gap has an empty interval in that Store: it is
   * reached, with `empty_interval` (invalid: it could never take effect there).
   */
  private reach(t: Target, bounds: Bounds): Reach[] {
    // Every product of one item shares its target and bounds: reach is computed once per target
    // (round 2, lead decision), so the cost is O(targets × candidate Stores), not O(lines × Stores).
    const key = `${t.scope}|${t.priceZoneId ?? ""}|${t.storeId ?? ""}|${bounds.timeBasis}|${(rawInterval(bounds)?.from ?? "")}|${(rawInterval(bounds)?.to ?? "")}`;
    const cached = this.reachCache.get(key);
    if (cached !== undefined) return cached;
    const computed = this.computeReach(t, bounds);
    this.reachCache.set(key, computed);
    return computed;
  }

  /**
   * A Book line reaches every live Store; a Store line its Store; a Zone line only the Stores with
   * a membership in that Zone, or every live Store for the default Zone (the fallback).
   */
  private computeReach(t: Target, bounds: Bounds): Reach[] {
    this.reachComputations += 1;
    if (t.scope === "store") {
      const store = this.store(t.storeId!);
      const interval = intervalIn(bounds, store.timezone)!;
      const messages = [...(store.live ? [] : ["store_not_live"]), ...emptyMessage(interval)];
      return [{ store, fromMs: interval.from, interval, messages }];
    }
    const out: Reach[] = [];
    const candidates =
      t.scope === "book" || t.priceZoneId === this.ctx.book.defaultZoneId ? this.liveStores : (this.storesByZone.get(t.priceZoneId!) ?? []);
    for (const store of candidates) {
      const interval = intervalIn(bounds, store.timezone)!;
      // An empty interval is probed over its one instant, so Zone reach still decides membership.
      const probe = isEmpty(interval) ? { from: interval.from, to: interval.from + 1 } : interval;
      const reached = t.scope === "book" ? { store, fromMs: interval.from, interval, messages: [] } : this.zoneReach(store, t.priceZoneId!, probe);
      if (reached !== null) out.push({ ...reached, interval, messages: [...reached.messages, ...emptyMessage(interval)] });
    }
    return out.sort((x, y) => compareCodeUnits(x.store.id, y.store.id));
  }

  /**
   * Whether `store` is in `zoneId` during part of `interval`, and from when. v1 (lead decision t3):
   * two of the Store's memberships overlapping anywhere in the interval make the Store ambiguous
   * for the whole line, even where only one applies.
   */
  private zoneReach(store: ValidationStore, zoneId: string, interval: Interval): Reach | null {
    const own = this.membershipsOf(store.id)
      .map((m) => ({ zone: m.priceZoneId, i: clip(membershipInterval(m), interval) }))
      .filter((x): x is { zone: string; i: Interval } => x.i !== null)
      .sort((x, y) => x.i.from - y.i.from);
    const isDefault = zoneId === this.ctx.book.defaultZoneId;
    if (own.some((x, k) => k > 0 && overlaps(own[k - 1]!.i, x.i))) {
      const inZone = isDefault || own.some((x) => x.zone === zoneId);
      return inZone ? { store, fromMs: interval.from, interval, messages: ["ambiguous_zone_membership"] } : null;
    }
    const starts = own.filter((x) => x.zone === zoneId).map((x) => x.i.from);
    if (isDefault) {
      const gap = firstGap(own.map((x) => x.i), interval);
      if (gap !== null) starts.push(gap);
    }
    return starts.length === 0 ? null : { store, fromMs: Math.min(...starts), interval, messages: [] };
  }

  // ---- priced, ended and reset lines ----------------------------------------

  /** The line and its preview rows, or null when the line is unchanged (dropped). */
  private pricedLine(lineNo: number, t: Target, inSet: readonly string[]): { line: MaterializedLine; rows: Omit<PreviewRow, "rowNo">[] } | null {
    const draft = this.draft(t, inSet);
    if (this.isUnchanged(draft)) return null;
    const flags = new Set<LineClass>();
    const rows = draft.reached.map((r) => this.storeRow(lineNo, draft, r, flags));
    if (draft.invalid) flags.add("invalid");
    if (draft.replaced.length > 0) flags.add("replaces");
    if (!draft.invalid && this.conflictsPending(t, draft.reached)) flags.add("conflicts_pending");
    const cls = mostSevere(flags);
    const first = linePriceOf(draft);
    const { text } = boundsOf(t.item);
    const line: MaterializedLine = {
      lineNo,
      itemPosition: t.position,
      op: t.item.op,
      scope: t.scope,
      priceZoneId: t.priceZoneId,
      storeId: t.storeId,
      productId: t.productId,
      sellUnit: SELL_UNIT,
      ...text,
      // 0123: an invalid priced line may carry no price; a carried one is > 0.
      // A helper whose Stores disagree has no one price to publish: none is stored (0123 allows
      // an invalid priced line without a price; delta review, minor-1).
      newPrice: PRICED_OPS.has(t.item.op) && !draft.messages.has("helper_base_varies_by_store") ? first.price : null,
      // The line's rounded_from is the representative value (its first Store by id); each preview
      // row carries its own Store's (delta review, minor-2).
      roundedFrom: draft.invalid ? null : first.roundedFrom,
      class: cls,
      messages: sorted(draft.messages),
      replacedIds: sorted(draft.replaced.map((e) => e.id)),
    };
    return { line, rows: rows.map((row) => ({ ...row, class: cls, roundedFrom: draft.invalid ? null : row.roundedFrom })) };
  }

  /** Reach, per-Store prices, what it replaces and the findings. */
  private draft(t: Target, inSet: readonly string[]): Draft {
    const { bounds } = boundsOf(t.item);
    const reached = this.reach(t, bounds);
    if (reached.length === 0) throw noTarget(t.position, "reaches no live Store");
    const events = this.eventsByProduct.get(t.productId) ?? [];
    const lineMessages = new Set<string>(inSet);
    if (!(this.ctx.products.get(t.productId)?.live ?? false)) lineMessages.add("product_not_live");
    // The same-target events it replaces (priced) or ends (end, reset), in any reached Store.
    const replaced = events.filter(
      (e) => sameTarget(e, t) && reached.some((r) => {
        const ei = eventInterval(e, r.store.timezone);
        return ei !== null && overlaps(ei, r.interval);
      }),
    );
    if (replaced.some((e) => e.timeBasis !== bounds.timeBasis)) lineMessages.add("mixed_time_basis");
    if (!PRICED_OPS.has(t.item.op) && replaced.length === 0) lineMessages.add("nothing_to_end");
    const prices = new Map<string, StorePrice>();
    const storeMessages = new Map<string, readonly string[]>();
    const messages = new Set(lineMessages);
    for (const r of reached) {
      const own = [...r.messages];
      prices.set(r.store.id, this.storePrice(t, events, r, own));
      storeMessages.set(r.store.id, own);
      for (const m of own) messages.add(m);
    }
    // Round 3, MAJOR-2: publish writes one event per line at one price, so a helper whose base
    // differs between its Stores cannot be published as one line: invalid, split it or use set_price.
    const distinct = new Set([...prices.values()].map((p) => p.price).filter((p) => p !== null));
    if (distinct.size > 1) {
      lineMessages.add("helper_base_varies_by_store");
      messages.add("helper_base_varies_by_store");
    }
    const invalid = [...messages].some((m) => INVALID_MESSAGES.has(m));
    return { t, bounds, reached, events, replaced, prices, messages, lineMessages, storeMessages, invalid };
  }

  /**
   * One Store's concrete price for a priced line (decisions 515–517): a `set_price`'s own; a
   * helper's from the price its scope target holds at the line's start in that Store's zone
   * (review round 1, m3). Adds the Store's findings to `own`.
   */
  private storePrice(t: Target, events: readonly ResolutionPriceEvent[], r: Reach, own: string[]): StorePrice {
    const item = t.item;
    if (item.op === "set_price") {
      const normalized = normalizePrice(item.price);
      if (normalized === null || !isPositivePrice(normalized)) {
        own.push("price_not_positive");
        return NO_PRICE;
      }
      if (representablePrice(normalized, this.ctx.book.currencyCode) === null) own.push("price_not_representable");
      return { price: normalized, roundedFrom: null };
    }
    if (item.op !== "adjust_amount" && item.op !== "adjust_percent") return NO_PRICE;
    const base = this.scopePrice(t, events, r.store, r.fromMs);
    if (base === null) {
      own.push("no_base_price");
      return NO_PRICE;
    }
    const h = helperPrice(base, item.op === "adjust_amount" ? { amount: item.amount } : { percent: item.percent }, this.minorUnit);
    if (h.kind !== "price") {
      own.push(h.kind === "not_positive" ? "price_not_positive" : "price_not_representable");
      return NO_PRICE;
    }
    if (h.roundedFrom !== null) own.push("rounded_price");
    return { price: h.price, roundedFrom: h.roundedFrom };
  }

  /** Unchanged: at every Store, an active event of the same target, price and basis already covers the line. */
  private isUnchanged(d: Draft): boolean {
    if (d.invalid || !PRICED_OPS.has(d.t.item.op) || this.endedFirstInSet(d)) return false;
    const prices = new Set([...d.prices.values()].map((p) => p.price));
    const price = [...prices][0];
    if (prices.size !== 1 || price === null || price === undefined) return false;
    const raw = rawInterval(d.bounds)!;
    return d.replaced.some((e) => {
      const ei = rawInterval(e);
      return e.timeBasis === d.bounds.timeBasis && ei !== null && covers(ei, raw) && comparePrices(e.price, price) === 0;
    });
  }

  /**
   * Review round 4 (CodeRabbit 4640763235): an end or reset of the same key in this set, at or
   * before the line's start in a reached Store, ends the head event the line would match, so the
   * line is a re-price, never "unchanged" (the simplest correct rule, lead decision).
   */
  private endedFirstInSet(d: Draft): boolean {
    return (this.endsByKey.get(keyOf(d.t)) ?? []).some((end) =>
      d.reached.some((r) => {
        const at = intervalIn(end, r.store.timezone);
        return at !== null && at.from <= r.fromMs;
      }),
    );
  }

  /** One Store's preview row: old and new resolution, shadowing, dependents and past dating. */
  private storeRow(lineNo: number, d: Draft, r: Reach, flags: Set<LineClass>): Omit<PreviewRow, "rowNo"> {
    const store: ResolutionStore = { id: r.store.id, tenantId: this.ctx.tenantId, timezone: r.store.timezone };
    const at = new Date(r.fromMs);
    const data: ResolutionData = { book: this.ctx.book, memberships: this.membershipsOf(r.store.id), events: d.events };
    const old = pricedOf(resolvePrice(d.t.productId, SELL_UNIT, store, at, this.ctx.headRevision, data));
    const rowMessages = new Set([...d.lineMessages, ...(d.storeMessages.get(r.store.id) ?? [])]);
    const next = d.invalid
      ? pricedOf({ status: "unpriced", reason: "no_price" })
      : pricedOf(resolvePrice(d.t.productId, SELL_UNIT, store, at, this.ctx.headRevision, { ...data, events: this.eventsAfter(d) }));
    const found: LineClass[] = [];
    if (!d.invalid && this.isShadowed(d, old.scope, next.eventId)) found.push("shadowed");
    if (!d.invalid && this.invalidatesDependent(d, r)) found.push("invalidates_dependent");
    if (r.fromMs < this.ctx.nowMs) found.push("past_dated");
    for (const f of found) {
      flags.add(f);
      rowMessages.add(f);
    }
    return {
      lineNo,
      storeId: r.store.id,
      productId: d.t.productId,
      sellUnit: SELL_UNIT,
      oldPrice: old.price,
      oldSourceScope: old.scope,
      newPrice: next.price,
      newSourceScope: next.scope,
      deltaPct: old.price !== null && next.price !== null ? deltaPercent(old.price, next.price) : null,
      roundedFrom: (d.prices.get(r.store.id) ?? NO_PRICE).roundedFrom,
      effectiveFromMs: r.fromMs,
      effectiveFrom: formatInstantInZone(at, r.store.timezone),
      class: "new",
      devices: this.ctx.devices.get(r.store.id) ?? 0,
      // Sorted, so the stored row and the hashed row agree (lead decision t1).
      messages: sorted(rowMessages),
    };
  }

  /** The product's events at a Store after publish (simulated): the replaced ones gone, the line's event added. */
  private eventsAfter(d: Draft): ResolutionPriceEvent[] {
    const replacedIds = new Set(d.replaced.map((e) => e.id));
    // The one price publish writes for the line (round 3, MAJOR-2), at every Store.
    const price = linePriceOf(d).price;
    const added = PRICED_OPS.has(d.t.item.op) && price !== null ? [this.lineEvent(d, price)] : [];
    return [...d.events.filter((e) => !replacedIds.has(e.id)), ...added];
  }

  /** A priced line a more specific scope hides; an end a more specific scope already prices past. */
  private isShadowed(d: Draft, oldScope: PriceScope | null, nextEventId: string | null): boolean {
    if (PRICED_OPS.has(d.t.item.op)) return nextEventId !== LINE_EVENT_ID;
    return d.t.item.op === "end_price" && oldScope !== null && SCOPE_RANK[oldScope] > SCOPE_RANK[d.t.scope];
  }

  /** The line as a visible event, to resolve what a Store sees after publish. */
  private lineEvent(d: Draft, price: string): ResolutionPriceEvent {
    return {
      id: LINE_EVENT_ID,
      tenantId: this.ctx.tenantId,
      priceBookId: this.ctx.book.id,
      scope: d.t.scope,
      priceZoneId: d.t.priceZoneId,
      storeId: d.t.storeId,
      productId: d.t.productId,
      sellUnit: SELL_UNIT,
      priceKind: "regular",
      price,
      ...d.bounds,
      publishedInRevision: this.ctx.headRevision,
      endedInRevision: null,
    };
  }

  /**
   * The price the line's scope target holds at `atMs` in `ref`'s zone (a helper's base, decisions
   * 515–517): its own layer, else the less specific ones (a Zone falls back to the Book; a Store
   * resolves fully).
   */
  private scopePrice(t: Target, events: readonly ResolutionPriceEvent[], ref: ValidationStore, atMs: number): string | null {
    if (t.scope === "store") {
      const data: ResolutionData = { book: this.ctx.book, memberships: this.membershipsOf(ref.id), events };
      const store: ResolutionStore = { id: ref.id, tenantId: this.ctx.tenantId, timezone: ref.timezone };
      return pricedOf(resolvePrice(t.productId, SELL_UNIT, store, new Date(atMs), this.ctx.headRevision, data)).price;
    }
    const layer = (scope: PriceScope, zoneId: string | null): string | null | "conflict" => {
      const hits = events.filter((e) => {
        if (e.scope !== scope || (scope === "zone" && e.priceZoneId !== zoneId)) return false;
        const i = eventInterval(e, ref.timezone);
        return i !== null && i.from <= atMs && (i.to === null || atMs < i.to);
      });
      return hits.length > 1 ? "conflict" : (hits[0]?.price ?? null);
    };
    const own = t.scope === "zone" ? layer("zone", t.priceZoneId) : layer("book", null);
    if (own !== null || t.scope === "book") return own === "conflict" ? null : own;
    const book = layer("book", null);
    return book === "conflict" ? null : book;
  }

  /** A later, published helper event this line changes the base of (§5, 518). */
  private invalidatesDependent(d: Draft, r: Reach): boolean {
    return d.events.some(
      (e) => this.ctx.helperEventIds.has(e.id) && SCOPE_RANK[e.scope as PriceScope] > SCOPE_RANK[d.t.scope] && this.changesBaseOf(d, r, e),
    );
  }

  /**
   * Whether the line changes the base of helper event `e` at Store `r` (review round 1, M3): `e`
   * serves the Store (its Store, or a Zone the Store is in at `e`'s start, the default Zone without
   * a membership), starts after the line takes effect there, and the price it inherits at its start
   * (the layers less specific than its own) differs before and after the line.
   */
  private changesBaseOf(d: Draft, r: Reach, e: ResolutionPriceEvent): boolean {
    if (e.scope === "store" && e.storeId !== r.store.id) return false;
    const ei = eventInterval(e, r.store.timezone);
    if (ei === null || ei.from <= r.fromMs || (r.interval.to !== null && ei.from >= r.interval.to)) return false;
    if (e.scope === "zone" && this.zoneAt(r.store.id, ei.from) !== e.priceZoneId) return false;
    const below = (events: readonly ResolutionPriceEvent[]): ResolutionPriceEvent[] =>
      events.filter((x) => SCOPE_RANK[x.scope as PriceScope] < SCOPE_RANK[e.scope as PriceScope]);
    const store: ResolutionStore = { id: r.store.id, tenantId: this.ctx.tenantId, timezone: r.store.timezone };
    const base = (events: ResolutionPriceEvent[]) =>
      pricedOf(resolvePrice(d.t.productId, SELL_UNIT, store, new Date(ei.from), this.ctx.headRevision, {
        book: this.ctx.book,
        memberships: this.membershipsOf(r.store.id),
        events,
      }));
    const before = base(below(d.events));
    const after = base(below(this.eventsAfter(d)));
    return before.eventId !== after.eventId || before.price !== after.price;
  }

  /** The Store's Zone at `ms` at the head: its one membership, else the default Zone; null when ambiguous. */
  private zoneAt(storeId: string, ms: number): string | null {
    const live = this.membershipsOf(storeId).filter((m) => overlaps(membershipInterval(m), { from: ms, to: ms + 1 }));
    if (live.length > 1) return null;
    return live[0]?.priceZoneId ?? this.ctx.book.defaultZoneId;
  }

  /** Whether a line of another validated, pending or approved set overlaps this one (same target and product). */
  private conflictsPending(t: Target, reached: readonly Reach[]): boolean {
    return (this.pendingByKey.get(keyOf(t)) ?? []).some((p) =>
      reached.some((r) => {
        const pi = intervalIn(p, r.store.timezone);
        return pi !== null && overlaps(pi, r.interval);
      }),
    );
  }
}

/**
 * Materializes, classifies and previews a set's items at the head revision. A refusal is a
 * `422` (`change_set_too_large`, `change_set_no_target_store`) and nothing is stored.
 */
export function validateChangeSet(ctx: ValidationContext, items: readonly PositionedItem[]): ValidationResult | ValidationRefusal {
  const v = new Validator(ctx);
  return v.run(() => v.validate(items));
}

/**
 * Review round 1, M2: the size refusal of a set, from a context with Stores, Zones, products and
 * memberships only (before the events are loaded): `MAX_LINES` lines or `MAX_PREVIEW_ROWS`
 * preview rows, or an item with no target. Null when the set is within budget.
 */
export function checkBudget(
  ctx: ValidationContext,
  items: readonly PositionedItem[],
  probe?: { reachComputations: number },
): ValidationRefusal | null {
  const v = new Validator(ctx);
  const result = v.run(() => v.budget(items));
  if (probe !== undefined) probe.reachComputations = v.reachComputations;
  return result;
}

/** A stored line as the target-Store recheck reads it (RT-1484 PR-10b). */
export interface StoredLineReach {
  readonly op: string;
  readonly scope: PriceScope;
  readonly priceZoneId: string | null;
  readonly storeId: string | null;
  readonly bounds: Bounds;
}

/**
 * RT-1484 PR-10b (spec 042 §3, Q-B8): the sorted target Stores the stored lines of a validated set
 * reach at the context's head, or null when a line no longer reaches what it was validated for. A
 * Store lifecycle change (create, delete, time-zone change) produces no revision, so `submit`,
 * `approve` and `publish` compare this set's hash with the stored `targetStoreSetHash`.
 */
export function currentTargetStores(ctx: ValidationContext, lines: readonly StoredLineReach[]): TargetStore[] | null {
  return new Validator(ctx).targetStoresOf(lines);
}

/** Every product, category and Store id the items name (lower case), for the loader. */
export function referencedIds(items: readonly PositionedItem[]): {
  readonly productIds: string[];
  readonly categoryIds: string[];
  readonly storeIds: string[];
} {
  const products = new Set<string>();
  const categories = new Set<string>();
  const stores = new Set<string>();
  for (const { item } of items) {
    if (item.op === "move_store_zone") {
      stores.add(lower(item.storeId));
      continue;
    }
    if (item.scope.kind === "stores") for (const s of item.scope.storeIds) stores.add(lower(s));
    if (item.products.kind === "items") for (const p of item.products.productIds) products.add(lower(p));
    else categories.add(lower(item.products.categoryId));
  }
  return { productIds: [...products], categoryIds: [...categories], storeIds: [...stores] };
}
