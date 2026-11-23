/**
 * RT-1485 PR-16a-2a — the Pricing-table reads and writes of the legacy import (spec 044 §4.1,
 * §4.2, §4.3 step 5; spec 041 data-model §2.4–§2.6). Every function runs on the caller's client,
 * inside the import's one transaction under `app.system_privilege = 'pricing_legacy_import'` and
 * the tenant pin, after the caller took the publish lock.
 *
 * Shape of the `legacy_import` publication (0123 `change_sets_assert_legacy_import`,
 * `pricing_revisions_published`; RT-1151 comment 17827): one `legacy_import` set, created and
 * published only by this path, as the tenant's revision 1. It has no items, lines or validation;
 * its events carry `source = legacy_import`.
 */
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import { liveAndNamedStores } from "../../stores";
import { earliestEffectiveAt, type ImportInputs, type PlannedEvent } from "./legacy-import-plan";

type Queryable = Pick<PoolClient, "query">;

const BOOK_CODE = "RETAIL";
const BOOK_NAME = "Retail";
/** The default Zone's code and name, as `consoleCreatePriceBook` writes them. */
const DEFAULT_ZONE_CODE = "DEFAULT";
const DEFAULT_ZONE_NAME = "Default";
const IMPORT_TITLE = "Legacy price import";

export interface Writer {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly correlationId: string;
}

export interface RetailBook {
  readonly id: string;
  readonly currencyCode: string;
  readonly taxPriceBasis: string;
  readonly defaultZoneId: string | null;
}

/** The tenant's authority (spec 044 §6.1), or null when the row is missing (fail closed). */
export async function tenantAuthority(client: Queryable, tenantId: string): Promise<string | null> {
  const r = await client.query<{ authority: string }>(`SELECT authority FROM tenant_pricing_authority WHERE tenant_id = $1::uuid`, [tenantId]);
  return r.rows[0]?.authority ?? null;
}

/** The tenant's head Pricing Revision, null before the first. */
export async function headRevision(client: Queryable, tenantId: string): Promise<number | null> {
  const r = await client.query<{ head: string | null }>(`SELECT max(revision_no)::text AS head FROM pricing_revisions WHERE tenant_id = $1::uuid`, [tenantId]);
  const head = r.rows[0]?.head ?? null;
  return head === null ? null : Number(head);
}

/** The tenant's non-retired retail Book and its default Zone, or null. */
export async function retailBook(client: Queryable, tenantId: string): Promise<RetailBook | null> {
  const r = await client.query<RetailBook>(
    `SELECT b.id::text AS id, b.currency_code AS "currencyCode", b.tax_price_basis AS "taxPriceBasis",
            (SELECT z.id::text FROM price_zones z WHERE z.tenant_id = b.tenant_id AND z.price_book_id = b.id AND z.is_default) AS "defaultZoneId"
       FROM price_books b
      WHERE b.tenant_id = $1::uuid AND b.pricing_context = 'retail' AND b.retired_at IS NULL`,
    [tenantId],
  );
  return r.rows[0] ?? null;
}

/** The revision of the tenant's live (published) `legacy_import` set, or null when there is none. */
export async function legacyImportRevision(client: Queryable, tenantId: string): Promise<number | null> {
  const r = await client.query<{ revision_no: string | null }>(
    `SELECT revision_no::text AS revision_no FROM change_sets
      WHERE tenant_id = $1::uuid AND kind = 'legacy_import' AND state <> 'cancelled'`,
    [tenantId],
  );
  const rev = r.rows[0]?.revision_no ?? null;
  return rev === null ? null : Number(rev);
}

/** An active event of the Book, reduced to what a legacy value can express (§4.3 matching). */
export interface ActiveEvent {
  readonly scope: string;
  readonly storeId: string | null;
  readonly productId: string;
  readonly price: string;
  readonly currencyCode: string;
  readonly openEnded: boolean;
}

export async function activeEvents(client: Queryable, tenantId: string, bookId: string): Promise<ActiveEvent[]> {
  const r = await client.query<ActiveEvent>(
    `SELECT scope, store_id::text AS "storeId", product_id::text AS "productId", price::text AS price,
            currency_code AS "currencyCode", (effective_to IS NULL AND effective_to_local IS NULL) AS "openEnded"
       FROM price_events
      WHERE tenant_id = $1::uuid AND price_book_id = $2::uuid AND state = 'active'`,
    [tenantId, bookId],
  );
  return r.rows;
}

/** §4.1: the retail Book (the MC-10 currency and tax basis) and its immutable default Zone. */
export async function createRetailBook(client: Queryable, w: Writer, inputs: ImportInputs): Promise<RetailBook> {
  const bookId = newId();
  const zoneId = newId();
  await client.query(
    `INSERT INTO price_books (id, tenant_id, code, name, currency_code, tax_price_basis, pricing_context, is_default,
                              created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'retail', true, $7, $8)`,
    [bookId, w.tenantId, BOOK_CODE, BOOK_NAME, inputs.currencyCode, inputs.taxPriceBasis, w.actorUserId, w.correlationId],
  );
  await client.query(
    `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, is_default, created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7)`,
    [zoneId, w.tenantId, bookId, DEFAULT_ZONE_CODE, DEFAULT_ZONE_NAME, w.actorUserId, w.correlationId],
  );
  return { id: bookId, currencyCode: inputs.currencyCode, taxPriceBasis: inputs.taxPriceBasis, defaultZoneId: zoneId };
}

/** What {@link publishLegacyImport} wrote. */
export interface Publication {
  readonly changeSetId: string;
  readonly revisionNo: number;
  readonly fanOutStores: number;
}

/**
 * The `legacy_import` set, revision 1, its events and its fan-out. The set is inserted as a draft,
 * the revision is issued, then the set moves to `published` at it (the RT-1484 publish order;
 * 0123's COMMIT-time check then finds the set published at that revision).
 */
export async function publishLegacyImport(client: Queryable, w: Writer, book: RetailBook, events: readonly PlannedEvent[]): Promise<Publication> {
  const changeSetId = newId();
  const revisionNo = 1;
  await client.query(
    `INSERT INTO change_sets (id, tenant_id, domain, kind, title, state, created_by_user_id, correlation_id)
     VALUES ($1, $2, 'pricing', 'legacy_import', $3, 'draft', $4, $5)`,
    [changeSetId, w.tenantId, IMPORT_TITLE, w.actorUserId, w.correlationId],
  );
  await client.query(
    `INSERT INTO pricing_revisions (id, tenant_id, revision_no, change_set_id, kind, published_by_user_id, earliest_effective_at, correlation_id)
     VALUES ($1, $2, $3, $4, 'legacy_import', $5, $6, $7)`,
    [newId(), w.tenantId, revisionNo, changeSetId, w.actorUserId, earliestEffectiveAt(events), w.correlationId],
  );
  await client.query(
    `UPDATE change_sets SET state = 'published', revision_no = $3, published_by_user_id = $4, published_at = now()
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [w.tenantId, changeSetId, revisionNo, w.actorUserId],
  );
  const rows = events.map((e) => ({
    id: newId(),
    scope: e.scope,
    store_id: e.storeId,
    product_id: e.productId,
    price: e.price,
    from_local: e.fromLocal.toISOString().replace("Z", ""),
  }));
  await client.query(
    `INSERT INTO price_events (id, tenant_id, price_book_id, scope, store_id, product_id, sell_unit, price_kind, price, currency_code,
                               time_basis, effective_from_local, published_in_revision, change_set_id, source, created_by_user_id, correlation_id)
     SELECT x.id, $1::uuid, $2::uuid, x.scope, x.store_id, x.product_id, 'each', 'regular', x.price, $3,
            'store_local', x.from_local, $4, $5::uuid, 'legacy_import', $6::uuid, $7::uuid
       FROM jsonb_to_recordset($8::jsonb) AS x(id uuid, scope text, store_id uuid, product_id uuid, price numeric, from_local timestamp)`,
    [w.tenantId, book.id, book.currencyCode, revisionNo, changeSetId, w.actorUserId, w.correlationId, JSON.stringify(rows)],
  );
  const fanOutStores = await fanOut(client, w, revisionNo, events);
  return { changeSetId, revisionNo, fanOutStores };
}

/**
 * Data-model §2.6: every live Store for a book event, and every Store a store event names (live or
 * not). A superset is safe (POS applies whole revisions); a missed Store is not.
 */
async function fanOut(client: Queryable, w: Writer, revisionNo: number, events: readonly PlannedEvent[]): Promise<number> {
  const named = [...new Set(events.flatMap((e) => (e.storeId === null ? [] : [e.storeId])))];
  const hasBook = events.some((e) => e.scope === "book");
  const stores = (await liveAndNamedStores(client, w.tenantId, named)).filter((s) => hasBook || named.includes(s.id)).map((s) => s.id);
  if (stores.length === 0) return 0;
  await client.query(
    `INSERT INTO pricing_revision_stores (tenant_id, store_id, revision_no, created_by_user_id, correlation_id)
     SELECT $1::uuid, s, $2, $3::uuid, $4::uuid FROM unnest($5::uuid[]) AS s`,
    [w.tenantId, revisionNo, w.actorUserId, w.correlationId, stores],
  );
  return stores.length;
}

/** §4.3 step 5: the run's watermark row. */
export async function recordImportRun(
  client: Queryable,
  w: Writer,
  run: { readonly id: string; readonly at: Date; readonly changeLogSequence: number; readonly revisionNo: number | null; readonly counts: Record<string, number | string> },
): Promise<void> {
  await client.query(
    `INSERT INTO pricing_import_runs (id, tenant_id, import_instant, change_log_sequence, revision_no, counts, created_by_user_id, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [run.id, w.tenantId, run.at, run.changeLogSequence, run.revisionNo, JSON.stringify(run.counts), w.actorUserId, w.correlationId],
  );
}
