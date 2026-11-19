/**
 * RT-1484 (RT-282 PR-09a) — wire projections, the zone-stores keyset cursor and the service
 * errors of `pricing/price-structure.yaml` 1.0.0-draft. Pure: the unit spec drives them with rows.
 *
 * No projection carries `tenant_id`, `correlation_id` or `retired_by_user_id` (not in the
 * contract schemas, which are `additionalProperties: false`).
 */
import { z } from "zod";

import { decodeOpaque, encodeOpaque, InvalidCursorError, isCalendarInstant } from "../../common/cursor/opaque-cursor";

// ---------------------------------------------------------------------------
// Errors (mapped to HTTP by the controller)
// ---------------------------------------------------------------------------

/** A Book, Zone or Store of another tenant, out of scope or absent → the non-disclosing 404. */
export class PriceStructureNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "PriceStructureNotFoundError";
  }
}

export type PriceStructureConflictCode =
  | "price_book_exists"
  | "price_book_code_taken"
  | "price_book_retired"
  | "price_zone_code_taken"
  | "default_price_zone_immutable"
  | "price_zone_in_use"
  | "price_zone_retired";

/** A 409 of the contract's conflict lists; nothing was written. */
export class PriceStructureConflictError extends Error {
  constructor(readonly code: PriceStructureConflictCode) {
    super(code);
    this.name = "PriceStructureConflictError";
  }
}

/** 422 `pricing_revision_unknown`, shared with price inquiry (`../pricing-revision`). */
export { PricingRevisionUnknownError } from "../pricing-revision";

/** A zone-stores cursor this operation did not issue, or a continuation that changes its `at` / revision → 400. */
export class ZoneStoresCursorError extends InvalidCursorError {
  constructor(message?: string) {
    super(message);
    this.name = "ZoneStoresCursorError";
  }
}

// ---------------------------------------------------------------------------
// Rows and bodies
// ---------------------------------------------------------------------------

interface ActorBody {
  readonly userId: string;
  readonly at: string;
}

export interface PriceZoneRow {
  id: string;
  price_book_id: string;
  code: string;
  name: string;
  is_default: boolean;
  retired_at: Date | null;
  retire_reason: string | null;
  created_by_user_id: string;
  created_at: Date;
}

export interface PriceZoneBody {
  readonly id: string;
  readonly priceBookId: string;
  readonly code: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly retiredAt: string | null;
  readonly retireReason: string | null;
  readonly created: ActorBody;
}

export interface PriceBookRow {
  id: string;
  code: string;
  name: string;
  currency_code: string;
  tax_price_basis: "inclusive" | "exclusive";
  pricing_context: "retail";
  is_default: boolean;
  retired_at: Date | null;
  created_by_user_id: string;
  created_at: Date;
}

export interface PriceBookBody {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly currencyCode: string;
  readonly taxPriceBasis: "inclusive" | "exclusive";
  readonly pricingContext: "retail";
  readonly isDefault: boolean;
  readonly retiredAt: string | null;
  readonly created: ActorBody;
  readonly defaultZone: PriceZoneBody;
}

export function toPriceZoneBody(row: PriceZoneRow): PriceZoneBody {
  return {
    id: row.id,
    priceBookId: row.price_book_id,
    code: row.code,
    name: row.name,
    isDefault: row.is_default,
    retiredAt: row.retired_at === null ? null : row.retired_at.toISOString(),
    retireReason: row.retire_reason,
    created: { userId: row.created_by_user_id, at: row.created_at.toISOString() },
  };
}

export function toPriceBookBody(row: PriceBookRow, defaultZone: PriceZoneRow): PriceBookBody {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    // CHAR(3) never pads a 3-letter code, but trim defensively.
    currencyCode: row.currency_code.trim(),
    taxPriceBasis: row.tax_price_basis,
    pricingContext: row.pricing_context,
    isDefault: row.is_default,
    retiredAt: row.retired_at === null ? null : row.retired_at.toISOString(),
    created: { userId: row.created_by_user_id, at: row.created_at.toISOString() },
    defaultZone: toPriceZoneBody(defaultZone),
  };
}

export interface PriceZoneMembershipRow {
  id: string;
  price_zone_id: string;
  effective_from: Date;
  effective_to: Date | null;
  published_in_revision: string;
  carried_forward: boolean;
}

export interface PriceZoneMembershipBody {
  readonly id: string;
  readonly priceZoneId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly publishedInRevision: number;
  readonly carriedForward: boolean;
}

export function toMembershipBody(row: PriceZoneMembershipRow): PriceZoneMembershipBody {
  return {
    id: row.id,
    priceZoneId: row.price_zone_id,
    effectiveFrom: row.effective_from.toISOString(),
    effectiveTo: row.effective_to === null ? null : row.effective_to.toISOString(),
    publishedInRevision: Number(row.published_in_revision),
    carriedForward: row.carried_forward,
  };
}

export interface PriceZoneStoreBody {
  readonly storeId: string;
  readonly membership: "explicit" | "default";
  readonly membershipId: string | null;
}

export interface PriceZoneStorePageBody {
  readonly zoneId: string;
  readonly evaluatedAt: string;
  readonly asOfRevision: number | null;
  readonly items: readonly PriceZoneStoreBody[];
  readonly nextCursor: string | null;
}

export interface StorePriceZoneMembershipsBody {
  readonly storeId: string;
  readonly priceBookId: string | null;
  readonly defaultZoneId: string | null;
  readonly asOfRevision: number | null;
  readonly items: readonly PriceZoneMembershipBody[];
}

// ---------------------------------------------------------------------------
// The zone-stores cursor
// ---------------------------------------------------------------------------

/**
 * The continuation of `consoleListPriceZoneStores`: the Zone it pages, the evaluation the first
 * page fixed (`at`, canonical UTC with microseconds, and the revision, null before the first
 * one) and the last Store id served.
 */
export interface ZoneStoresCursor {
  readonly zoneId: string;
  readonly at: string;
  readonly revision: number | null;
  readonly after: string;
}

const CursorPayloadSchema = z
  .object({
    v: z.literal(1),
    z: z.string().uuid(),
    at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    r: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
    k: z.string().uuid(),
  })
  .strict();

export function encodeZoneStoresCursor(cursor: ZoneStoresCursor): string {
  return encodeOpaque({ v: 1, z: cursor.zoneId, at: cursor.at, r: cursor.revision, k: cursor.after });
}

/** The cursor's payload, bound to `zoneId`; anything else is a `ZoneStoresCursorError`. */
export function decodeZoneStoresCursor(raw: string, zoneId: string): ZoneStoresCursor {
  const p = decodeOpaque(raw, CursorPayloadSchema, () => new ZoneStoresCursorError());
  if (p.z.toLowerCase() !== zoneId.toLowerCase() || !isCalendarInstant(p.at)) throw new ZoneStoresCursorError();
  return { zoneId: p.z, at: p.at, revision: p.r, after: p.k };
}
