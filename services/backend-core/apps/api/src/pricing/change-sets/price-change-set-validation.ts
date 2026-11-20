/**
 * RT-1484 (RT-282 PR-10a, PR-4b) — the pure core of `validate` (spec 042 §4.3, §5, §6): it
 * materializes a set's items into lines, reaches each line's Stores, prices each (Store, line)
 * through the resolver (`../resolution`), classifies every line and builds the Impact Preview
 * with its summary, hashes and sensitivity. No I/O and no clock: the repository loads a
 * `ValidationContext` at the head revision and the service persists the result.
 *
 * Decisions (RT-1484 comments 17881 and 17882):
 *   - Head timeline only. Fan-out and old prices use the Pricing data visible at the tenant's head
 *     revision (§6); the set's own Zone moves do not count in v1.
 *   - Store reach. A `book` line reaches every live Store; a `stores` line its named Stores; a
 *     `zone` line every live Store whose membership visible at the head overlaps the line's
 *     interval in that Zone (a Store with no membership over part of it is in the Book's default
 *     Zone there). The Store's `effectiveFrom` is the later of the line's start and the
 *     membership's start, the line's start converted in the Store's time zone for `store_local`.
 *     A line that reaches no live Store refuses the whole set (`422 change_set_no_target_store`,
 *     naming the item's position), and so does an id the tenant does not have (a Store, Zone or
 *     product): nothing is stored.
 *   - Classes, most severe first: `invalid` (not representable, `price_not_positive`,
 *     `mixed_time_basis`, an ambiguous Zone membership, a product or Store that is not live),
 *     `past_dated`, `replaces`, `conflicts_pending`, `shadowed`, `invalidates_dependent`, `new`. A
 *     line takes the most severe class any of its Stores gives it; its preview rows carry it (0123
 *     ties a preview row's class to its line's), and each row's `messages` say which apply there.
 *   - Unchanged. A priced line is unchanged when an active event already holds the same key,
 *     scope target, price and time basis over an interval that covers the line's. It is dropped
 *     and counted in `summary.unchanged`. An `invalid` line is never dropped.
 *   - Helpers resolve from the price the scope target holds at the line's start (its own layer,
 *     else the less specific ones), read in the time zone of the line's first reached Store (by id)
 *     when the line is `store_local`.
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
import { sortTargetStores, targetStoreSetHash, type TargetStore } from "./price-change-set-hashes";
import { comparePrices, deltaPercent, helperPrice, isPositivePrice, normalizePrice } from "./price-change-set-money";
import { hashPreview, summarize } from "./price-change-set-summary";
import {
  INVALID_MESSAGES,
  MAX_LINES,
  mostSevere,
  noTarget,
  overlaps,
  RefusalError,
  sensitivityReasons,
  type LineClass,
  type MaterializedLine,
  type MembershipChange,
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
type PricedItem = Exclude<PriceChangeItem, { op: "move_store_zone" }>;
type MoveItem = Extract<PriceChangeItem, { op: "move_store_zone" }>;

/** A line's bounds in the event shape, so `eventInterval` converts them per Store. */
type Bounds = Pick<ResolutionPriceEvent, "timeBasis" | "effectiveFrom" | "effectiveTo" | "effectiveFromLocal" | "effectiveToLocal">;
type BoundsText = Pick<MaterializedLine, "timeBasis" | "effectiveFrom" | "effectiveTo" | "effectiveFromLocal" | "effectiveToLocal">;

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

/** A priced, ended or reset line while it is being classified. */
interface Draft {
  readonly t: Target;
  readonly bounds: Bounds;
  readonly reached: readonly Reach[];
  readonly events: readonly ResolutionPriceEvent[];
  readonly replaced: readonly ResolutionPriceEvent[];
  readonly newPrice: string | null;
  readonly roundedFrom: string | null;
  readonly messages: ReadonlySet<string>;
  readonly invalid: boolean;
}

const lower = (id: string): string => id.toLowerCase();
/** `2026-11-01T00:00` → `2026-11-01T00:00:00` (seconds always present). */
const withSeconds = (v: string): string => (v.length === 16 ? `${v}:00` : v);
/** A wall-clock value in the resolver's convention (a Date whose UTC fields are local). */
const wallClock = (v: string): Date => new Date(`${withSeconds(v)}Z`);

function boundsOf(item: PricedItem): { readonly bounds: Bounds; readonly text: BoundsText } {
  const basis = item.timeBasis ?? "store_local";
  const to = "effectiveTo" in item ? (item.effectiveTo ?? null) : null;
  if (basis === "absolute") {
    return {
      bounds: { timeBasis: basis, effectiveFrom: new Date(item.effectiveFrom), effectiveTo: to === null ? null : new Date(to), effectiveFromLocal: null, effectiveToLocal: null },
      text: { timeBasis: basis, effectiveFrom: item.effectiveFrom, effectiveTo: to, effectiveFromLocal: null, effectiveToLocal: null },
    };
  }
  return {
    bounds: { timeBasis: basis, effectiveFrom: null, effectiveTo: null, effectiveFromLocal: wallClock(item.effectiveFrom), effectiveToLocal: to === null ? null : wallClock(to) },
    text: { timeBasis: basis, effectiveFrom: null, effectiveTo: null, effectiveFromLocal: withSeconds(item.effectiveFrom), effectiveToLocal: to === null ? null : withSeconds(to) },
  };
}

/** Bounds (or a pending line) as instants in `zone`; null when they have no usable start. */
const intervalIn = (b: Bounds, zone: string): Interval | null => eventInterval(b as ResolutionPriceEvent, zone);

/** Whether `outer` covers `inner` (both raw: same time basis). */
function covers(outer: Interval, inner: Interval): boolean {
  return outer.from <= inner.from && (outer.to === null || (inner.to !== null && outer.to >= inner.to));
}

/** The raw interval of same-basis bounds (absolute ms, or wall-clock ms for store_local). */
function rawInterval(b: Bounds): Interval | null {
  const from = b.timeBasis === "store_local" ? b.effectiveFromLocal : b.effectiveFrom;
  const to = b.timeBasis === "store_local" ? b.effectiveToLocal : b.effectiveTo;
  return from === null ? null : { from: from.getTime(), to: to?.getTime() ?? null };
}

/** The interval clipped to `within`, or null when they do not meet. */
function clip(i: Interval, within: Interval): Interval | null {
  const from = Math.max(i.from, within.from);
  const to = i.to === null ? within.to : within.to === null ? i.to : Math.min(i.to, within.to);
  return to !== null && to <= from ? null : { from, to };
}

/**
 * The first instant of `interval` not covered by `own` (sorted, non-overlapping memberships
 * clipped to it): where the Store falls back to the default Zone; null when they cover it all.
 */
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

const unique = (values: readonly string[]): string[] => values.filter((v, k) => values.indexOf(v) === k);

function appendTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

class Validator {
  private readonly eventsByProduct = new Map<string, ResolutionPriceEvent[]>();
  private readonly membershipsByStore = new Map<string, ResolutionZoneMembership[]>();
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
    this.minorUnit = minorUnitExponent(ctx.book.currencyCode) ?? -1;
  }

  run(items: readonly PositionedItem[]): ValidationResult | ValidationRefusal {
    try {
      return this.validate(items);
    } catch (err) {
      if (err instanceof RefusalError) return { ok: false, code: err.code, message: err.message };
      throw err;
    }
  }

  private validate(items: readonly PositionedItem[]): ValidationResult {
    const entries = this.materialize(items);
    const lines: MaterializedLine[] = [];
    const rows: Omit<PreviewRow, "rowNo">[] = [];
    const membershipChanges: MembershipChange[] = [];
    let unchanged = 0;
    for (const entry of entries) {
      const lineNo = lines.length + 1;
      if ("move" in entry) {
        const { line, change } = materializeMove(this.ctx, this.membershipsOf(lower(entry.move.storeId)), lineNo, entry.position, entry.move);
        lines.push(line);
        membershipChanges.push(change);
        continue;
      }
      const priced = this.pricedLine(lineNo, entry.target);
      if (priced === null) unchanged += 1;
      else {
        lines.push(priced.line);
        rows.push(...priced.rows);
      }
    }
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

  // ---- materialization ----------------------------------------------------

  /** Every line before classification, in item order (a move keeps its item's place); 422 over the limit. */
  private materialize(items: readonly PositionedItem[]): ({ position: number; target: Target } | { position: number; move: MoveItem })[] {
    const out: ({ position: number; target: Target } | { position: number; move: MoveItem })[] = [];
    for (const { position, item } of items) {
      if (item.op === "move_store_zone") out.push({ position, move: item });
      else for (const target of this.targetsOf(position, item)) out.push({ position, target });
      if (out.length > MAX_LINES) {
        throw new RefusalError("change_set_too_large", `The Change Set materializes more than ${MAX_LINES} lines; split it.`);
      }
    }
    return out;
  }

  private store(id: string): ValidationStore {
    const s = this.ctx.stores.get(id);
    if (s === undefined) throw new Error(`store ${id} not loaded`);
    return s;
  }

  private membershipsOf(storeId: string): ResolutionZoneMembership[] {
    return this.membershipsByStore.get(storeId) ?? [];
  }

  /** The (scope target, product) lines of one priced, ended or reset item (§4.3); ids in lower case. */
  private targetsOf(position: number, item: PricedItem): Target[] {
    const products = this.productsOf(position, item.products);
    const scopes: { scope: PriceScope; priceZoneId: string | null; storeId: string | null }[] = [];
    if (item.scope.kind === "book") scopes.push({ scope: "book", priceZoneId: null, storeId: null });
    else if (item.scope.kind === "zone") {
      const zoneId = lower(item.scope.zoneId);
      if (!this.ctx.zones.has(zoneId)) throw noTarget(position, "names a Zone that is not in the tenant's Price Book, so it reaches no live Store");
      scopes.push({ scope: "zone", priceZoneId: zoneId, storeId: null });
    } else {
      for (const storeId of item.scope.storeIds.map(lower)) {
        if (!this.ctx.stores.has(storeId)) throw noTarget(position, "names a Store that is not the tenant's, so it reaches no live Store");
        scopes.push({ scope: "store", priceZoneId: null, storeId });
      }
    }
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

  /** The Stores a line reaches, in id order, and its activation instant in each (comment 17882). */
  private reach(t: Target, bounds: Bounds): Reach[] {
    if (t.scope === "store") {
      const store = this.store(t.storeId!);
      const interval = intervalIn(bounds, store.timezone)!;
      return [{ store, fromMs: interval.from, interval, messages: store.live ? [] : ["store_not_live"] }];
    }
    const out: Reach[] = [];
    for (const store of this.ctx.stores.values()) {
      if (!store.live) continue;
      const interval = intervalIn(bounds, store.timezone)!;
      const reached = t.scope === "book" ? { store, fromMs: interval.from, interval, messages: [] } : this.zoneReach(store, t.priceZoneId!, interval);
      if (reached !== null) out.push(reached);
    }
    return out.sort((x, y) => compareCodeUnits(x.store.id, y.store.id));
  }

  /** Whether `store` is in `zoneId` during part of `interval`, and from when. */
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
  private pricedLine(lineNo: number, t: Target): { line: MaterializedLine; rows: Omit<PreviewRow, "rowNo">[] } | null {
    const draft = this.draft(t);
    if (this.isUnchanged(draft)) return null;
    const flags = new Set<LineClass>();
    const rows = draft.reached.map((r) => this.storeRow(lineNo, draft, r, flags));
    if (draft.invalid) flags.add("invalid");
    if (draft.replaced.length > 0) flags.add("replaces");
    if (!draft.invalid && this.conflictsPending(t, draft.reached)) flags.add("conflicts_pending");
    const cls = mostSevere(flags);
    const roundedFrom = draft.invalid ? null : draft.roundedFrom;
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
      newPrice: PRICED_OPS.has(t.item.op) ? draft.newPrice : null,
      roundedFrom,
      class: cls,
      messages: [...draft.messages].sort(compareCodeUnits),
      replacedIds: draft.replaced.map((e) => e.id).sort(compareCodeUnits),
    };
    return { line, rows: rows.map((row) => ({ ...row, class: cls, roundedFrom })) };
  }

  /** Reach, price, what it replaces and the line-level messages. */
  private draft(t: Target): Draft {
    const { bounds } = boundsOf(t.item);
    const reached = this.reach(t, bounds);
    if (reached.length === 0) throw noTarget(t.position, "reaches no live Store");
    const events = this.eventsByProduct.get(t.productId) ?? [];
    const messages = new Set<string>();
    if (!(this.ctx.products.get(t.productId)?.live ?? false)) messages.add("product_not_live");
    const { newPrice, roundedFrom } = this.linePrice(t, events, reached[0]!, messages);
    // The same-target events it replaces (priced) or ends (end, reset), in any reached Store.
    const replaced = events.filter(
      (e) => sameTarget(e, t) && reached.some((r) => {
        const ei = eventInterval(e, r.store.timezone);
        return ei !== null && overlaps(ei, r.interval);
      }),
    );
    if (replaced.some((e) => e.timeBasis !== bounds.timeBasis)) messages.add("mixed_time_basis");
    for (const r of reached) for (const m of r.messages) messages.add(m);
    if (!PRICED_OPS.has(t.item.op) && replaced.length === 0) messages.add("nothing_to_end");
    const invalid = [...messages].some((m) => INVALID_MESSAGES.has(m));
    return { t, bounds, reached, events, replaced, newPrice, roundedFrom, messages, invalid };
  }

  /** The concrete price of a priced line (a helper's from its base, decisions 515–517); adds its findings. */
  private linePrice(t: Target, events: readonly ResolutionPriceEvent[], ref: Reach, messages: Set<string>): { newPrice: string | null; roundedFrom: string | null } {
    const item = t.item;
    if (item.op === "set_price") {
      const normalized = normalizePrice(item.price);
      if (normalized === null || !isPositivePrice(normalized)) {
        messages.add("price_not_positive");
        return { newPrice: null, roundedFrom: null };
      }
      if (representablePrice(normalized, this.ctx.book.currencyCode) === null) messages.add("price_not_representable");
      return { newPrice: normalized, roundedFrom: null };
    }
    if (item.op !== "adjust_amount" && item.op !== "adjust_percent") return { newPrice: null, roundedFrom: null };
    const base = this.scopePrice(t, events, ref.store, ref.fromMs);
    if (base === null) {
      messages.add("no_base_price");
      return { newPrice: null, roundedFrom: null };
    }
    const r = helperPrice(base, item.op === "adjust_amount" ? { amount: item.amount } : { percent: item.percent }, this.minorUnit);
    if (r.kind !== "price") {
      messages.add(r.kind === "not_positive" ? "price_not_positive" : "price_not_representable");
      return { newPrice: null, roundedFrom: null };
    }
    if (r.roundedFrom !== null) messages.add("rounded_price");
    return { newPrice: r.price, roundedFrom: r.roundedFrom };
  }

  /** Unchanged: an active event of the same target, price and basis already covers the line. */
  private isUnchanged(d: Draft): boolean {
    if (d.invalid || !PRICED_OPS.has(d.t.item.op) || d.newPrice === null) return false;
    const raw = rawInterval(d.bounds)!;
    return d.replaced.some((e) => {
      const ei = rawInterval(e);
      return e.timeBasis === d.bounds.timeBasis && ei !== null && covers(ei, raw) && comparePrices(e.price, d.newPrice!) === 0;
    });
  }

  /** One Store's preview row: old and new resolution, shadowing, dependents and past dating. */
  private storeRow(lineNo: number, d: Draft, r: Reach, flags: Set<LineClass>): Omit<PreviewRow, "rowNo"> {
    const store: ResolutionStore = { id: r.store.id, tenantId: this.ctx.tenantId, timezone: r.store.timezone };
    const at = new Date(r.fromMs);
    const data: ResolutionData = { book: this.ctx.book, memberships: this.membershipsOf(r.store.id), events: d.events };
    const old = pricedOf(resolvePrice(d.t.productId, SELL_UNIT, store, at, this.ctx.headRevision, data));
    const rowMessages = new Set([...d.messages, ...r.messages]);
    const next = d.invalid ? pricedOf({ status: "unpriced", reason: "no_price" }) : this.simulate(d, store, at, data);
    const found: LineClass[] = [];
    if (!d.invalid && this.isShadowed(d, old.scope, next.eventId)) found.push("shadowed");
    if (!d.invalid && this.invalidatesDependent(d.t, d.events, r)) found.push("invalidates_dependent");
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
      roundedFrom: d.roundedFrom,
      effectiveFromMs: r.fromMs,
      effectiveFrom: formatInstantInZone(at, r.store.timezone),
      class: "new",
      devices: this.ctx.devices.get(r.store.id) ?? 0,
      messages: unique([...rowMessages]),
    };
  }

  /** What the Store resolves after publish: the replaced events gone, the line's event added. */
  private simulate(d: Draft, store: ResolutionStore, at: Date, data: ResolutionData): ReturnType<typeof pricedOf> {
    const replacedIds = new Set(d.replaced.map((e) => e.id));
    const added = PRICED_OPS.has(d.t.item.op) && d.newPrice !== null ? [this.lineEvent(d, d.newPrice)] : [];
    const events = [...d.events.filter((e) => !replacedIds.has(e.id)), ...added];
    return pricedOf(resolvePrice(d.t.productId, SELL_UNIT, store, at, this.ctx.headRevision, { ...data, events }));
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
   * The price the line's scope target holds at `atMs` (a helper's base, decisions 515–517): its own
   * layer, else the less specific ones (a Zone falls back to the Book; a Store resolves fully).
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
  private invalidatesDependent(t: Target, events: readonly ResolutionPriceEvent[], r: Reach): boolean {
    return events.some((e) => {
      if (!this.ctx.helperEventIds.has(e.id) || SCOPE_RANK[e.scope as PriceScope] <= SCOPE_RANK[t.scope]) return false;
      if ((e.scope === "store" && e.storeId !== r.store.id) || (e.scope === "zone" && t.scope === "zone")) return false;
      const ei = eventInterval(e, r.store.timezone);
      return ei !== null && ei.from > r.interval.from && (r.interval.to === null || ei.from < r.interval.to);
    });
  }

  /** Whether a line of another validated, pending or approved set overlaps this one (same target and product). */
  private conflictsPending(t: Target, reached: readonly Reach[]): boolean {
    return this.ctx.pendingLines.some((p) => {
      if (p.op === "move_store_zone" || p.productId !== t.productId || !sameTarget(p, t)) return false;
      return reached.some((r) => {
        const pi = intervalIn(p, r.store.timezone);
        return pi !== null && overlaps(pi, r.interval);
      });
    });
  }
}

/**
 * Materializes, classifies and previews a set's items at the head revision. A refusal is a
 * `422` (`change_set_too_large`, `change_set_no_target_store`) and nothing is stored.
 */
export function validateChangeSet(ctx: ValidationContext, items: readonly PositionedItem[]): ValidationResult | ValidationRefusal {
  return new Validator(ctx).run(items);
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
