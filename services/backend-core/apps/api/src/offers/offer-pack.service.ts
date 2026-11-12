/**
 * OfferPackService — `posGetOfferPack` (`offers.openapi.yaml`; spec 048 §7,
 * OD-6, OD-8; Jira RT-1337): the paired terminal's current Offer Pack.
 *
 * The Pack of the device's own tenant and store is read from the
 * MATERIALISED rows (`offer_pack_eligible_products`, open rows only): every
 * offer version that is scheduled or active for the store and not paused for
 * it, with its parameters, its schedule resolved to absolute instants in the
 * store's zone, its offline policy and its eligible product ids. An offer
 * with no eligible product left in the store has no rows and is omitted. By
 * the 0101 EXCLUDE constraint a product id is in at most one offer's set.
 *
 * `packRevision` is the store's applied revision (the latest tenant revision
 * that changed this store's Pack; 0 before any). The ETag is the SHA-256 of
 * the canonical JSON of the body without `issuedAt`, so it changes only when
 * the Pack changes, never because time passed.
 */
import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { resolveWindow } from "./offer-schedule";
import type { OfferDefinition } from "./offers.dto";
import { dbNow, loadVersions } from "./offers.repository";

/** The tenant's Pack freshness window (OD-8): a tenant setting does not exist yet, so the default. */
const DEFAULT_FRESHNESS_WINDOW_HOURS = 24;
/** Used when a store has no priced product to take a currency from (EGP is the only supported currency today). */
const FALLBACK_CURRENCY = "EGP";

interface PackOfferBody {
  readonly offerId: string;
  readonly offerVersion: number;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly type: "buy_x_get_y_percent";
  readonly parameters: OfferDefinition["parameters"];
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly offlinePolicy: "allow_cached" | "online_only";
  readonly eligibleProductIds: ReadonlyArray<string>;
}

export interface OfferPackBody {
  readonly packRevision: number;
  readonly issuedAt: string;
  readonly freshnessWindowHours: number;
  readonly storeTimezone: string;
  readonly currencyCode: string;
  readonly offers: ReadonlyArray<PackOfferBody>;
}

/** Canonical JSON: object keys sorted at every level, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The strong ETag of a Pack: the quoted lowercase hex SHA-256 of the canonical body without `issuedAt`. */
export function packEtag(body: OfferPackBody): string {
  const { issuedAt: _issuedAt, ...rest } = body;
  return `"${createHash("sha256").update(canonicalJson(rest)).digest("hex")}"`;
}

@Injectable()
export class OfferPackService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  read(scope: { readonly tenantId: string; readonly storeId: string }): Promise<OfferPackBody> {
    return runWithTenantContext(this.pool, { tenantId: scope.tenantId, isPlatformAdmin: false }, (client) =>
      readPack(client, scope),
    );
  }
}

async function readPack(
  client: PoolClient,
  scope: { readonly tenantId: string; readonly storeId: string },
): Promise<OfferPackBody> {
  const { tenantId, storeId } = scope;
  const issuedAt = await dbNow(client);
  // One statement, so one snapshot: the applied revision and the rows it labels cannot come from two revisions
  // (a rebuild committing between two READ COMMITTED statements would otherwise pair N with N+1's content).
  const snapshot = await client.query<{ timezone: string; applied: string | null; sets: ReadonlyArray<{ offer_id: string; offer_version: number; product_ids: string[] }> }>(
    `SELECT s.timezone,
            (SELECT r.applied_revision::text FROM offer_pack_store_revisions r
              WHERE r.tenant_id = s.tenant_id AND r.store_id = s.id) AS applied,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('offer_id', g.offer_id, 'offer_version', g.offer_version, 'product_ids', g.product_ids) ORDER BY g.offer_id)
                        FROM (SELECT offer_id::text AS offer_id, offer_version, array_agg(product_id::text ORDER BY product_id) AS product_ids
                                FROM offer_pack_eligible_products
                               WHERE tenant_id = s.tenant_id AND store_id = s.id AND to_revision IS NULL
                               GROUP BY offer_id, offer_version) g), '[]'::jsonb) AS sets
       FROM stores s WHERE s.tenant_id = $1::uuid AND s.id = $2::uuid`,
    [tenantId, storeId],
  );
  const row = snapshot.rows[0];
  if (row === undefined) throw new Error("device store not found");
  const sets = { rows: row.sets };

  const records = await loadVersions(client, tenantId, sets.rows.map((r) => r.offer_id), { currentOnly: false });
  const byKey = new Map(records.map((r) => [`${r.offerId}:${r.version}`, r]));
  const offers: PackOfferBody[] = sets.rows.flatMap((s) => {
    const record = byKey.get(`${s.offer_id}:${s.offer_version}`);
    if (record === undefined || s.product_ids.length === 0) return [];
    const d = record.definition;
    const window = resolveWindow(d.schedule, row.timezone);
    return [
      {
        offerId: s.offer_id,
        offerVersion: s.offer_version,
        nameAr: d.nameAr,
        nameEn: d.nameEn,
        type: d.type,
        parameters: { ...d.parameters },
        startsAt: window.startsAt.toISOString(),
        endsAt: window.endsAt === null ? null : window.endsAt.toISOString(),
        offlinePolicy: d.offlinePolicy,
        eligibleProductIds: s.product_ids,
      },
    ];
  });
  return {
    packRevision: row.applied === null ? 0 : Number(row.applied),
    issuedAt: issuedAt.toISOString(),
    freshnessWindowHours: DEFAULT_FRESHNESS_WINDOW_HOURS,
    storeTimezone: row.timezone,
    currencyCode: await storeCurrency(client, tenantId, storeId),
    offers,
  };
}

/**
 * The currency the store prices in: the most used among its resolved prices
 * (the store override's currency, else the product default's), ties by code.
 * There is no tenant or store currency setting yet, so a store with no priced
 * product reads `FALLBACK_CURRENCY`.
 */
async function storeCurrency(client: PoolClient, tenantId: string, storeId: string): Promise<string> {
  const r = await client.query<{ currency: string }>(
    `SELECT currency FROM (
        SELECT COALESCE(o.currency_code, tp.default_currency_code) AS currency
          FROM tenant_products tp
          LEFT JOIN store_product_overrides o
            ON o.tenant_id = tp.tenant_id AND o.product_id = tp.id AND o.store_id = $2::uuid AND o.retired_at IS NULL
         WHERE tp.tenant_id = $1::uuid AND tp.retired_at IS NULL) x
      WHERE currency IS NOT NULL
      GROUP BY currency ORDER BY count(*) DESC, currency LIMIT 1`,
    [tenantId, storeId],
  );
  return r.rows[0]?.currency ?? FALLBACK_CURRENCY;
}
