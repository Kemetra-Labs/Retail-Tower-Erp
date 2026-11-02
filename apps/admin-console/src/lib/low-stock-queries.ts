/**
 * RT-1073 data layer: typed wrapper over the generated `apiClient` for the one
 * read behind the Overview low-stock widget (RT-1055 contract, RT-1069 runtime):
 *
 *   - `consoleListLowStock`: the top `limit` (store, product) pairs below their
 *     reorder level, most severe first, with the scope's counts.
 *
 * Every figure is the server's. Nothing here sorts, sums or derives a figure.
 */
import { apiClient } from "@/generated/client";
import type { LowStockSchema } from "@/generated/schema";

type Schemas = LowStockSchema.components["schemas"];

export type LowStockList = Schemas["ConsoleLowStockList"];
export type LowStockItem = Schemas["LowStockItem"];
export type LowStockQuery = NonNullable<
  LowStockSchema.operations["consoleListLowStock"]["parameters"]["query"]
>;

/** The widget's top-N (the contract default). */
export const LOW_STOCK_LIMIT = 10;

/** GET /api/v1/inventory/low-stock. */
export async function consoleListLowStock(query: LowStockQuery = {}) {
  const { data, error, response } = await apiClient.GET("/api/v1/inventory/low-stock", {
    params: { query: { limit: LOW_STOCK_LIMIT, ...query } },
  });
  return { status: response.status, data, error };
}
