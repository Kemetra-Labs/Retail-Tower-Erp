/**
 * Persistence of the Offer Engine's authoring tables (0101, Jira RT-1336;
 * runtime Jira RT-1337): `offers`, `offer_versions`, `offer_version_stores`,
 * `offer_version_rules` and `offer_pauses`.
 *
 * Every method takes the caller's tenant-scoped client (`runWithTenantContext`
 * on the NOBYPASSRLS domain pool): all ten tables are FORCE RLS, and every
 * statement also names the tenant. UPDATE is column-level in production
 * (`offer-engine-domain-grants.sql`): only the draft columns, `ended_*`,
 * `archived_*`, a pause's `resumed_*`, a store's applied revision and an
 * eligible row's `to_revision` are ever written here after insert; versions,
 * their stores and rules, and Pack revisions are append-only.
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

import type { EligibilityIds, OfferDefinition } from "./offers.dto";
import type { OfferScheduleValue } from "./offer-schedule";

export interface OfferHeader {
  readonly id: string;
  readonly createdAt: Date;
  /** Microsecond-precision UTC text of `created_at`, the keyset key. */
  readonly createdAtKey: string;
  readonly updatedAt: Date;
  readonly createdByUserId: string;
  readonly draftRevision: number;
  readonly draft: { readonly definition: OfferDefinition; readonly updatedAt: Date; readonly updatedByUserId: string } | null;
  readonly endedAt: Date | null;
  readonly archivedAt: Date | null;
}

export interface OfferVersionRecord {
  readonly offerId: string;
  readonly version: number;
  readonly definition: OfferDefinition;
  readonly publishedAt: Date;
  readonly publishedByUserId: string;
  readonly eligibleSetCount: number;
}

export interface OpenPause {
  readonly id: string;
  readonly offerId: string;
  /** Null: the whole offer. */
  readonly storeId: string | null;
  readonly reason: string;
  readonly pausedByUserId: string;
  readonly pausedAt: Date;
}

interface HeaderRow {
  id: string;
  created_at: Date;
  created_at_key: string;
  updated_at: Date;
  created_by_user_id: string;
  draft_revision: number;
  draft_definition: OfferDefinition | null;
  draft_updated_at: Date | null;
  draft_updated_by_user_id: string | null;
  ended_at: Date | null;
  archived_at: Date | null;
}

const HEADER_COLUMNS = `
  id::text AS id, created_at, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_key,
  updated_at, created_by_user_id::text AS created_by_user_id, draft_revision, draft_definition, draft_updated_at,
  draft_updated_by_user_id::text AS draft_updated_by_user_id, ended_at, archived_at`;

function toHeader(r: HeaderRow): OfferHeader {
  return {
    id: r.id,
    createdAt: r.created_at,
    createdAtKey: r.created_at_key,
    updatedAt: r.updated_at,
    createdByUserId: r.created_by_user_id,
    draftRevision: r.draft_revision,
    draft:
      r.draft_definition === null
        ? null
        : { definition: r.draft_definition, updatedAt: r.draft_updated_at!, updatedByUserId: r.draft_updated_by_user_id! },
    endedAt: r.ended_at,
    archivedAt: r.archived_at,
  };
}

/** The tenant's advisory lock for every Pack-affecting write (publish, pause, resume, end, catalog rebuild). */
export async function lockTenantOffers(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [`offers:${tenantId}`]);
}

/** The database clock (one value per call; the 0101 CHECKs and triggers use now()). */
export async function dbNow(client: PoolClient): Promise<Date> {
  const r = await client.query<{ now: Date }>(`SELECT now() AS now`);
  return r.rows[0]!.now;
}

export async function insertOffer(
  client: PoolClient,
  args: { tenantId: string; definition: OfferDefinition; userId: string },
): Promise<string> {
  const id = newId();
  await client.query(
    `INSERT INTO offers
       (id, tenant_id, draft_revision, draft_definition, draft_updated_at, draft_updated_by_user_id, created_by_user_id)
     VALUES ($1, $2, 1, $3::jsonb, now(), $4, $4)`,
    [id, args.tenantId, JSON.stringify(args.definition), args.userId],
  );
  return id;
}

/** One offer of the tenant, or null (an absent or other tenant's offer is the same null). */
export async function loadOfferHeader(
  client: PoolClient,
  tenantId: string,
  offerId: string,
  opts: { readonly forUpdate?: boolean } = {},
): Promise<OfferHeader | null> {
  const r = await client.query<HeaderRow>(
    `SELECT ${HEADER_COLUMNS} FROM offers WHERE tenant_id = $1::uuid AND id = $2::uuid${opts.forUpdate ? " FOR NO KEY UPDATE" : ""}`,
    [tenantId, offerId],
  );
  return r.rows[0] ? toHeader(r.rows[0]) : null;
}

/** Every offer header of the tenant, newest first (`created_at`, then id). */
export async function loadOfferHeaders(client: PoolClient, tenantId: string): Promise<OfferHeader[]> {
  const r = await client.query<HeaderRow>(
    `SELECT ${HEADER_COLUMNS} FROM offers WHERE tenant_id = $1::uuid ORDER BY created_at DESC, id DESC`,
    [tenantId],
  );
  return r.rows.map(toHeader);
}

export async function writeDraft(
  client: PoolClient,
  args: { tenantId: string; offerId: string; definition: OfferDefinition; userId: string; nextRevision: number },
): Promise<void> {
  await client.query(
    `UPDATE offers
        SET draft_revision = $3, draft_definition = $4::jsonb, draft_updated_at = now(), draft_updated_by_user_id = $5
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [args.tenantId, args.offerId, args.nextRevision, JSON.stringify(args.definition), args.userId],
  );
}

/** A publish consumes the draft: it is absent again, the revision counter stays (never reused). */
export async function clearDraft(client: PoolClient, tenantId: string, offerId: string): Promise<void> {
  await client.query(
    `UPDATE offers
        SET draft_definition = NULL, draft_updated_at = NULL, draft_updated_by_user_id = NULL
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, offerId],
  );
}

export async function markEnded(client: PoolClient, tenantId: string, offerId: string, userId: string): Promise<void> {
  await client.query(
    `UPDATE offers SET ended_at = now(), ended_by_user_id = $3 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, offerId, userId],
  );
}

export async function markArchived(client: PoolClient, tenantId: string, offerId: string, userId: string): Promise<void> {
  await client.query(
    `UPDATE offers SET archived_at = now(), archived_by_user_id = $3 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [tenantId, offerId, userId],
  );
}

interface VersionRow {
  offer_id: string;
  version: number;
  name_ar: string;
  name_en: string | null;
  buy_quantity: number;
  get_quantity: number;
  percent_off: number;
  max_applications_per_sale: number | null;
  all_stores: boolean;
  time_basis: "store_local" | "absolute";
  starts_local: string | null;
  ends_local: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  offline_policy: "allow_cached" | "online_only";
  eligible_set_count: number;
  published_by_user_id: string;
  published_at: Date;
}

interface RuleRow {
  offer_id: string;
  version: number;
  effect: "include" | "exclude";
  product_id: string | null;
  category_id: string | null;
  brand_id: string | null;
}

const VERSION_COLUMNS = `
  v.offer_id::text AS offer_id, v.version, v.name_ar, v.name_en, v.buy_quantity, v.get_quantity, v.percent_off::int AS percent_off,
  v.max_applications_per_sale, v.all_stores, v.time_basis,
  to_char(v.starts_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_local, to_char(v.ends_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS ends_local,
  v.starts_at, v.ends_at, v.offline_policy, v.eligible_set_count, v.published_by_user_id::text AS published_by_user_id, v.published_at`;

/**
 * The versions of the given offers, rebuilt into `OfferDefinition`s (the
 * stores and rules read back, ids sorted as the draft normalises them).
 * `currentOnly` returns each offer's latest version only.
 */
export async function loadVersions(
  client: PoolClient,
  tenantId: string,
  offerIds: ReadonlyArray<string> | null,
  opts: { readonly currentOnly: boolean; readonly version?: number },
): Promise<OfferVersionRecord[]> {
  const versions = await client.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS}
       FROM offer_versions v
      WHERE v.tenant_id = $1::uuid
        AND ($2::uuid[] IS NULL OR v.offer_id = ANY($2::uuid[]))
        AND ($3::boolean = false OR v.version = (SELECT max(m.version) FROM offer_versions m
                                                  WHERE m.tenant_id = v.tenant_id AND m.offer_id = v.offer_id))
        AND ($4::int IS NULL OR v.version = $4::int)
      ORDER BY v.offer_id, v.version DESC`,
    [tenantId, offerIds === null ? null : [...offerIds], opts.currentOnly, opts.version ?? null],
  );
  if (versions.rows.length === 0) return [];
  const ids = [...new Set(versions.rows.map((v) => v.offer_id))];
  // sequential: both reads share one PoolClient (pg runs its queries one at a time).
  const stores = await client.query<{ offer_id: string; version: number; store_id: string }>(
    `SELECT offer_id::text AS offer_id, version, store_id::text AS store_id
       FROM offer_version_stores WHERE tenant_id = $1::uuid AND offer_id = ANY($2::uuid[])`,
    [tenantId, ids],
  );
  const rules = await client.query<RuleRow>(
    `SELECT offer_id::text AS offer_id, version, effect, product_id::text AS product_id, category_id::text AS category_id,
            brand_id::text AS brand_id
       FROM offer_version_rules WHERE tenant_id = $1::uuid AND offer_id = ANY($2::uuid[])`,
    [tenantId, ids],
  );
  const key = (o: string, v: number): string => `${o}:${v}`;
  const storesBy = new Map<string, string[]>();
  for (const s of stores.rows) storesBy.set(key(s.offer_id, s.version), [...(storesBy.get(key(s.offer_id, s.version)) ?? []), s.store_id]);
  const rulesBy = new Map<string, RuleRow[]>();
  for (const r of rules.rows) rulesBy.set(key(r.offer_id, r.version), [...(rulesBy.get(key(r.offer_id, r.version)) ?? []), r]);

  return versions.rows.map((v) => {
    const mine = rulesBy.get(key(v.offer_id, v.version)) ?? [];
    const setOf = (effect: "include" | "exclude"): EligibilityIds | undefined => {
      const pick = (col: "product_id" | "category_id" | "brand_id"): string[] =>
        mine.filter((r) => r.effect === effect && r[col] !== null).map((r) => r[col]!).sort();
      const out: { productIds?: string[]; categoryIds?: string[]; brandIds?: string[] } = {};
      const [p, c, b] = [pick("product_id"), pick("category_id"), pick("brand_id")];
      if (p.length > 0) out.productIds = p;
      if (c.length > 0) out.categoryIds = c;
      if (b.length > 0) out.brandIds = b;
      return Object.keys(out).length === 0 ? undefined : out;
    };
    const exclude = setOf("exclude");
    const local = v.time_basis === "store_local";
    const definition: OfferDefinition = {
      nameAr: v.name_ar,
      nameEn: v.name_en,
      type: "buy_x_get_y_percent",
      parameters: {
        buyQuantity: v.buy_quantity,
        getQuantity: v.get_quantity,
        percentOff: String(v.percent_off),
        rewardSelection: "cheapest",
        maxApplicationsPerSale: v.max_applications_per_sale,
        priceBasis: "resolved_store_price",
      },
      eligibility: { include: setOf("include") ?? {}, ...(exclude ? { exclude } : {}) },
      storeScope: v.all_stores ? { allStores: true } : { storeIds: (storesBy.get(key(v.offer_id, v.version)) ?? []).sort() },
      schedule: {
        timeBasis: v.time_basis,
        startsAt: local ? v.starts_local! : v.starts_at!.toISOString(),
        endsAt: local ? v.ends_local : (v.ends_at?.toISOString() ?? null),
      },
      offlinePolicy: v.offline_policy,
    };
    return {
      offerId: v.offer_id,
      version: v.version,
      definition,
      publishedAt: v.published_at,
      publishedByUserId: v.published_by_user_id,
      eligibleSetCount: v.eligible_set_count,
    };
  });
}

export interface NewVersion {
  readonly tenantId: string;
  readonly offerId: string;
  readonly version: number;
  readonly definition: OfferDefinition;
  readonly eligibleSetCount: number;
  readonly userId: string;
}

/**
 * The next version row with its stores and rules, in the CURRENT transaction
 * (0101: only the publishing transaction may write a version's children, and
 * the version must be whole at COMMIT).
 */
export async function insertVersion(client: PoolClient, v: NewVersion): Promise<void> {
  const d = v.definition;
  const local = d.schedule.timeBasis === "store_local";
  await client.query(
    `INSERT INTO offer_versions
       (tenant_id, offer_id, version, name_ar, name_en, offer_type, buy_quantity, get_quantity, percent_off,
        reward_selection, max_applications_per_sale, price_basis, all_stores, time_basis, starts_local, ends_local,
        starts_at, ends_at, offline_policy, eligible_set_count, published_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::smallint, $10, $11, $12, $13, $14, $15::timestamp, $16::timestamp,
             $17::timestamptz, $18::timestamptz, $19, $20, $21)`,
    [
      v.tenantId, v.offerId, v.version, d.nameAr, d.nameEn, d.type, d.parameters.buyQuantity, d.parameters.getQuantity,
      d.parameters.percentOff, d.parameters.rewardSelection, d.parameters.maxApplicationsPerSale, d.parameters.priceBasis,
      "allStores" in d.storeScope, d.schedule.timeBasis,
      local ? d.schedule.startsAt : null, local ? d.schedule.endsAt : null,
      local ? null : d.schedule.startsAt, local ? null : d.schedule.endsAt,
      d.offlinePolicy, v.eligibleSetCount, v.userId,
    ],
  );
  if ("storeIds" in d.storeScope) {
    await client.query(
      `INSERT INTO offer_version_stores (tenant_id, offer_id, version, store_id)
       SELECT $1::uuid, $2::uuid, $3::int, s FROM unnest($4::uuid[]) AS s`,
      [v.tenantId, v.offerId, v.version, d.storeScope.storeIds],
    );
  }
  const rules: Array<[string, string | null, string | null, string | null]> = [];
  const add = (effect: string, set: EligibilityIds | undefined): void => {
    for (const id of set?.productIds ?? []) rules.push([effect, id, null, null]);
    for (const id of set?.categoryIds ?? []) rules.push([effect, null, id, null]);
    for (const id of set?.brandIds ?? []) rules.push([effect, null, null, id]);
  };
  add("include", d.eligibility.include);
  add("exclude", d.eligibility.exclude);
  await client.query(
    `INSERT INTO offer_version_rules (tenant_id, offer_id, version, effect, product_id, category_id, brand_id)
     SELECT $1::uuid, $2::uuid, $3::int, e, p, c, b
       FROM unnest($4::text[], $5::uuid[], $6::uuid[], $7::uuid[]) AS t(e, p, c, b)`,
    [v.tenantId, v.offerId, v.version, rules.map((r) => r[0]), rules.map((r) => r[1]), rules.map((r) => r[2]), rules.map((r) => r[3])],
  );
}

export async function nextVersionNumber(client: PoolClient, tenantId: string, offerId: string): Promise<number> {
  const r = await client.query<{ next: number }>(
    `SELECT COALESCE(max(version), 0) + 1 AS next FROM offer_versions WHERE tenant_id = $1::uuid AND offer_id = $2::uuid`,
    [tenantId, offerId],
  );
  return r.rows[0]!.next;
}

/** The open pauses (whole-offer and store-level) of the given offers, or of every offer of the tenant. */
export async function loadOpenPauses(
  client: PoolClient,
  tenantId: string,
  offerIds: ReadonlyArray<string> | null,
): Promise<OpenPause[]> {
  const r = await client.query<{
    id: string; offer_id: string; store_id: string | null; reason: string; paused_by_user_id: string; paused_at: Date;
  }>(
    `SELECT id::text AS id, offer_id::text AS offer_id, store_id::text AS store_id, reason,
            paused_by_user_id::text AS paused_by_user_id, paused_at
       FROM offer_pauses
      WHERE tenant_id = $1::uuid AND resumed_at IS NULL AND ($2::uuid[] IS NULL OR offer_id = ANY($2::uuid[]))
      ORDER BY paused_at, id`,
    [tenantId, offerIds === null ? null : [...offerIds]],
  );
  return r.rows.map((p) => ({
    id: p.id, offerId: p.offer_id, storeId: p.store_id, reason: p.reason, pausedByUserId: p.paused_by_user_id, pausedAt: p.paused_at,
  }));
}

export async function insertPause(
  client: PoolClient,
  args: { tenantId: string; offerId: string; storeId: string | null; reason: string; userId: string },
): Promise<string> {
  const id = newId();
  await client.query(
    `INSERT INTO offer_pauses (id, tenant_id, offer_id, store_id, reason, paused_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, args.tenantId, args.offerId, args.storeId, args.reason, args.userId],
  );
  return id;
}

/** Resume the given open pauses (once; 0101 forbids any other change). */
export async function resumePauses(
  client: PoolClient,
  args: { tenantId: string; pauseIds: ReadonlyArray<string>; userId: string },
): Promise<void> {
  if (args.pauseIds.length === 0) return;
  await client.query(
    `UPDATE offer_pauses SET resumed_at = now(), resumed_by_user_id = $3
      WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) AND resumed_at IS NULL`,
    [args.tenantId, [...args.pauseIds], args.userId],
  );
}

export interface StoreFact {
  readonly id: string;
  readonly timezone: string;
}

/** The live (not deleted) stores of the tenant, with their zones. */
export async function loadLiveStores(client: PoolClient, tenantId: string): Promise<StoreFact[]> {
  const r = await client.query<{ id: string; timezone: string }>(
    `SELECT id::text AS id, timezone FROM stores WHERE tenant_id = $1::uuid AND deleted_at IS NULL ORDER BY id`,
    [tenantId],
  );
  return r.rows;
}

/** The subset of `storeIds` that are live stores of the tenant. */
export async function liveStoreIdsOf(client: PoolClient, tenantId: string, storeIds: ReadonlyArray<string>): Promise<Set<string>> {
  if (storeIds.length === 0) return new Set();
  const r = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM stores WHERE tenant_id = $1::uuid AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
    [tenantId, [...storeIds]],
  );
  return new Set(r.rows.map((s) => s.id));
}

export function scheduleOf(d: OfferDefinition): OfferScheduleValue {
  return d.schedule;
}
