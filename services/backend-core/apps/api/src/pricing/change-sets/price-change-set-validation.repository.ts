/**
 * RT-1484 (RT-282 PR-10a, PR-4b) — what `validate` reads at the head revision and the 0123 rows it
 * writes, plus the stored preview `preview` reads. Every statement runs on the caller's client
 * inside its tenant transaction (`runWithTenantContext`: tenant RLS, FORCE) with an explicit
 * `tenant_id` predicate. Other modules' tables are read through their ports (stores, catalog,
 * devices; RT-1453).
 *
 * Writes follow 0123: the validation row first (its insert trigger checks the set is a draft at
 * that version, from its current non-empty item list), then its lines, preview rows and
 * membership changes (sealed to this transaction), all in one transaction with the set's move to
 * `validated`. The COMMIT-time checks run at COMMIT; nothing here issues `SET CONSTRAINTS`
 * (RT-1151 residual 1). Bulk rows go through `jsonb_to_recordset` in chunks.
 */
import type { PoolClient } from "pg";

import { liveProductsOfCategories, tenantProductLiveness } from "../../catalog";
import { activeDeviceCountsByStore } from "../../devices";
import { liveAndNamedStores } from "../../stores";
import { LOCAL_TEXT, loadBook, loadEvents, loadMemberships, VISIBLE_AT, wallClock } from "../inquiry/price-inquiry.repository";
import type { PriceScope, ResolutionPriceBook } from "../resolution/types";
import type { PriceChangeItem } from "./price-change-sets.dto";
import type {
  ChangeSetKindForValidation,
  MaterializedLine,
  MembershipChange,
  PendingLine,
  PositionedItem,
  PreviewRow,
  PreviewSummary,
  ValidationContext,
} from "./price-change-set-validation.types";
import type { TargetStore } from "./price-change-set-hashes";

type Queryable = Pick<PoolClient, "query">;

const CHUNK = 2000;
const HELPER_OPS = ["adjust_amount", "adjust_percent"];

/** The set's current item list (the latest at or below its version), in authored order. */
export async function loadCurrentItems(
  client: Queryable,
  tenantId: string,
  changeSetId: string,
  version: number,
): Promise<{ listVersion: number | null; items: PositionedItem[] }> {
  const list = await client.query<{ v: number }>(
    `SELECT max(change_set_version) AS v FROM price_change_set_item_lists
      WHERE tenant_id = $1::uuid AND change_set_id = $2::uuid AND change_set_version <= $3`,
    [tenantId, changeSetId, version],
  );
  const listVersion = list.rows[0]?.v ?? null;
  if (listVersion === null) return { listVersion: null, items: [] };
  const r = await client.query<{ position: number; item: PriceChangeItem }>(
    `SELECT position, item FROM price_change_set_items
      WHERE tenant_id = $1::uuid AND change_set_id = $2::uuid AND change_set_version = $3
      ORDER BY position`,
    [tenantId, changeSetId, listVersion],
  );
  return { listVersion, items: r.rows.map((row) => ({ position: row.position, item: row.item })) };
}

/** The tenant's head Pricing Revision; 0 before its first publish. */
export async function headRevision(client: Queryable, tenantId: string): Promise<number> {
  const r = await client.query<{ head: string | null }>(
    `SELECT max(revision_no)::text AS head FROM pricing_revisions WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  const head = r.rows[0]?.head ?? null;
  return head === null ? 0 : Number(head);
}

/** The retail Book with its default Zone, or null (`409 price_book_missing`). */
export function loadRetailBook(client: Queryable, tenantId: string): Promise<ResolutionPriceBook | null> {
  return loadBook(client, tenantId);
}

interface PendingRow {
  change_set_id: string;
  op: string;
  scope: PriceScope;
  price_zone_id: string | null;
  store_id: string | null;
  product_id: string | null;
  time_basis: "store_local" | "absolute";
  effective_from: Date | null;
  effective_to: Date | null;
  effective_from_local: string | null;
  effective_to_local: string | null;
}

/**
 * What reach and the size budget need (review round 1, M2: loaded before any event): the Book's
 * Zones, the live and named Stores, the products the items name or their categories hold, and the
 * Book's memberships visible at `revision`. The event-side fields are empty until
 * `loadPricingContext` fills them. `ids` are the lower-case ids the items name.
 */
export async function loadReachContext(
  client: Queryable,
  input: {
    readonly tenantId: string;
    readonly kind: ChangeSetKindForValidation;
    readonly nowMs: number;
    readonly revision: number;
    readonly book: ResolutionPriceBook;
    readonly ids: { readonly productIds: readonly string[]; readonly categoryIds: readonly string[]; readonly storeIds: readonly string[] };
  },
): Promise<ValidationContext> {
  const { tenantId, book, revision } = input;
  const zones = await client.query<{ id: string; live: boolean }>(
    `SELECT id::text AS id, retired_at IS NULL AS live FROM price_zones WHERE tenant_id = $1::uuid AND price_book_id = $2::uuid`,
    [tenantId, book.id],
  );
  const stores = await liveAndNamedStores(client, tenantId, input.ids.storeIds);
  const categoryProducts = await liveProductsOfCategories(client, tenantId, input.ids.categoryIds);
  const allProducts = [...new Set([...input.ids.productIds, ...[...categoryProducts.values()].flat()])];
  const products = await tenantProductLiveness(client, tenantId, allProducts);
  const memberships = await loadMemberships(client, { tenantId, bookId: book.id, storeId: null, revision });
  return {
    tenantId,
    kind: input.kind,
    nowMs: input.nowMs,
    headRevision: revision,
    book,
    zones: new Map(zones.rows.map((z) => [z.id, { live: z.live }])),
    stores: new Map(stores.map((s) => [s.id, s])),
    products: new Map([...products].map(([id, live]) => [id, { live }])),
    categoryProducts,
    memberships,
    events: [],
    pendingLines: [],
    helperEventIds: new Set(),
    devices: new Map(),
  };
}

/**
 * The rest of what the pure validator reads, as visible at the head (spec 042 §6): the products'
 * `regular` events, the lines of the tenant's other validated, pending and approved sets, the
 * events a helper line published, and the target Stores' active devices.
 */
export async function loadPricingContext(client: Queryable, reach: ValidationContext, changeSetId: string): Promise<ValidationContext> {
  const { tenantId, book, headRevision: revision } = reach;
  const allProducts = [...reach.products.keys()];
  const { events } = await loadEvents(client, {
    tenantId,
    bookId: book.id,
    storeId: null,
    productIds: allProducts,
    sellUnit: "each",
    revision,
  });
  const pending = await client.query<PendingRow>(
    `SELECT l.change_set_id::text AS change_set_id, l.op, l.scope, l.price_zone_id::text AS price_zone_id,
            l.store_id::text AS store_id, l.product_id::text AS product_id, l.time_basis, l.effective_from, l.effective_to,
            ${LOCAL_TEXT("l.effective_from_local")} AS effective_from_local,
            ${LOCAL_TEXT("l.effective_to_local")} AS effective_to_local
       FROM change_sets c
       JOIN price_change_set_lines l
         ON l.tenant_id = c.tenant_id AND l.change_set_id = c.id AND l.change_set_version = c.version
      WHERE c.tenant_id = $1::uuid AND c.domain = 'pricing' AND c.id <> $2::uuid
        AND c.state IN ('validated', 'pending_approval', 'approved')
        AND l.class <> 'invalid'
        AND (l.product_id = ANY($3::uuid[]) OR l.op = 'move_store_zone')`,
    [tenantId, changeSetId, allProducts],
  );
  const helpers = await client.query<{ id: string }>(
    `SELECT l.new_event_id::text AS id
       FROM price_change_set_lines l
       JOIN price_events e ON e.tenant_id = l.tenant_id AND e.id = l.new_event_id
      WHERE l.tenant_id = $1::uuid AND l.new_event_id IS NOT NULL AND l.op = ANY($2::text[])
        AND l.product_id = ANY($3::uuid[]) AND ${VISIBLE_AT("e", "$4")}`,
    [tenantId, HELPER_OPS, allProducts, revision],
  );
  const devices = await activeDeviceCountsByStore(client, tenantId, [...reach.stores.keys()]);
  return {
    ...reach,
    events,
    pendingLines: pending.rows.map(
      (p): PendingLine => ({
        changeSetId: p.change_set_id,
        op: p.op,
        scope: p.scope,
        priceZoneId: p.price_zone_id,
        storeId: p.store_id,
        productId: p.product_id,
        timeBasis: p.time_basis,
        effectiveFrom: p.effective_from,
        effectiveTo: p.effective_to,
        effectiveFromLocal: wallClock(p.effective_from_local),
        effectiveToLocal: wallClock(p.effective_to_local),
      }),
    ),
    helperEventIds: new Set(helpers.rows.map((h) => h.id)),
    devices,
  };
}

/** The validation a set is moved to `validated` with. */
export interface ValidationWrite {
  readonly tenantId: string;
  readonly changeSetId: string;
  readonly version: number;
  readonly itemListVersion: number;
  /** The retail Book every line names (one in v1). */
  readonly bookId: string;
  readonly validatedAtRevision: number;
  readonly previewHash: string;
  readonly targetStoreSetHash: string;
  readonly sensitive: boolean;
  readonly sensitivityReasons: readonly string[];
  readonly summary: PreviewSummary;
  readonly targetStores: readonly TargetStore[];
  readonly lines: readonly MaterializedLine[];
  readonly previewRows: readonly PreviewRow[];
  readonly membershipChanges: readonly MembershipChange[];
  readonly actorUserId: string;
  readonly correlationId: string;
}

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

/** Writes the validation, its lines, preview rows and membership changes, and moves the set to `validated`. */
export async function writeValidation(client: Queryable, w: ValidationWrite): Promise<void> {
  const head = [w.tenantId, w.changeSetId, w.version];
  await client.query(
    `INSERT INTO price_change_set_validations
       (tenant_id, change_set_id, change_set_version, item_list_version, validated_at_revision, preview_hash,
        target_store_set_hash, sensitive, sensitivity_reasons, summary, target_stores, line_count, preview_line_count,
        membership_change_count, created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16)`,
    [
      ...head,
      w.itemListVersion,
      w.validatedAtRevision,
      w.previewHash,
      w.targetStoreSetHash,
      w.sensitive,
      w.sensitivityReasons,
      JSON.stringify(w.summary),
      JSON.stringify(w.targetStores),
      w.lines.length,
      w.previewRows.length,
      w.membershipChanges.length,
      w.actorUserId,
      w.correlationId,
    ],
  );
  for (const part of chunks(w.lines)) {
    await client.query(
      `INSERT INTO price_change_set_lines
         (tenant_id, change_set_id, change_set_version, line_no, item_list_version, item_position, op, scope,
          price_book_id, price_zone_id, store_id, product_id, sell_unit, time_basis, effective_from, effective_to,
          effective_from_local, effective_to_local, new_price, rounded_from, class, messages, replaced_ids,
          created_by_user_id, correlation_id)
       SELECT $1, $2, $3, x.line_no, $4, x.item_position, x.op, x.scope, $5, x.price_zone_id, x.store_id, x.product_id,
              x.sell_unit, x.time_basis, x.effective_from, x.effective_to, x.effective_from_local, x.effective_to_local,
              x.new_price, x.rounded_from, x.class,
              ARRAY(SELECT jsonb_array_elements_text(x.messages)),
              ARRAY(SELECT jsonb_array_elements_text(x.replaced_ids))::uuid[],
              $6, $7
         FROM jsonb_to_recordset($8::jsonb) AS x(
           line_no int, item_position int, op text, scope text, price_zone_id uuid, store_id uuid, product_id uuid,
           sell_unit text, time_basis text, effective_from timestamptz, effective_to timestamptz,
           effective_from_local timestamp, effective_to_local timestamp, new_price numeric, rounded_from numeric,
           class text, messages jsonb, replaced_ids jsonb)`,
      [
        ...head,
        w.itemListVersion,
        w.bookId,
        w.actorUserId,
        w.correlationId,
        JSON.stringify(
          part.map((l) => ({
            line_no: l.lineNo,
            item_position: l.itemPosition,
            op: l.op,
            scope: l.scope,
            price_zone_id: l.priceZoneId,
            store_id: l.storeId,
            product_id: l.productId,
            sell_unit: l.sellUnit,
            time_basis: l.timeBasis,
            effective_from: l.effectiveFrom,
            effective_to: l.effectiveTo,
            effective_from_local: l.effectiveFromLocal,
            effective_to_local: l.effectiveToLocal,
            new_price: l.newPrice,
            rounded_from: l.roundedFrom,
            class: l.class,
            messages: l.messages,
            replaced_ids: l.replacedIds,
          })),
        ),
      ],
    );
  }
  for (const part of chunks(w.previewRows)) {
    await client.query(
      `INSERT INTO price_change_set_preview_lines
         (tenant_id, change_set_id, change_set_version, line_no, row_no, store_id, product_id, sell_unit, old_price,
          old_source_scope, new_price, new_source_scope, delta_pct, rounded_from, effective_from, class, devices, messages)
       SELECT $1, $2, $3, x.line_no, x.row_no, x.store_id, x.product_id, x.sell_unit, x.old_price, x.old_source_scope,
              x.new_price, x.new_source_scope, x.delta_pct, x.rounded_from, x.effective_from, x.class, x.devices,
              ARRAY(SELECT jsonb_array_elements_text(x.messages))
         FROM jsonb_to_recordset($4::jsonb) AS x(
           line_no int, row_no int, store_id uuid, product_id uuid, sell_unit text, old_price numeric,
           old_source_scope text, new_price numeric, new_source_scope text, delta_pct numeric, rounded_from numeric,
           effective_from timestamptz, class text, devices int, messages jsonb)`,
      [
        ...head,
        JSON.stringify(
          part.map((r) => ({
            line_no: r.lineNo,
            row_no: r.rowNo,
            store_id: r.storeId,
            product_id: r.productId,
            sell_unit: r.sellUnit,
            old_price: r.oldPrice,
            old_source_scope: r.oldSourceScope,
            new_price: r.newPrice,
            new_source_scope: r.newSourceScope,
            delta_pct: r.deltaPct,
            rounded_from: r.roundedFrom,
            effective_from: new Date(r.effectiveFromMs).toISOString(),
            class: r.class,
            devices: r.devices,
            messages: r.messages,
          })),
        ),
      ],
    );
  }
  for (const m of w.membershipChanges) {
    await client.query(
      `INSERT INTO price_change_set_preview_memberships
         (tenant_id, change_set_id, change_set_version, line_no, store_id, from_zone_id, to_zone_id, effective_from,
          effective_to, superseded_membership_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[])`,
      [...head, m.lineNo, m.storeId, m.fromZoneId, m.toZoneId, m.effectiveFrom, m.effectiveTo, m.supersededMembershipIds],
    );
  }
  await client.query(
    `UPDATE change_sets
        SET state = 'validated', validated_at_revision = $3, preview_hash = $4, target_store_set_hash = $5,
            sensitive = $6, sensitivity_reasons = $7::text[]
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [w.tenantId, w.changeSetId, w.validatedAtRevision, w.previewHash, w.targetStoreSetHash, w.sensitive, w.sensitivityReasons],
  );
}
