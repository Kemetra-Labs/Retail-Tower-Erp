/**
 * RT-1484 (RT-282 PR-10a, PR-4b) — the inputs and outputs of the pure `validate` engine
 * (`price-change-set-validation.ts`): what the repository loads at the head revision, and the 0123
 * rows (lines, preview rows, membership changes) with the preview summary it produces.
 */
import type { Interval } from "../resolution/resolve";
import type { PriceScope, ResolutionPriceBook, ResolutionPriceEvent, ResolutionZoneMembership } from "../resolution/types";
import type { TargetStore } from "./price-change-set-hashes";
import type { PriceChangeItem } from "./price-change-sets.dto";

export type ChangeSetKindForValidation = "standard" | "emergency" | "rollback" | "legacy_import";

/** A Store of the tenant: every live one, plus any a `stores` selector or a move names. */
interface ValidationStore {
  readonly id: string;
  readonly timezone: string;
  readonly live: boolean;
}

/** A line of another set that is `validated`, `pending_approval` or `approved` (for `conflicts_pending`). */
export interface PendingLine {
  readonly changeSetId: string;
  readonly op: string;
  readonly scope: PriceScope;
  readonly priceZoneId: string | null;
  readonly storeId: string | null;
  readonly productId: string | null;
  readonly timeBasis: "store_local" | "absolute";
  readonly effectiveFrom: Date | null;
  readonly effectiveTo: Date | null;
  readonly effectiveFromLocal: Date | null;
  readonly effectiveToLocal: Date | null;
}

/** Everything `validate` reads, at the head revision. */
export interface ValidationContext {
  readonly tenantId: string;
  readonly kind: ChangeSetKindForValidation;
  readonly nowMs: number;
  /** The tenant's head revision; 0 before its first publish (nothing visible). */
  readonly headRevision: number;
  readonly book: ResolutionPriceBook;
  /** Ids of the Book's Zones (lower case), with whether each is live (not retired). */
  readonly zones: ReadonlyMap<string, { readonly live: boolean }>;
  readonly stores: ReadonlyMap<string, ValidationStore>;
  /** Products the items name or their categories hold, with whether each is live. */
  readonly products: ReadonlyMap<string, { readonly live: boolean }>;
  /** The live products of each category an item names (frozen at validation, §4.3). */
  readonly categoryProducts: ReadonlyMap<string, readonly string[]>;
  /** The Book's Zone memberships visible at the head. */
  readonly memberships: readonly ResolutionZoneMembership[];
  /** The `regular` events of the involved products visible at the head. */
  readonly events: readonly ResolutionPriceEvent[];
  readonly pendingLines: readonly PendingLine[];
  /** Visible events a helper line published (`invalidates_dependent`). */
  readonly helperEventIds: ReadonlySet<string>;
  /** Active (not retired) devices per Store. */
  readonly devices: ReadonlyMap<string, number>;
}

/** An authored item and its 1-based position in the item list. */
export interface PositionedItem {
  readonly position: number;
  readonly item: PriceChangeItem;
}

export type LineClass =
  | "new"
  | "replaces"
  | "conflicts_pending"
  | "shadowed"
  | "invalidates_dependent"
  | "past_dated"
  | "invalid";

/** Most severe first (RT-1484 comment 17882, decision 3). */
export const CLASS_SEVERITY: readonly LineClass[] = [
  "invalid",
  "past_dated",
  "replaces",
  "conflicts_pending",
  "shadowed",
  "invalidates_dependent",
  "new",
];

/** A `price_change_set_lines` row. */
export interface MaterializedLine {
  readonly lineNo: number;
  readonly itemPosition: number;
  readonly op: PriceChangeItem["op"];
  readonly scope: PriceScope;
  readonly priceZoneId: string | null;
  readonly storeId: string | null;
  readonly productId: string | null;
  readonly sellUnit: "each" | null;
  readonly timeBasis: "store_local" | "absolute";
  /** RFC 3339 instant as authored (absolute), else null. */
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  /** `YYYY-MM-DDTHH:MM:SS` wall clock (store_local), else null. */
  readonly effectiveFromLocal: string | null;
  readonly effectiveToLocal: string | null;
  readonly newPrice: string | null;
  readonly roundedFrom: string | null;
  readonly class: LineClass;
  readonly messages: readonly string[];
  readonly replacedIds: readonly string[];
}

/** A `price_change_set_preview_lines` row (`PreviewLine`). */
export interface PreviewRow {
  readonly lineNo: number;
  readonly rowNo: number;
  readonly storeId: string;
  readonly productId: string;
  readonly sellUnit: "each";
  readonly oldPrice: string | null;
  readonly oldSourceScope: PriceScope | null;
  readonly newPrice: string | null;
  readonly newSourceScope: PriceScope | null;
  readonly deltaPct: string | null;
  readonly roundedFrom: string | null;
  readonly effectiveFromMs: number;
  /** RFC 3339 in the Store's time zone. */
  readonly effectiveFrom: string;
  readonly class: LineClass;
  readonly devices: number;
  readonly messages: readonly string[];
}

/** A `price_change_set_preview_memberships` row (`PreviewMembershipChange`). */
export interface MembershipChange {
  readonly lineNo: number;
  readonly storeId: string;
  readonly fromZoneId: string | null;
  readonly toZoneId: string;
  /** RFC 3339 as authored (absolute). */
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly supersededMembershipIds: readonly string[];
}

export interface PreviewSummary {
  readonly lines: number;
  readonly stores: number;
  readonly devices: number;
  readonly products: number;
  readonly increases: number;
  readonly decreases: number;
  readonly unchanged: number;
  readonly maxIncreasePct: string | null;
  readonly maxDecreasePct: string | null;
  readonly earliestEffectiveAt: string | null;
  readonly findings: {
    readonly replaces: number;
    readonly shadowed: number;
    readonly invalidates_dependent: number;
    readonly conflicts_pending: number;
    readonly past_dated: number;
    readonly invalid: number;
  };
  readonly blocking: boolean;
}

type SensitivityReason =
  | "approval_mode_always"
  | "delta_threshold"
  | "store_threshold"
  | "zone_move"
  | "past_dated"
  | "rollback"
  | "emergency";

export interface ValidationResult {
  readonly ok: true;
  readonly lines: readonly MaterializedLine[];
  readonly previewRows: readonly PreviewRow[];
  readonly membershipChanges: readonly MembershipChange[];
  readonly targetStores: readonly TargetStore[];
  readonly summary: PreviewSummary;
  readonly targetStoreSetHash: string;
  readonly previewHash: string;
  readonly sensitive: boolean;
  readonly sensitivityReasons: readonly SensitivityReason[];
  /** Every per-Store effective instant (preview rows and moves), for the lead-time rule. */
  readonly effectiveMs: readonly number[];
}

export interface ValidationRefusal {
  readonly ok: false;
  readonly code: "change_set_too_large" | "change_set_no_target_store";
  readonly message: string;
}

/** Q-B6: at most 50 000 materialized lines per set. */
export const MAX_LINES = 50_000;

/**
 * Review round 1, M2 (lead decision): at most 200 000 preview rows (the sum over lines of the
 * Stores each reaches), checked before the events are loaded; over it is `422
 * change_set_too_large`. It bounds one validate's work while it holds the set's row lock.
 */
export const MAX_PREVIEW_ROWS = 200_000;

/** Thrown inside the engine and returned as a `ValidationRefusal` (a 422; nothing is stored). */
export class RefusalError extends Error {
  constructor(
    readonly code: ValidationRefusal["code"],
    message: string,
  ) {
    super(message);
    this.name = "RefusalError";
  }
}

/** `422 change_set_no_target_store`, naming the item's position (RT-1484 comment 17882, decision 1). */
export function noTarget(position: number, why: string): RefusalError {
  return new RefusalError("change_set_no_target_store", `Item ${position} ${why}.`);
}

/** Messages that make a line `invalid` (spec 042 §5). */
export const INVALID_MESSAGES: ReadonlySet<string> = new Set([
  "price_not_positive",
  "price_not_representable",
  "no_base_price",
  "mixed_time_basis",
  "ambiguous_zone_membership",
  "product_not_live",
  "store_not_live",
  "zone_not_live",
  // A store_local line whose bounds fall in one DST gap: an empty interval at that Store.
  "empty_interval",
  // Review round 1 (lead decisions M1, m2): a set that contradicts itself, an end that ends nothing.
  "overlaps_line_in_set",
  "nothing_to_end",
  // Round 3, MAJOR-2: one line, one published price; its Stores' helper bases must agree.
  "helper_base_varies_by_store",
]);

/** A line that blocks submit: `invalid`, or `past_dated` outside the emergency path (0123 also exempts rollback). */
export function isBlocking(cls: LineClass, kind: ChangeSetKindForValidation): boolean {
  return cls === "invalid" || (cls === "past_dated" && kind !== "emergency" && kind !== "rollback");
}

/** The most severe class among `flags`, else `new`. */
export function mostSevere(flags: ReadonlySet<LineClass>): LineClass {
  return CLASS_SEVERITY.find((c) => flags.has(c)) ?? "new";
}

/** Whether two intervals share an instant. */
export function overlaps(a: Interval, b: Interval): boolean {
  return (a.to === null || b.from < a.to) && (b.to === null || a.from < b.to);
}

/** §7 with the v1 approval mode `always` (Q-B1): always sensitive, with every reason that applies. */
export function sensitivityReasons(lines: readonly MaterializedLine[], kind: ChangeSetKindForValidation): SensitivityReason[] {
  const reasons: SensitivityReason[] = ["approval_mode_always"];
  if (lines.some((l) => l.op === "move_store_zone")) reasons.push("zone_move");
  if (lines.some((l) => l.class === "past_dated")) reasons.push("past_dated");
  if (kind === "rollback") reasons.push("rollback");
  if (kind === "emergency") reasons.push("emergency");
  return reasons;
}
