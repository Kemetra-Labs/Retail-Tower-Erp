/**
 * RT-1463 — what the Tracking Profile setter needs from sales, declared by `catalog` (an inverted port,
 * like `stores/store-pricing-lifecycle.port.ts`).
 *
 * Sales imports `catalog` (the profile lock and the product reads), so `catalog` may not import sales:
 * that closes a module cycle (RT-1454). Catalog declares this interface and its DI token; sales
 * implements it (`sales/product-sale-lines.adapter.ts`) and provides it from a `@Global()` module that
 * only the composition root (`app.module.ts`) imports. Runs on the CALLER's client.
 */
import type { PoolClient } from "pg";

/** The DI token sales provides `ProductSaleLinesPort` under. */
export const PRODUCT_SALE_LINES_PORT = "PRODUCT_SALE_LINES_PORT";

export interface ProductSaleLinesPort {
  /** Whether any captured sale line names `productId` (387: a captured sale line locks the profile). */
  hasSaleLines(client: Pick<PoolClient, "query">, productId: string): Promise<boolean>;
}
