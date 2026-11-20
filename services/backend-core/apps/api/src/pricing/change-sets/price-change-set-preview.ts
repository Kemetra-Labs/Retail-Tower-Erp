/**
 * RT-1484 (RT-282 PR-10a, PR-4b) — `consoleGetPriceChangeSetPreview`: the Impact Preview stored by
 * the last `validate` (spec 042 §6), its keyset cursor and its wire projection
 * (`PriceChangeSetPreview`, `PreviewLine`, `PreviewMembershipChange`).
 *
 * Rows are served in `row_no` order, which `validate` assigned in the contract's page order
 * (storeId, productId, sellUnit, effectiveFrom). The cursor carries the last `row_no` served, the
 * `class` filter and the `previewHash` it was issued for, so a cursor of another filter or of an
 * earlier validation is 400. Instants are written in the Store's time zone as recorded at
 * validation (`target_stores`, Q-B8).
 */
import { z } from "zod";
import type { PoolClient } from "pg";

import { decodeOpaque, encodeOpaque } from "../../common/cursor/opaque-cursor";
import { formatInstantInZone } from "../resolution/store-local-time";
import { ChangeSetListCursorError } from "./price-change-sets.projections";
import type { LineClass, PreviewSummary } from "./price-change-set-validation.types";

type Queryable = Pick<PoolClient, "query">;

/** A preview cursor this operation did not issue for this preview and filter → 400 `validation_error`. */
export class PreviewCursorError extends ChangeSetListCursorError {
  constructor(message?: string) {
    super(message);
    this.name = "PreviewCursorError";
  }
}

const PreviewCursorSchema = z
  .object({ v: z.literal(1), r: z.number().int().min(0), k: z.string().max(32).nullable(), h: z.string().max(80) })
  .strict();

export function encodePreviewCursor(c: { rowNo: number; cls: LineClass | null; previewHash: string }): string {
  return encodeOpaque({ v: 1, r: c.rowNo, k: c.cls, h: c.previewHash });
}

/** The last row served, bound to the request's `class` filter and the stored preview's hash. */
export function decodePreviewCursor(raw: string, cls: LineClass | null, previewHash: string): number {
  return bindPreviewCursor(parsePreviewCursor(raw), cls, previewHash);
}

/** A decoded preview cursor, before it is bound to the stored preview. */
export interface ParsedPreviewCursor {
  readonly rowNo: number;
  readonly cls: string | null;
  readonly previewHash: string;
}

/**
 * The cursor's structure only (review round 4): checked before any read, so a malformed cursor is
 * 400 even on a set that has no preview; `bindPreviewCursor` then checks it against that preview.
 */
export function parsePreviewCursor(raw: string): ParsedPreviewCursor {
  const p = decodeOpaque(raw, PreviewCursorSchema, () => new PreviewCursorError());
  return { rowNo: p.r, cls: p.k, previewHash: p.h };
}

/** The last row served, when the cursor was issued for this filter and this stored preview. */
export function bindPreviewCursor(cursor: ParsedPreviewCursor, cls: LineClass | null, previewHash: string): number {
  if (cursor.cls !== cls || cursor.previewHash !== previewHash) throw new PreviewCursorError("the cursor belongs to another preview or filter");
  return cursor.rowNo;
}

interface ValidationRow {
  validated_at_revision: string;
  preview_hash: string;
  summary: PreviewSummary;
  target_stores: { storeId: string; timezone: string }[];
}

interface LineRow {
  row_no: number;
  store_id: string;
  product_id: string;
  sell_unit: "each";
  old_price: string | null;
  old_source_scope: string | null;
  new_price: string | null;
  new_source_scope: string | null;
  delta_pct: string | null;
  rounded_from: string | null;
  effective_from: Date;
  class: LineClass;
  devices: number;
  messages: string[];
}

interface MembershipRow {
  store_id: string;
  from_zone_id: string | null;
  to_zone_id: string;
  effective_from: Date;
  effective_to: Date | null;
  superseded_membership_ids: string[];
}

interface PreviewLineBody {
  readonly storeId: string;
  readonly productId: string;
  readonly sellUnit: "each";
  readonly oldPrice: string | null;
  readonly oldSourceScope: string | null;
  readonly newPrice: string | null;
  readonly newSourceScope: string | null;
  readonly deltaPct: string | null;
  readonly roundedFrom?: string;
  readonly effectiveFrom: string;
  readonly class: LineClass;
  readonly devices: number;
  readonly messages: readonly string[];
}

export interface PriceChangeSetPreviewBody {
  readonly changeSetId: string;
  readonly version: number;
  readonly validatedAtRevision: number;
  readonly previewHash: string;
  readonly summary: PreviewSummary;
  readonly membershipChanges: readonly {
    readonly storeId: string;
    readonly fromZoneId: string | null;
    readonly toZoneId: string;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
    readonly supersededMembershipIds: readonly string[];
  }[];
  readonly lines: readonly PreviewLineBody[];
  readonly nextCursor: string | null;
}

/**
 * The Store's time zone recorded at validation. Every preview Store is a target Store, so a
 * missing one is a stored-data defect: fail (500) rather than write an instant in a wrong zone.
 */
function zoneOf(zones: ReadonlyMap<string, string>, storeId: string): string {
  const zone = zones.get(storeId);
  if (zone === undefined) throw new Error(`preview Store ${storeId} is not among the validation's target Stores`);
  return zone;
}

/** One page of the preview stored at `version` with `previewHash`. */
export async function readPreviewPage(
  client: Queryable,
  q: {
    readonly tenantId: string;
    readonly changeSetId: string;
    readonly version: number;
    readonly previewHash: string;
    readonly cls: LineClass | null;
    readonly afterRowNo: number;
    readonly limit: number;
  },
): Promise<PriceChangeSetPreviewBody | null> {
  const v = await client.query<ValidationRow>(
    `SELECT validated_at_revision::text AS validated_at_revision, preview_hash, summary, target_stores
       FROM price_change_set_validations
      WHERE tenant_id = $1::uuid AND change_set_id = $2::uuid AND change_set_version = $3 AND preview_hash = $4`,
    [q.tenantId, q.changeSetId, q.version, q.previewHash],
  );
  const validation = v.rows[0];
  if (!validation) return null;
  const zones = new Map(validation.target_stores.map((s) => [s.storeId, s.timezone]));
  const lines = await client.query<LineRow>(
    `SELECT row_no, store_id::text AS store_id, product_id::text AS product_id, sell_unit, old_price::text AS old_price,
            old_source_scope, new_price::text AS new_price, new_source_scope, delta_pct::text AS delta_pct,
            rounded_from::text AS rounded_from, effective_from, class, devices, messages
       FROM price_change_set_preview_lines
      WHERE tenant_id = $1::uuid AND change_set_id = $2::uuid AND change_set_version = $3
        AND row_no > $4 AND ($5::text IS NULL OR class = $5)
      ORDER BY row_no
      LIMIT $6`,
    [q.tenantId, q.changeSetId, q.version, q.afterRowNo, q.cls, q.limit + 1],
  );
  const moves = await client.query<MembershipRow>(
    `SELECT store_id::text AS store_id, from_zone_id::text AS from_zone_id, to_zone_id::text AS to_zone_id,
            effective_from, effective_to, superseded_membership_ids::text[] AS superseded_membership_ids
       FROM price_change_set_preview_memberships
      WHERE tenant_id = $1::uuid AND change_set_id = $2::uuid AND change_set_version = $3
      ORDER BY line_no`,
    [q.tenantId, q.changeSetId, q.version],
  );
  const page = lines.rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    changeSetId: q.changeSetId,
    version: q.version,
    validatedAtRevision: Number(validation.validated_at_revision),
    previewHash: validation.preview_hash,
    summary: validation.summary,
    membershipChanges: moves.rows.map((m) => ({
      storeId: m.store_id,
      fromZoneId: m.from_zone_id,
      toZoneId: m.to_zone_id,
      effectiveFrom: formatInstantInZone(m.effective_from, zoneOf(zones, m.store_id)),
      effectiveTo: m.effective_to === null ? null : formatInstantInZone(m.effective_to, zoneOf(zones, m.store_id)),
      supersededMembershipIds: m.superseded_membership_ids,
    })),
    lines: page.map((r) => toPreviewLine(r, zoneOf(zones, r.store_id))),
    nextCursor:
      lines.rows.length > q.limit && last !== undefined
        ? encodePreviewCursor({ rowNo: last.row_no, cls: q.cls, previewHash: q.previewHash })
        : null,
  };
}

function toPreviewLine(r: LineRow, zone: string): PreviewLineBody {
  return {
    storeId: r.store_id,
    productId: r.product_id,
    sellUnit: r.sell_unit,
    oldPrice: r.old_price,
    oldSourceScope: r.old_source_scope,
    newPrice: r.new_price,
    newSourceScope: r.new_source_scope,
    deltaPct: r.delta_pct,
    ...(r.rounded_from === null ? {} : { roundedFrom: r.rounded_from }),
    effectiveFrom: formatInstantInZone(r.effective_from, zone),
    class: r.class,
    devices: r.devices,
    messages: r.messages,
  };
}
