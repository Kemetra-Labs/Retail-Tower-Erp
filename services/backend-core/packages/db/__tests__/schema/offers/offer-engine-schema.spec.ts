/**
 * RT-1336 (RT-286 spec 048 S3) — Offer Engine Drizzle schema shape and the
 * data-lifecycle classification guard (SI-012, Constitution §XIV).
 *
 * Docker-free. The ten tables are BUSINESS-CLASS (the prose is in
 * `0101_offer_engine.sql`): offer names and a pause reason (short free text,
 * "no PII" by contract), opaque UUIDs (user ids are operational actors), whole
 * numbers, a percent, money amounts, dates and timestamps, and the JSONB draft,
 * which holds only the same fields. The column inventory is pinned exactly, so
 * a later slice adding, removing or renaming a column fails here and forces a
 * §XIV re-review. The SQL truth is 0101 (its migration spec also checks that
 * these Drizzle columns match the database).
 */
import { getTableColumns, getTableName } from "drizzle-orm";
import type { getTableConfig } from "drizzle-orm/pg-core";

import * as schema from "../../../src/schema";

type DrizzleTable = Parameters<typeof getTableConfig>[0];
const table = (name: string): DrizzleTable => (schema as unknown as Record<string, DrizzleTable>)[name]!;

const OFFER_ENGINE_COLUMNS: Readonly<Record<string, { readonly export: string; readonly columns: readonly string[] }>> = {
  offers: {
    export: "offers",
    columns: [
      "id", "tenant_id", "draft_revision", "draft_definition", "draft_updated_at", "draft_updated_by_user_id",
      "ended_at", "ended_by_user_id", "archived_at", "archived_by_user_id", "created_by_user_id", "created_at",
      "updated_at",
    ],
  },
  offer_versions: {
    export: "offerVersions",
    columns: [
      "tenant_id", "offer_id", "version", "name_ar", "name_en", "offer_type", "buy_quantity", "get_quantity",
      "percent_off", "reward_selection", "max_applications_per_sale", "price_basis", "all_stores", "time_basis",
      "starts_local", "ends_local", "starts_at", "ends_at", "offline_policy", "eligible_set_count",
      "published_by_user_id", "published_at", "publish_xact",
    ],
  },
  offer_version_stores: { export: "offerVersionStores", columns: ["tenant_id", "offer_id", "version", "store_id"] },
  offer_version_rules: {
    export: "offerVersionRules",
    columns: ["id", "tenant_id", "offer_id", "version", "effect", "product_id", "category_id", "brand_id"],
  },
  offer_pauses: {
    export: "offerPauses",
    columns: [
      "id", "tenant_id", "offer_id", "store_id", "reason", "paused_by_user_id", "paused_at", "resumed_by_user_id",
      "resumed_at",
    ],
  },
  offer_pack_revisions: { export: "offerPackRevisions", columns: ["tenant_id", "revision", "created_at", "issue_xact"] },
  offer_pack_store_revisions: {
    export: "offerPackStoreRevisions",
    columns: ["tenant_id", "store_id", "applied_revision", "created_at", "updated_at"],
  },
  offer_pack_eligible_products: {
    export: "offerPackEligibleProducts",
    columns: ["tenant_id", "store_id", "product_id", "offer_id", "offer_version", "from_revision", "to_revision"],
  },
  sale_line_promotions: {
    export: "saleLinePromotions",
    columns: [
      "sale_line_id", "sale_id", "tenant_id", "store_id", "offer_id", "offer_version", "pack_revision",
      "discount_amount", "created_at",
    ],
  },
  sale_return_promotion_clawbacks: {
    export: "saleReturnPromotionClawbacks",
    columns: ["return_id", "tenant_id", "store_id", "offer_id", "offer_version", "amount", "created_at"],
  },
};

/** Column names that would signal customer PII or payment data (never on these tables). */
const DENYLIST = /(customer|phone|email|national|address|card|iban|account_number|payment_method|instrument|holder)/;

describe("schema/offers (RT-1336): the ten Offer Engine tables", () => {
  it.each(Object.entries(OFFER_ENGINE_COLUMNS))("%s: exported, with exactly the classified columns", (name, spec) => {
    const t = table(spec.export);
    expect(getTableName(t)).toBe(name);
    const cols = Object.values(getTableColumns(t) as Record<string, { name: string }>).map((c) => c.name);
    expect(cols.sort()).toEqual([...spec.columns].sort());
    expect(cols.filter((c) => DENYLIST.test(c))).toEqual([]);
  });

  it("keeps money at the sale_lines scale, numeric(19,4)", () => {
    const money = [
      (getTableColumns(table("saleLinePromotions")) as Record<string, { getSQLType: () => string }>)["discountAmount"]!,
      (getTableColumns(table("saleReturnPromotionClawbacks")) as Record<string, { getSQLType: () => string }>)["amount"]!,
    ];
    expect(money.map((c) => c.getSQLType())).toEqual(["numeric(19, 4)", "numeric(19, 4)"]);
  });
});
