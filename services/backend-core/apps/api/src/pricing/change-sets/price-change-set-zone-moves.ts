/**
 * RT-1484 (RT-282 PR-10a, PR-4b) — a `move_store_zone` item as a line and its
 * `PreviewMembershipChange` (spec 042 §4.2, §6; data-model §2.3). Pure.
 *
 * A move names one Store and its new Zone over absolute bounds. It supersedes the Store's
 * memberships visible at the head that overlap it; its `fromZoneId` is the Zone of the membership
 * covering its start (null: the default-Zone fallback). Classes: `invalid` (the Store or Zone is
 * not live, or the Store's membership at the start is ambiguous), `past_dated`, `replaces` (it
 * supersedes a membership), `conflicts_pending` (another pending set moves the same Store over an
 * overlapping interval), else `new`. A Store or Zone the tenant does not have is the `422`.
 */
import { compareCodeUnits } from "../../common/compare-code-units";
import { membershipInterval, type Interval } from "../resolution/resolve";
import type { ResolutionZoneMembership } from "../resolution/types";
import type { PriceChangeItem } from "./price-change-sets.dto";
import {
  INVALID_MESSAGES,
  mostSevere,
  noTarget,
  overlaps,
  type LineClass,
  type MaterializedLine,
  type MembershipChange,
  type PendingLine,
  type ValidationContext,
} from "./price-change-set-validation.types";

type MoveItem = Extract<PriceChangeItem, { op: "move_store_zone" }>;

function moveMessages(ctx: ValidationContext, storeId: string, zoneId: string, atStart: number): Set<string> {
  const messages = new Set<string>();
  if (!(ctx.stores.get(storeId)?.live ?? false)) messages.add("store_not_live");
  if (!(ctx.zones.get(zoneId)?.live ?? false)) messages.add("zone_not_live");
  if (atStart > 1) messages.add("ambiguous_zone_membership");
  return messages;
}

function pendingMove(pending: readonly PendingLine[], interval: Interval): boolean {
  return pending.some(
    (p) => p.effectiveFrom !== null && overlaps({ from: p.effectiveFrom.getTime(), to: p.effectiveTo?.getTime() ?? null }, interval),
  );
}

/**
 * The move's line and membership change. `memberships` are the Store's, visible at the head;
 * `pending` the moves of the same Store in other validated, pending or approved sets; `inSet` the
 * findings of overlaps with other lines of this set (review round 1, M1).
 */
export function materializeMove(
  ctx: ValidationContext,
  scope: { readonly memberships: readonly ResolutionZoneMembership[]; readonly pending: readonly PendingLine[]; readonly inSet: readonly string[] },
  lineNo: number,
  position: number,
  item: MoveItem,
): { line: MaterializedLine; change: MembershipChange } {
  const { memberships } = scope;
  const storeId = item.storeId.toLowerCase();
  const zoneId = item.zoneId.toLowerCase();
  if (!ctx.stores.has(storeId)) throw noTarget(position, "moves a Store that is not the tenant's, so it reaches no live Store");
  if (!ctx.zones.has(zoneId)) throw noTarget(position, "names a Zone that is not in the tenant's Price Book, so it reaches no live Store");
  const from = Date.parse(item.effectiveFrom);
  const interval: Interval = { from, to: item.effectiveTo === undefined ? null : Date.parse(item.effectiveTo) };
  const superseded = memberships.filter((m) => overlaps(membershipInterval(m), interval));
  const atStart = memberships.filter((m) => overlaps(membershipInterval(m), { from, to: from + 1 }));
  const messages = moveMessages(ctx, storeId, zoneId, atStart.length);
  for (const m of scope.inSet) messages.add(m);
  const flags = new Set<LineClass>();
  if ([...messages].some((m) => INVALID_MESSAGES.has(m))) flags.add("invalid");
  if (from < ctx.nowMs) flags.add("past_dated");
  if (superseded.length > 0) flags.add("replaces");
  if (pendingMove(scope.pending, interval)) flags.add("conflicts_pending");
  const ids = superseded.map((m) => m.id).sort(compareCodeUnits);
  const effectiveTo = item.effectiveTo ?? null;
  return {
    line: {
      lineNo,
      itemPosition: position,
      op: "move_store_zone",
      scope: "store",
      priceZoneId: zoneId,
      storeId,
      productId: null,
      sellUnit: null,
      timeBasis: "absolute",
      effectiveFrom: item.effectiveFrom,
      effectiveTo,
      effectiveFromLocal: null,
      effectiveToLocal: null,
      newPrice: null,
      roundedFrom: null,
      class: mostSevere(flags),
      messages: [...messages].sort(compareCodeUnits),
      replacedIds: ids,
    },
    change: {
      lineNo,
      storeId,
      fromZoneId: atStart.length === 1 ? atStart[0]!.priceZoneId : null,
      toZoneId: zoneId,
      effectiveFrom: item.effectiveFrom,
      effectiveTo,
      supersededMembershipIds: ids,
    },
  };
}
