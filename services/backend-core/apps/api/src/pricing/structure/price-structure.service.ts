/**
 * PriceStructureService — RT-1484 (RT-282 PR-09a): the runtime of
 * `pricing/price-structure.yaml` 1.0.0-draft over the 0121 tables `price_books`, `price_zones`,
 * `price_zone_memberships` and `pricing_revisions` (and, for a Zone's in-use check, 0121
 * `price_events` / `change_sets` and 0123 `price_change_set_lines`).
 *
 * DATA ACCESS — raw parameterized SQL under `runWithTenantContext` (tenant RLS, FORCE,
 * `isPlatformAdmin: false`) plus an explicit `tenant_id` predicate on every statement; the
 * tenant and the actor are the session's (§II, §XII). Stores are read through the `stores`
 * module's port, audit rows are written through the `audit` module's port.
 *
 * Writes (contract "What changes prices, and what does not"): creating a Book (with its default
 * Zone, the 0121 deferred check), creating a Zone and retiring an unused one change no resolved
 * price, so they are direct writes with no Pricing Revision. Each is ONE transaction: the change,
 * its `audit_events` row and the body it answers with. The Book create and the Zone retirement
 * take the tenant's pricing publish lock first (spec 042 §8). Memberships are read only here:
 * they change through a Change Set `move_store_zone` (later RT-1484 slices).
 *
 * The UPDATE of a retirement names only the columns production grants
 * (`apps/api/src/auth/grants/pricing.grants.ts`): `retired_at`, `retired_by_user_id`,
 * `retire_reason`. The 0121 guard trigger is the backstop for the default Zone and for a Zone in
 * use by an active membership or price event.
 *
 * Reads follow the 0121 visibility rule at revision R (data-model §2.3): `published_in_revision
 * <= R AND (ended_in_revision IS NULL OR ended_in_revision > R)`. Before the tenant's first
 * revision nothing is visible, so every Store falls back to the default Zone.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { insertAuditRowInTransaction } from "../../audit";
import { callerStoreScope, MembershipRepository, scopeStoreIds, type TenantContextRequest } from "../../context";
import { PG_POOL } from "../../database";
import { isLiveStore, liveStoreIdsAfter } from "../../stores";
import { lockPricingPublish } from "../pricing-publish-lock";
import { pricingRevisionAt } from "../pricing-revision";
import type {
  CreatePriceBookBody,
  CreatePriceZoneBody,
  RetirePriceZoneBody,
  StoreMembershipsQuery,
  ZoneStoresQuery,
} from "./price-structure.dto";
import {
  decodeZoneStoresCursor,
  encodeZoneStoresCursor,
  PriceStructureConflictError,
  PriceStructureNotFoundError,
  PricingRevisionUnknownError,
  toMembershipBody,
  toPriceBookBody,
  toPriceZoneBody,
  ZoneStoresCursorError,
  type PriceBookBody,
  type PriceBookRow,
  type PriceZoneBody,
  type PriceZoneMembershipRow,
  type PriceZoneRow,
  type PriceZoneStoreBody,
  type PriceZoneStorePageBody,
  type StorePriceZoneMembershipsBody,
} from "./price-structure.projections";

/** The session tenant and context of a read. */
export interface StructureReadInput {
  readonly tenantId: string;
  readonly context: NonNullable<TenantContextRequest["context"]>;
}

/** A write adds the actor and the request id for the audit row. */
export interface StructureWriteInput extends StructureReadInput {
  readonly actorUserId: string;
  readonly requestId: string | null;
}

const DEFAULT_PAGE_SIZE = 100;
/** The smallest keyset scan batch, so a small page never costs one query per Store. */
const SCAN_BATCH = 200;
const DEFAULT_ZONE_CODE = "DEFAULT";
const DEFAULT_ZONE_NAME = "Default";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BOOK_COLUMNS = `b.id::text AS id, b.code, b.name, b.currency_code, b.tax_price_basis, b.pricing_context,
       b.is_default, b.retired_at, b.created_by_user_id::text AS created_by_user_id, b.created_at`;
const ZONE_COLUMNS = `z.id::text AS id, z.price_book_id::text AS price_book_id, z.code, z.name, z.is_default,
       z.retired_at, z.retire_reason, z.created_by_user_id::text AS created_by_user_id, z.created_at`;
const ZONE_RETURNING = ZONE_COLUMNS.replace(/\bz\./g, "");
const BOOK_RETURNING = BOOK_COLUMNS.replace(/\bb\./g, "");

/** The 0121 visibility rule at revision `$rev` (null: nothing is visible). */
const VISIBLE_AT = (rev: string): string =>
  `${rev}::bigint IS NOT NULL AND m.published_in_revision <= ${rev}::bigint
   AND (m.ended_in_revision IS NULL OR m.ended_in_revision > ${rev}::bigint)`;

/** Change Set states that are neither published (or its derived states) nor cancelled. */
const OPEN_CHANGE_SET_STATES = ["draft", "validated", "pending_approval", "approved"] as const;

function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === "23505" && e.constraint === constraint;
}

/** The request id when it is a UUID (the audit row's `request_id` is uuid), else null. */
function uuidRequestId(input: StructureWriteInput): string | null {
  return input.requestId !== null && UUID_RE.test(input.requestId) ? input.requestId : null;
}

/** `correlation_id` is NOT NULL uuid: the request id when it is one, else a fresh id. */
function correlationOf(input: StructureWriteInput): string {
  return uuidRequestId(input) ?? newId();
}

@Injectable()
export class PriceStructureService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** consoleListPriceBooks — every Book of the tenant, retired ones included, newest first. */
  listBooks(input: StructureReadInput): Promise<{ items: PriceBookBody[] }> {
    return this.inTenant(input, async (client) => {
      const books = await client.query<PriceBookRow>(
        `SELECT ${BOOK_COLUMNS} FROM price_books b WHERE b.tenant_id = $1::uuid ORDER BY b.created_at DESC, b.id DESC`,
        [input.tenantId],
      );
      const defaults = await this.defaultZonesOf(client, input.tenantId, books.rows.map((b) => b.id));
      return { items: books.rows.map((b) => toPriceBookBody(b, requireDefault(defaults, b.id))) };
    });
  }

  /** consoleGetPriceBook — the Book and every Zone, the default Zone first, then by code. */
  getBook(input: StructureReadInput, bookId: string): Promise<{ book: PriceBookBody; zones: PriceZoneBody[] }> {
    return this.inTenant(input, async (client) => {
      const book = await this.bookOf(client, input.tenantId, bookId, false);
      const zones = await client.query<PriceZoneRow>(
        `SELECT ${ZONE_COLUMNS} FROM price_zones z
          WHERE z.tenant_id = $1::uuid AND z.price_book_id = $2::uuid
          ORDER BY z.is_default DESC, z.code ASC`,
        [input.tenantId, bookId],
      );
      const def = zones.rows.find((z) => z.is_default);
      if (!def) throw new Error(`price book ${bookId} has no default zone`);
      return { book: toPriceBookBody(book, def), zones: zones.rows.map(toPriceZoneBody) };
    });
  }

  /**
   * consoleListPriceZoneStores — the live Stores in the caller's scope whose Zone in the Book at
   * `at`, as known at the revision, is this Zone: an explicit visible membership, or (for the
   * default Zone) no explicit membership at that instant. Keyset by Store id; the first page
   * fixes `at` and the revision, and the cursor carries both.
   */
  listZoneStores(
    input: StructureReadInput,
    target: { readonly bookId: string; readonly zoneId: string },
    query: ZoneStoresQuery,
  ): Promise<PriceZoneStorePageBody> {
    const cursor = query.cursor === undefined ? null : decodeZoneStoresCursor(query.cursor, target.zoneId);
    if (cursor && query.as_of_revision !== undefined && query.as_of_revision !== cursor.revision) {
      throw new ZoneStoresCursorError("as_of_revision differs from the cursor's revision");
    }
    const limit = query.page_size ?? DEFAULT_PAGE_SIZE;
    return this.inTenant(input, async (client) => {
      const zone = await this.zoneOf(client, input.tenantId, target, false);
      const at = cursor ? cursor.at : await canonicalInstant(client, query.at ?? null);
      if (cursor && query.at !== undefined && (await canonicalInstant(client, query.at)) !== cursor.at) {
        throw new ZoneStoresCursorError("at differs from the cursor's instant");
      }
      const revision = cursor
        ? await this.cursorRevision(client, input.tenantId, cursor.revision)
        : await this.revisionOf(client, input.tenantId, query.as_of_revision);
      const storeIds = scopeStoreIds(await callerStoreScope(client, this.memberships, input));
      const page = await this.zoneStorePage(client, input.tenantId, zone, {
        at,
        revision,
        storeIds,
        after: cursor ? cursor.after : null,
        limit,
      });
      return {
        zoneId: zone.id,
        evaluatedAt: at,
        asOfRevision: revision,
        items: page.items,
        nextCursor: page.last === null ? null : encodeZoneStoresCursor({ zoneId: zone.id, at, revision, after: page.last }),
      };
    });
  }

  /**
   * One page of `zone`'s Stores. The default Zone walks the live Stores in scope in id order,
   * resolving each Store's Zone (an explicit visible membership covering `at`, else the default
   * Zone). Any other Zone reads its visible members directly by Store id, keeping the live ones.
   * Both scan in batches of at least `SCAN_BATCH`, independent of the page size. `last` is the
   * last Store examined when more may follow.
   */
  private zoneStorePage(
    client: PoolClient,
    tenantId: string,
    zone: PriceZoneRow,
    page: ZoneStorePageInput,
  ): Promise<{ items: PriceZoneStoreBody[]; last: string | null }> {
    const batch = Math.max(page.limit, SCAN_BATCH);
    const next = zone.is_default
      ? (after: string | null) => this.defaultZoneBatch(client, tenantId, zone, page, after, batch)
      : (after: string | null) => this.explicitZoneBatch(client, tenantId, zone, page, after, batch);
    return fillPage(page.limit, page.after, next);
  }

  private async defaultZoneBatch(
    client: PoolClient,
    tenantId: string,
    zone: PriceZoneRow,
    page: ZoneStorePageInput,
    after: string | null,
    batch: number,
  ): Promise<ScanBatch> {
    const ids = await liveStoreIdsAfter(client, tenantId, { after, storeIds: page.storeIds, limit: batch });
    const explicit = await this.membershipsAt(client, tenantId, zone.price_book_id, ids, page.at, page.revision);
    return {
      examined: ids,
      exhausted: ids.length < batch,
      pick: (storeId) => {
        const m = explicit.get(storeId);
        if (!m) return { storeId, membership: "default", membershipId: null };
        return m.zoneId === zone.id ? { storeId, membership: "explicit", membershipId: m.id } : null;
      },
    };
  }

  private async explicitZoneBatch(
    client: PoolClient,
    tenantId: string,
    zone: PriceZoneRow,
    page: ZoneStorePageInput,
    after: string | null,
    batch: number,
  ): Promise<ScanBatch> {
    if (page.revision === null) return { examined: [], exhausted: true, pick: () => null };
    // Each Store's resolving membership in the Book (the same DISTINCT ON rule as `membershipsAt`),
    // kept when it is this Zone's.
    const r = await client.query<{ store_id: string; id: string }>(
      `SELECT t.store_id, t.id FROM (
         SELECT DISTINCT ON (m.store_id) m.store_id::text AS store_id, m.id::text AS id, m.price_zone_id
           FROM price_zone_memberships m
          WHERE m.tenant_id = $1::uuid AND m.price_book_id = $2::uuid
            AND ${VISIBLE_AT("$3")}
            AND m.effective_from <= $4::timestamptz AND (m.effective_to IS NULL OR m.effective_to > $4::timestamptz)
            AND ($5::uuid IS NULL OR m.store_id > $5::uuid)
            AND ($6::uuid[] IS NULL OR m.store_id = ANY($6::uuid[]))
          ORDER BY m.store_id, m.published_in_revision DESC) t
        WHERE t.price_zone_id = $7::uuid
        ORDER BY t.store_id
        LIMIT $8`,
      [tenantId, zone.price_book_id, page.revision, page.at, after, page.storeIds, zone.id, batch],
    );
    const examined = r.rows.map((row) => row.store_id);
    const live = new Set(
      examined.length === 0
        ? []
        : await liveStoreIdsAfter(client, tenantId, { after: null, storeIds: examined, limit: examined.length }),
    );
    const byStore = new Map<string, string>(r.rows.map((row) => [row.store_id, row.id]));
    return {
      examined,
      exhausted: examined.length < batch,
      pick: (storeId) =>
        live.has(storeId) ? { storeId, membership: "explicit", membershipId: byStore.get(storeId) ?? null } : null,
    };
  }

  /** consoleListStorePriceZoneMemberships — the Store's visible membership rows in the retail Book. */
  storeMemberships(
    input: StructureReadInput,
    storeId: string,
    query: StoreMembershipsQuery,
  ): Promise<StorePriceZoneMembershipsBody> {
    return this.inTenant(input, async (client) => {
      const scoped = scopeStoreIds(await callerStoreScope(client, this.memberships, input));
      const inScope = scoped === null || scoped.includes(storeId.toLowerCase());
      if (!inScope || !(await isLiveStore(client, input.tenantId, storeId))) throw new PriceStructureNotFoundError();
      const revision = await this.revisionOf(client, input.tenantId, query.as_of_revision);
      const book = await client.query<{ id: string; default_zone_id: string }>(
        `SELECT b.id::text AS id, z.id::text AS default_zone_id
           FROM price_books b
           JOIN price_zones z ON z.tenant_id = b.tenant_id AND z.price_book_id = b.id AND z.is_default
          WHERE b.tenant_id = $1::uuid AND b.pricing_context = 'retail' AND b.retired_at IS NULL`,
        [input.tenantId],
      );
      const retail = book.rows[0];
      if (!retail) return { storeId, priceBookId: null, defaultZoneId: null, asOfRevision: revision, items: [] };
      const rows = await client.query<PriceZoneMembershipRow>(
        `SELECT m.id::text AS id, m.price_zone_id::text AS price_zone_id, m.effective_from, m.effective_to,
                m.published_in_revision::text AS published_in_revision, m.carried_forward
           FROM price_zone_memberships m
          WHERE m.tenant_id = $1::uuid AND m.price_book_id = $2::uuid AND m.store_id = $3::uuid
            AND ${VISIBLE_AT("$4")}
          ORDER BY m.effective_from, m.id`,
        [input.tenantId, retail.id, storeId, revision],
      );
      return {
        storeId,
        priceBookId: retail.id,
        defaultZoneId: retail.default_zone_id,
        asOfRevision: revision,
        items: rows.rows.map(toMembershipBody),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /** consoleCreatePriceBook — the tenant's retail Book and its default Zone, under the pricing lock. */
  createBook(input: StructureWriteInput, body: CreatePriceBookBody): Promise<PriceBookBody> {
    return this.inTenant(input, async (client) => {
      await lockPricingPublish(client, input.tenantId);
      const existing = await client.query<{ active: boolean }>(
        `SELECT (pricing_context = 'retail' AND retired_at IS NULL) AS active, code = $2 AS same_code
           FROM price_books WHERE tenant_id = $1::uuid AND ((pricing_context = 'retail' AND retired_at IS NULL) OR code = $2)`,
        [input.tenantId, body.code],
      );
      if (existing.rows.some((r) => r.active)) throw new PriceStructureConflictError("price_book_exists");
      if (existing.rows.length > 0) throw new PriceStructureConflictError("price_book_code_taken");
      const bookId = newId();
      const correlationId = correlationOf(input);
      let book: PriceBookRow;
      try {
        const r = await client.query<PriceBookRow>(
          `INSERT INTO price_books (id, tenant_id, code, name, currency_code, tax_price_basis, pricing_context,
                                    is_default, created_by_user_id, correlation_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'retail', true, $7, $8)
           RETURNING ${BOOK_RETURNING}`,
          [bookId, input.tenantId, body.code, body.name, body.currencyCode, body.taxPriceBasis, input.actorUserId, correlationId],
        );
        book = r.rows[0]!;
      } catch (err) {
        if (isUniqueViolation(err, "uq_price_books_one_active_per_context")) {
          throw new PriceStructureConflictError("price_book_exists");
        }
        if (isUniqueViolation(err, "price_books_tenant_code_uk")) throw new PriceStructureConflictError("price_book_code_taken");
        throw err;
      }
      const zoneId = newId();
      const zone = await client.query<PriceZoneRow>(
        `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, is_default, created_by_user_id, correlation_id)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7)
         RETURNING ${ZONE_RETURNING}`,
        [zoneId, input.tenantId, bookId, DEFAULT_ZONE_CODE, body.defaultZoneName ?? DEFAULT_ZONE_NAME, input.actorUserId, correlationId],
      );
      await this.audit(client, input, "pricing.price_book.created", "price_book", bookId, {
        price_book_id: bookId,
        default_price_zone_id: zoneId,
        code: body.code,
        currency_code: body.currencyCode,
        tax_price_basis: body.taxPriceBasis,
      });
      return toPriceBookBody(book, zone.rows[0]!);
    });
  }

  /** consoleCreatePriceZone — a new, empty, non-default Zone of a non-retired Book. */
  createZone(input: StructureWriteInput, bookId: string, body: CreatePriceZoneBody): Promise<PriceZoneBody> {
    return this.inTenant(input, async (client) => {
      const book = await this.bookOf(client, input.tenantId, bookId, true);
      if (book.retired_at !== null) throw new PriceStructureConflictError("price_book_retired");
      const taken = await client.query(
        `SELECT 1 FROM price_zones WHERE tenant_id = $1::uuid AND price_book_id = $2::uuid AND code = $3`,
        [input.tenantId, bookId, body.code],
      );
      if ((taken.rowCount ?? 0) > 0) throw new PriceStructureConflictError("price_zone_code_taken");
      const zoneId = newId();
      let inserted: PriceZoneRow;
      try {
        const r = await client.query<PriceZoneRow>(
          `INSERT INTO price_zones (id, tenant_id, price_book_id, code, name, is_default, created_by_user_id, correlation_id)
           VALUES ($1, $2, $3, $4, $5, false, $6, $7)
           RETURNING ${ZONE_RETURNING}`,
          [zoneId, input.tenantId, bookId, body.code, body.name, input.actorUserId, correlationOf(input)],
        );
        inserted = r.rows[0]!;
      } catch (err) {
        if (isUniqueViolation(err, "price_zones_book_code_uk")) throw new PriceStructureConflictError("price_zone_code_taken");
        throw err;
      }
      await this.audit(client, input, "pricing.price_zone.created", "price_zone", zoneId, {
        price_book_id: bookId,
        price_zone_id: zoneId,
        code: body.code,
      });
      return toPriceZoneBody(inserted);
    });
  }

  /**
   * consoleRetirePriceZone — under the pricing lock: the Zone must be non-default, not retired and
   * unused (no active membership or price event, no line of an open Change Set targets it).
   */
  retireZone(
    input: StructureWriteInput,
    target: { readonly bookId: string; readonly zoneId: string },
    body: RetirePriceZoneBody,
  ): Promise<PriceZoneBody> {
    return this.inTenant(input, async (client) => {
      await lockPricingPublish(client, input.tenantId);
      const zone = await this.zoneOf(client, input.tenantId, target, true);
      if (zone.is_default) throw new PriceStructureConflictError("default_price_zone_immutable");
      if (zone.retired_at !== null) throw new PriceStructureConflictError("price_zone_retired");
      if (await this.zoneInUse(client, input.tenantId, zone.id)) throw new PriceStructureConflictError("price_zone_in_use");
      const r = await client.query<PriceZoneRow>(
        `UPDATE price_zones
            SET retired_at = now(), retired_by_user_id = $3, retire_reason = $4
          WHERE tenant_id = $1::uuid AND id = $2::uuid AND retired_at IS NULL
          RETURNING ${ZONE_RETURNING}`,
        [input.tenantId, zone.id, input.actorUserId, body.reason],
      );
      const retired = r.rows[0];
      if (!retired) throw new PriceStructureConflictError("price_zone_retired");
      // Ids only: the reason is operator free text (FR-AUDIT-3, §XIV).
      await this.audit(client, input, "pricing.price_zone.retired", "price_zone", zone.id, {
        price_book_id: zone.price_book_id,
        price_zone_id: zone.id,
        code: zone.code,
      });
      return toPriceZoneBody(retired);
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** One transaction under the caller's tenant (RLS, FORCE). */
  private inTenant<T>(input: StructureReadInput, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, fn);
  }

  private async bookOf(client: PoolClient, tenantId: string, bookId: string, lock: boolean): Promise<PriceBookRow> {
    const r = await client.query<PriceBookRow>(
      `SELECT ${BOOK_COLUMNS} FROM price_books b WHERE b.tenant_id = $1::uuid AND b.id = $2::uuid${lock ? " FOR SHARE" : ""}`,
      [tenantId, bookId],
    );
    const row = r.rows[0];
    if (!row) throw new PriceStructureNotFoundError();
    return row;
  }

  private async zoneOf(
    client: PoolClient,
    tenantId: string,
    target: { readonly bookId: string; readonly zoneId: string },
    lock: boolean,
  ): Promise<PriceZoneRow> {
    const r = await client.query<PriceZoneRow>(
      `SELECT ${ZONE_COLUMNS} FROM price_zones z
        WHERE z.tenant_id = $1::uuid AND z.price_book_id = $2::uuid AND z.id = $3::uuid${lock ? " FOR UPDATE" : ""}`,
      [tenantId, target.bookId, target.zoneId],
    );
    const row = r.rows[0];
    if (!row) throw new PriceStructureNotFoundError();
    return row;
  }

  private async defaultZonesOf(
    client: PoolClient,
    tenantId: string,
    bookIds: readonly string[],
  ): Promise<Map<string, PriceZoneRow>> {
    if (bookIds.length === 0) return new Map<string, PriceZoneRow>();
    const r = await client.query<PriceZoneRow>(
      `SELECT ${ZONE_COLUMNS} FROM price_zones z
        WHERE z.tenant_id = $1::uuid AND z.price_book_id = ANY($2::uuid[]) AND z.is_default`,
      [tenantId, bookIds],
    );
    return new Map<string, PriceZoneRow>(r.rows.map((z) => [z.price_book_id, z]));
  }

  /** A cursor's revision, re-checked against the head (null stays null): above it, the cursor is not ours. */
  private async cursorRevision(client: PoolClient, tenantId: string, revision: number | null): Promise<number | null> {
    if (revision === null) return null;
    try {
      return await this.revisionOf(client, tenantId, revision);
    } catch (err) {
      if (err instanceof PricingRevisionUnknownError) throw new ZoneStoresCursorError("the cursor's revision is unknown");
      throw err;
    }
  }

  /** The revision to read at: the explicit one (422 above the head), else the head (null: none yet). */
  private revisionOf(client: PoolClient, tenantId: string, requested: number | undefined): Promise<number | null> {
    return pricingRevisionAt(client, tenantId, requested);
  }

  /** Each listed Store's explicit membership in the Book visible at `revision`, covering `at`. */
  private async membershipsAt(
    client: PoolClient,
    tenantId: string,
    bookId: string,
    storeIds: readonly string[],
    at: string,
    revision: number | null,
  ): Promise<Map<string, { id: string; zoneId: string }>> {
    if (storeIds.length === 0 || revision === null) return new Map<string, { id: string; zoneId: string }>();
    const r = await client.query<{ store_id: string; id: string; price_zone_id: string }>(
      `SELECT DISTINCT ON (m.store_id) m.store_id::text AS store_id, m.id::text AS id, m.price_zone_id::text AS price_zone_id
         FROM price_zone_memberships m
        WHERE m.tenant_id = $1::uuid AND m.price_book_id = $2::uuid AND m.store_id = ANY($3::uuid[])
          AND ${VISIBLE_AT("$4")}
          AND m.effective_from <= $5::timestamptz AND (m.effective_to IS NULL OR m.effective_to > $5::timestamptz)
        ORDER BY m.store_id, m.published_in_revision DESC`,
      [tenantId, bookId, storeIds, revision, at],
    );
    return new Map<string, { id: string; zoneId: string }>(
      r.rows.map((row) => [row.store_id, { id: row.id, zoneId: row.price_zone_id }]),
    );
  }

  /** An active membership or price event, or a line of a Change Set not yet published or cancelled. */
  private async zoneInUse(client: PoolClient, tenantId: string, zoneId: string): Promise<boolean> {
    const r = await client.query<{ in_use: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM price_zone_memberships m
                       WHERE m.tenant_id = $1::uuid AND m.price_zone_id = $2::uuid AND m.state = 'active')
           OR EXISTS (SELECT 1 FROM price_events e
                       WHERE e.tenant_id = $1::uuid AND e.price_zone_id = $2::uuid AND e.state = 'active')
           OR EXISTS (SELECT 1 FROM price_change_set_lines l
                        JOIN change_sets c ON c.tenant_id = l.tenant_id AND c.id = l.change_set_id
                       WHERE l.tenant_id = $1::uuid AND l.price_zone_id = $2::uuid
                         AND c.state = ANY($3::text[])) AS in_use`,
      [tenantId, zoneId, OPEN_CHANGE_SET_STATES],
    );
    return r.rows[0]?.in_use === true;
  }

  private audit(
    client: PoolClient,
    input: StructureWriteInput,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return insertAuditRowInTransaction(client, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      storeId: null,
      action,
      targetType,
      targetId,
      requestId: uuidRequestId(input),
      metadata,
    });
  }
}

interface ZoneStorePageInput {
  readonly at: string;
  readonly revision: number | null;
  readonly storeIds: readonly string[] | null;
  readonly after: string | null;
  readonly limit: number;
}

/** One keyset batch: the Store ids examined in order, whether the scan ended, and each one's row. */
interface ScanBatch {
  readonly examined: readonly string[];
  readonly exhausted: boolean;
  readonly pick: (storeId: string) => PriceZoneStoreBody | null;
}

/** Fills a page of `limit` rows from keyset batches; `last` is the last Store examined when more may follow. */
async function fillPage(
  limit: number,
  start: string | null,
  next: (after: string | null) => Promise<ScanBatch>,
): Promise<{ items: PriceZoneStoreBody[]; last: string | null }> {
  const items: PriceZoneStoreBody[] = [];
  let after = start;
  let more = true;
  // sequential: each batch's keyset starts after the previous batch's last Store.
  while (more && items.length < limit) {
    const b = await next(after);
    more = !b.exhausted;
    for (const [i, storeId] of b.examined.entries()) {
      after = storeId;
      const item = b.pick(storeId);
      if (item) items.push(item);
      if (items.length === limit) {
        more = more || i < b.examined.length - 1;
        break;
      }
    }
  }
  return { items, last: more ? after : null };
}

/** `at` (or the transaction's now()) as canonical UTC text with microseconds. */
async function canonicalInstant(client: PoolClient, at: string | null): Promise<string> {
  const r = await client.query<{ at: string }>(
    `SELECT to_char(COALESCE($1::timestamptz, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`,
    [at],
  );
  return r.rows[0]!.at;
}

function requireDefault(defaults: ReadonlyMap<string, PriceZoneRow>, bookId: string): PriceZoneRow {
  const zone = defaults.get(bookId);
  // 0121's deferred check makes every committed Book hold exactly one default Zone.
  if (!zone) throw new Error(`price book ${bookId} has no default zone`);
  return zone;
}
