/**
 * RT-1338 brand data layer (RT-1334 contract, `catalog/console-catalog.yaml`): typed wrappers over
 * the generated `apiClient` for the three brand operations. Kept out of `catalog-queries.ts`,
 * whose boundary test pins exactly the product operations.
 *
 *   - `consoleListCatalogBrands`: the tenant's whole non-retired list, `name ASC`, no query.
 *   - `consoleCreateCatalogBrand`: POST one brand, one Idempotency-Key per attempt.
 *   - `consoleRenameCatalogBrand`: PATCH one brand with `expectedUpdatedAt`.
 *
 * There is no brand retire in the contract. The brand of a product is the `brandId` of the product
 * edit (`consoleUpdateCatalogProduct`). Same `{ status, data?, error? }` shape as the rest of
 * `src/lib`; no hand-rolled fetch.
 */
import { apiClient } from "@/generated/client";
import type { ConsoleCatalogSchema } from "@/generated/schema";

export type CatalogBrand = ConsoleCatalogSchema.components["schemas"]["ConsoleCatalogBrand"];

/** GET /api/v1/catalog/brands: every non-retired brand, `name ASC`; not paginated, no query. */
export async function consoleListCatalogBrands() {
  const { data, error, response } = await apiClient.GET("/api/v1/catalog/brands");
  return { status: response.status, data, error };
}

/** POST /api/v1/catalog/brands: 201 returns the brand. A same-key retry replays the 201. */
export async function consoleCreateCatalogBrand(name: string, idempotencyKey: string) {
  const { data, error, response } = await apiClient.POST("/api/v1/catalog/brands", {
    params: { header: { "Idempotency-Key": idempotencyKey } },
    body: { name },
  });
  return { status: response.status, data, error };
}

/** PATCH /api/v1/catalog/brands/{brandId}: 200 returns the brand with its new `updatedAt`. */
export async function consoleRenameCatalogBrand(
  brandId: string,
  name: string,
  expectedUpdatedAt: string,
) {
  const { data, error, response } = await apiClient.PATCH("/api/v1/catalog/brands/{brandId}", {
    params: { path: { brandId } },
    body: { name, expectedUpdatedAt },
  });
  return { status: response.status, data, error };
}
