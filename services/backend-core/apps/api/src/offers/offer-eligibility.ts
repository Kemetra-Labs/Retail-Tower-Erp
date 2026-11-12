/**
 * Eligibility resolution (spec 048 §5.2, OD-1, OD-6; Jira RT-1337).
 *
 * A product is eligible when it matches ANY include entry (a product, its
 * category or its brand) and NO exclude entry: exclusion always wins, whatever
 * its dimension. A product with no category or no brand never matches a
 * category or brand rule; retired or inactive products are never eligible.
 * Backend-Core resolves the set (OD-6); the till matches product ids only.
 */
import type { PoolClient } from "pg";

import type { EligibilityIds, OfferDefinition } from "./offers.dto";

/** The Pack bound: a version's eligible set holds at most this many products (`PackOffer.eligibleProductIds`). */
export const ELIGIBLE_SET_LIMIT = 20_000;

export interface RuleSets {
  readonly includeProducts: ReadonlyArray<string>;
  readonly includeCategories: ReadonlyArray<string>;
  readonly includeBrands: ReadonlyArray<string>;
  readonly excludeProducts: ReadonlyArray<string>;
  readonly excludeCategories: ReadonlyArray<string>;
  readonly excludeBrands: ReadonlyArray<string>;
}

export function ruleSetsOf(definition: OfferDefinition): RuleSets {
  const { include, exclude } = definition.eligibility;
  return {
    includeProducts: include.productIds ?? [],
    includeCategories: include.categoryIds ?? [],
    includeBrands: include.brandIds ?? [],
    excludeProducts: exclude?.productIds ?? [],
    excludeCategories: exclude?.categoryIds ?? [],
    excludeBrands: exclude?.brandIds ?? [],
  };
}

/**
 * The eligible product ids of a rule set, ascending. At most `limit + 1` ids
 * are read, so a caller can tell a set above the bound from one at it.
 * `among` narrows the result to those ids (a conflict probe).
 */
export async function eligibleProductIds(
  client: PoolClient,
  tenantId: string,
  rules: RuleSets,
  opts: { readonly limit?: number; readonly among?: ReadonlyArray<string> } = {},
): Promise<string[]> {
  const r = await client.query<{ id: string }>(
    `SELECT p.id::text AS id
       FROM tenant_products p
      WHERE p.tenant_id = $1::uuid AND p.retired_at IS NULL AND p.is_active
        AND (p.id = ANY($2::uuid[]) OR COALESCE(p.category_id = ANY($3::uuid[]), false) OR COALESCE(p.brand_id = ANY($4::uuid[]), false))
        AND NOT (p.id = ANY($5::uuid[]) OR COALESCE(p.category_id = ANY($6::uuid[]), false) OR COALESCE(p.brand_id = ANY($7::uuid[]), false))
        AND ($8::uuid[] IS NULL OR p.id = ANY($8::uuid[]))
      ORDER BY p.id
      LIMIT $9`,
    [
      tenantId,
      [...rules.includeProducts], [...rules.includeCategories], [...rules.includeBrands],
      [...rules.excludeProducts], [...rules.excludeCategories], [...rules.excludeBrands],
      opts.among === undefined ? null : [...opts.among],
      (opts.limit ?? ELIGIBLE_SET_LIMIT) + 1,
    ],
  );
  return r.rows.map((p) => p.id);
}

/** The rule sets of a stored version, read from `offer_version_rules`. */
export async function loadRuleSets(
  client: PoolClient,
  tenantId: string,
  offerId: string,
  version: number,
): Promise<RuleSets> {
  const r = await client.query<{ effect: "include" | "exclude"; product_id: string | null; category_id: string | null; brand_id: string | null }>(
    `SELECT effect, product_id::text AS product_id, category_id::text AS category_id, brand_id::text AS brand_id
       FROM offer_version_rules WHERE tenant_id = $1::uuid AND offer_id = $2::uuid AND version = $3::int`,
    [tenantId, offerId, version],
  );
  const pick = (effect: string, col: "product_id" | "category_id" | "brand_id"): string[] =>
    r.rows.filter((x) => x.effect === effect && x[col] !== null).map((x) => x[col]!);
  return {
    includeProducts: pick("include", "product_id"),
    includeCategories: pick("include", "category_id"),
    includeBrands: pick("include", "brand_id"),
    excludeProducts: pick("exclude", "product_id"),
    excludeCategories: pick("exclude", "category_id"),
    excludeBrands: pick("exclude", "brand_id"),
  };
}

export interface ReferenceIssue {
  /** A JSON pointer into the definition, such as `/eligibility/include/brandIds/0`. */
  readonly field: string;
}

/**
 * The references of a definition that are not live rows of the tenant: a
 * product, category, brand or store that does not exist, is retired or is
 * deleted (`offer_reference_invalid`). The tenant is the session's, so another
 * tenant's id is indistinguishable from an absent one.
 */
export async function findInvalidReferences(
  client: PoolClient,
  tenantId: string,
  definition: OfferDefinition,
): Promise<ReferenceIssue[]> {
  const issues: ReferenceIssue[] = [];
  const check = async (
    table: string,
    liveColumn: string,
    ids: ReadonlyArray<string> | undefined,
    pointer: string,
  ): Promise<void> => {
    if (ids === undefined || ids.length === 0) return;
    const r = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM ${table} WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) AND ${liveColumn} IS NULL`,
      [tenantId, [...ids]],
    );
    const live = new Set(r.rows.map((x) => x.id));
    ids.forEach((id, i) => {
      if (!live.has(id)) issues.push({ field: `${pointer}/${i}` });
    });
  };
  const sets: Array<[string, EligibilityIds | undefined]> = [
    ["/eligibility/include", definition.eligibility.include],
    ["/eligibility/exclude", definition.eligibility.exclude],
  ];
  for (const [base, set] of sets) {
    await check("tenant_products", "retired_at", set?.productIds, `${base}/productIds`);
    await check("tenant_product_categories", "retired_at", set?.categoryIds, `${base}/categoryIds`);
    await check("tenant_product_brands", "retired_at", set?.brandIds, `${base}/brandIds`);
  }
  if ("storeIds" in definition.storeScope) {
    await check("stores", "deleted_at", definition.storeScope.storeIds, "/storeScope/storeIds");
  }
  return issues;
}

export interface SampleProduct {
  readonly productId: string;
  readonly sku: string | null;
  readonly name: string;
}

/** Up to `limit` products of an eligible id list, for the preview (§5.2 rule 5). */
export async function sampleProducts(
  client: PoolClient,
  tenantId: string,
  productIds: ReadonlyArray<string>,
  limit = 20,
): Promise<SampleProduct[]> {
  if (productIds.length === 0) return [];
  const r = await client.query<{ product_id: string; sku: string | null; name: string }>(
    `SELECT tp.id::text AS product_id, tp.name,
            (SELECT pa.value FROM product_aliases pa
              WHERE pa.tenant_id = tp.tenant_id AND pa.product_id = tp.id AND pa.identifier_type = 'sku' AND pa.retired_at IS NULL
              ORDER BY pa.store_id NULLS FIRST, pa.value LIMIT 1) AS sku
       FROM tenant_products tp
      WHERE tp.tenant_id = $1::uuid AND tp.id = ANY($2::uuid[])
      ORDER BY tp.id
      LIMIT $3`,
    [tenantId, productIds.slice(0, limit), limit],
  );
  return r.rows.map((p) => ({ productId: p.product_id, sku: p.sku, name: p.name }));
}
