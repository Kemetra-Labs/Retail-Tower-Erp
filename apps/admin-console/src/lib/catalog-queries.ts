/**
 * RT-765 / RT-766 data layer: typed wrappers over the generated `apiClient` for
 * the three read operations the catalog list and detail need from Backend-Core's
 * console catalog contract (`catalog/console-catalog.yaml`, RT-729 / RT-730):
 *
 *   - `consoleListCatalogProducts`: the tenant's products, keyset paged, with a
 *     store's resolved values when `store_id` is given.
 *   - `consoleListCatalogCategories`: the flat category list for the filter.
 *   - `consoleGetCatalogProduct`: one product with its active identifiers and
 *     its raw store overrides (never resolved: RT-752 D8).
 *
 * RT-768 adds exactly TWO writes of the RT-738 contract, on the generated client:
 *
 *   - `consoleUpdateCatalogProduct`: PATCH one product (only the fields given,
 *     with `expectedUpdatedAt`).
 *   - `consoleRetireCatalogProduct`: POST the product's retire (irreversible on
 *     this surface).
 *
 * RT-770 adds the two store-override writes (CAT-C2c), on the generated client:
 *
 *   - `consoleUpsertStoreOverride`: PUT a store's availability / tax category
 *     override (never its price, O-2), with `expectedUpdatedAt`.
 *   - `consoleRetireStoreOverride`: POST the store override's retire.
 *
 * Boundary: these seven operations are all that is wrapped. Product CREATE is
 * held by owner decision D9 (RT-768 comment 13487) until pricing lands (RT-484 /
 * RT-485), and the identifier writes belong to RT-769.
 * No POS route and no ERP call. Same `{ status, data?, error? }` shape as `src/lib/sale-queries.ts`;
 * cookie transport is on the generated client. No hand-rolled fetch.
 */
import { apiClient } from "@/generated/client";
import type { ConsoleCatalogSchema } from "@/generated/schema";

type Schemas = ConsoleCatalogSchema.components["schemas"];

// --- Generated projections (no hand-typed shapes) -----------------------------

export type CatalogProduct = Schemas["ConsoleCatalogProductSummary"];
export type CatalogProductPage = Schemas["ConsoleCatalogProductPage"];
export type CatalogProductDetail = Schemas["ConsoleCatalogProductDetail"];
export type CatalogIdentifier = Schemas["ProductIdentifier"];
export type CatalogStoreOverride = Schemas["StoreOverride"];
export type CatalogMoney = Schemas["Money"];
export type CatalogCategory = Schemas["ConsoleCatalogCategory"];
export type CatalogStatusFilter = Schemas["ProductStatusFilter"];
export type CatalogProductUpdate = Schemas["UpdateCatalogProductRequest"];
/**
 * RT-770: the upsert body (`UpsertStoreOverrideRequest`). The generated schema is a
 * `oneOf` union with `unknown` members, which collapses to `unknown`, so the shape
 * is restated here field for field. An absent field is left as is; `null` clears
 * it. There is no price (O-2).
 */
export interface CatalogStoreOverrideUpsert {
  expectedUpdatedAt: string | null;
  isActive?: boolean | null;
  taxCategory?: string | null;
}
export type CatalogListQuery =
  ConsoleCatalogSchema.operations["consoleListCatalogProducts"]["parameters"]["query"];

// --- Typed operation wrappers -------------------------------------------------

/** GET /api/v1/catalog/products */
export async function consoleListCatalogProducts(query: CatalogListQuery) {
  const { data, error, response } = await apiClient.GET("/api/v1/catalog/products", {
    params: { query },
  });
  return { status: response.status, data, error };
}

/** GET /api/v1/catalog/categories */
export async function consoleListCatalogCategories() {
  const { data, error, response } = await apiClient.GET("/api/v1/catalog/categories");
  return { status: response.status, data, error };
}

/** GET /api/v1/catalog/products/{productId} */
export async function consoleGetCatalogProduct(productId: string) {
  const { data, error, response } = await apiClient.GET("/api/v1/catalog/products/{productId}", {
    params: { path: { productId } },
  });
  return { status: response.status, data, error };
}

/** PATCH /api/v1/catalog/products/{productId}: 200 returns the detail after the change. */
export async function consoleUpdateCatalogProduct(productId: string, body: CatalogProductUpdate) {
  const { data, error, response } = await apiClient.PATCH("/api/v1/catalog/products/{productId}", {
    params: { path: { productId } },
    body,
  });
  return { status: response.status, data, error };
}

/** POST /api/v1/catalog/products/{productId}/retire: 200 returns the detail, `status` `retired`. */
export async function consoleRetireCatalogProduct(productId: string, expectedUpdatedAt: string) {
  const { data, error, response } = await apiClient.POST(
    "/api/v1/catalog/products/{productId}/retire",
    { params: { path: { productId } }, body: { expectedUpdatedAt } },
  );
  return { status: response.status, data, error };
}

/**
 * PUT /api/v1/catalog/products/{productId}/store-overrides/{storeId} (RT-770):
 * 200 returns the detail after the change, its `storeOverrides` carrying the new override.
 */
export async function consoleUpsertStoreOverride(
  productId: string,
  storeId: string,
  body: CatalogStoreOverrideUpsert,
) {
  const { data, error, response } = await apiClient.PUT(
    "/api/v1/catalog/products/{productId}/store-overrides/{storeId}",
    { params: { path: { productId, storeId } }, body },
  );
  return { status: response.status, data, error };
}

/** POST /api/v1/catalog/products/{productId}/store-overrides/{storeId}/retire (RT-770): 200 returns the detail. */
export async function consoleRetireStoreOverride(
  productId: string,
  storeId: string,
  expectedUpdatedAt: string,
) {
  const { data, error, response } = await apiClient.POST(
    "/api/v1/catalog/products/{productId}/store-overrides/{storeId}/retire",
    { params: { path: { productId, storeId } }, body: { expectedUpdatedAt } },
  );
  return { status: response.status, data, error };
}
