/**
 * RT-1074 data layer: typed wrappers over the generated `apiClient` for the five
 * operations of Backend-Core's `catalog/stock-levels.yaml` (RT-1064 TH-1 to TH-5,
 * served since RT-1066):
 *
 *   - `consoleGetProductStockLevels`  GET  …/stock-levels: the tenant level and
 *     the store levels of the caller's store scope.
 *   - `consoleSetTenantStockLevel`    PUT  …/stock-levels (Idempotency-Key).
 *   - `consoleRetireTenantStockLevel` POST …/stock-levels/retire.
 *   - `consoleSetStoreStockLevel`     PUT  …/stock-levels/stores/{storeId} (Idempotency-Key).
 *   - `consoleRetireStoreStockLevel`  POST …/stock-levels/stores/{storeId}/retire.
 *
 * Levels are exact decimal strings and pass through untouched: nothing here
 * parses, rounds or reformats them. Same `{ status, data?, error? }` shape as
 * `src/lib/catalog-queries.ts`; a set also answers whether the server replayed
 * a stored result (`Idempotent-Replayed: true`). Cookie transport is on the
 * generated client. No hand-rolled fetch, no ERPNext value (TH-1).
 */
import { apiClient } from "@/generated/client";
import type { StockLevelsSchema } from "@/generated/schema";

type Schemas = StockLevelsSchema.components["schemas"];

// --- Generated projections (no hand-typed shapes) -----------------------------

export type ProductStockLevels = Schemas["ProductStockLevels"];
export type TenantStockLevel = Schemas["StockLevel"];
export type StoreStockLevel = Schemas["StoreStockLevel"];
export type SetStockLevelRequest = Schemas["SetStockLevelRequest"];

/** The `Idempotent-Replayed: true` header of a replayed set. */
function replayedOf(response: Response): boolean {
  return response.headers.get("Idempotent-Replayed") === "true";
}

// --- Typed operation wrappers -------------------------------------------------

/** GET /api/v1/catalog/products/{productId}/stock-levels */
export async function consoleGetProductStockLevels(productId: string) {
  const { data, error, response } = await apiClient.GET(
    "/api/v1/catalog/products/{productId}/stock-levels",
    { params: { path: { productId } } },
  );
  return { status: response.status, data, error };
}

/** PUT /api/v1/catalog/products/{productId}/stock-levels: 200 returns the levels after the change. */
export async function consoleSetTenantStockLevel(
  productId: string,
  body: SetStockLevelRequest,
  idempotencyKey: string,
) {
  const { data, error, response } = await apiClient.PUT(
    "/api/v1/catalog/products/{productId}/stock-levels",
    { params: { path: { productId }, header: { "Idempotency-Key": idempotencyKey } }, body },
  );
  return { status: response.status, data, error, replayed: replayedOf(response) };
}

/** POST /api/v1/catalog/products/{productId}/stock-levels/retire: 200 returns the levels. */
export async function consoleRetireTenantStockLevel(productId: string, expectedUpdatedAt: string) {
  const { data, error, response } = await apiClient.POST(
    "/api/v1/catalog/products/{productId}/stock-levels/retire",
    { params: { path: { productId } }, body: { expectedUpdatedAt } },
  );
  return { status: response.status, data, error };
}

/** PUT /api/v1/catalog/products/{productId}/stock-levels/stores/{storeId}: 200 returns the levels. */
export async function consoleSetStoreStockLevel(
  productId: string,
  storeId: string,
  body: SetStockLevelRequest,
  idempotencyKey: string,
) {
  const { data, error, response } = await apiClient.PUT(
    "/api/v1/catalog/products/{productId}/stock-levels/stores/{storeId}",
    {
      params: { path: { productId, storeId }, header: { "Idempotency-Key": idempotencyKey } },
      body,
    },
  );
  return { status: response.status, data, error, replayed: replayedOf(response) };
}

/** POST /api/v1/catalog/products/{productId}/stock-levels/stores/{storeId}/retire: 200 returns the levels. */
export async function consoleRetireStoreStockLevel(
  productId: string,
  storeId: string,
  expectedUpdatedAt: string,
) {
  const { data, error, response } = await apiClient.POST(
    "/api/v1/catalog/products/{productId}/stock-levels/stores/{storeId}/retire",
    { params: { path: { productId, storeId } }, body: { expectedUpdatedAt } },
  );
  return { status: response.status, data, error };
}
