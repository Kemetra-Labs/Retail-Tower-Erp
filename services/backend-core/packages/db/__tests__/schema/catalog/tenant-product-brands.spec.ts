/**
 * RT-1334 (RT-286 spec 048 S1) — `tenant_product_brands` Drizzle schema shape.
 *
 * A flat, tenant-owned brand taxonomy shaped like `tenant_product_categories`:
 * no parent and no description, `retired_at` as the active flag, active names
 * unique per tenant (partial unique index), and `(tenant_id, id)` unique as
 * the composite FK target of `tenant_products.brand_id`. The SQL truth is
 * `0097_tenant_product_brands.sql` (its own migration spec runs it).
 */
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import * as schema from "../../../src/schema";

type DrizzleTable = Parameters<typeof getTableConfig>[0];
const brands = (schema as unknown as { tenantProductBrands: DrizzleTable }).tenantProductBrands;

const render = (sql: import("drizzle-orm").SQL): string => new PgDialect().sqlToQuery(sql).sql.replaceAll('"', "");

describe("schema/catalog/tenant_product_brands (RT-1334)", () => {
  it("is exported from the barrel as `tenant_product_brands`", () => {
    expect(getTableName(brands)).toBe("tenant_product_brands");
  });

  it("has exactly the category-shaped columns: no parent, no description", () => {
    const cols = getTableColumns(brands) as Record<string, { name: string; notNull: boolean; getSQLType: () => string }>;
    expect(Object.values(cols).map((c) => c.name).sort()).toEqual(
      ["created_at", "created_by", "id", "name", "retired_at", "tenant_id", "updated_at"].sort(),
    );
    expect(cols["tenantId"]?.notNull).toBe(true);
    expect(cols["name"]?.getSQLType()).toBe("text");
    expect(cols["name"]?.notNull).toBe(true);
    expect(cols["retiredAt"]?.notNull).toBe(false);
  });

  it("references tenants with ON DELETE RESTRICT", () => {
    const fks = getTableConfig(brands).foreignKeys;
    expect(fks).toHaveLength(1);
    const ref = fks[0]!.reference();
    expect(getTableName(ref.foreignTable)).toBe("tenants");
    expect(ref.columns.map((c) => c.name)).toEqual(["tenant_id"]);
    expect(fks[0]!.onDelete).toBe("restrict");
  });

  it("keeps active names unique per tenant and (tenant_id, id) unique", () => {
    const cfg = getTableConfig(brands);
    const nameIdx = cfg.indexes.find((i) => i.config.name === "UQ_idx_tenant_product_brands_tenant_name");
    expect(nameIdx?.config.unique).toBe(true);
    expect(render(nameIdx!.config.where!)).toMatch(/retired_at IS NULL/);
    const uk = cfg.uniqueConstraints.find((u) => u.name === "tenant_product_brands_tenant_id_uk");
    expect(uk?.columns.map((c) => c.name)).toEqual(["tenant_id", "id"]);
  });

  it("bounds the name to 1..200 characters", () => {
    const check = getTableConfig(brands).checks.find((c) => c.name === "tenant_product_brands_name_length");
    expect(render(check!.value)).toMatch(/BETWEEN 1 AND 200/);
  });
});
