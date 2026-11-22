/**
 * RT-1463 — sales' implementation of the catalog inverted port `PRODUCT_SALE_LINES_PORT`
 * (`catalog/tracking-profile/product-sale-lines.port.ts`), provided from a `@Global()` module that only
 * `app.module.ts` imports. Reads only sales' own `sale_lines`, on the caller's client.
 */
import type { PoolClient } from "pg";

import type { ProductSaleLinesPort } from "..";

export const productSaleLinesAdapter: ProductSaleLinesPort = {
  async hasSaleLines(client: Pick<PoolClient, "query">, productId: string): Promise<boolean> {
    const r = await client.query<{ found: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM sale_lines WHERE tenant_product_ref = $1) AS found`,
      [productId],
    );
    return r.rows[0]?.found === true;
  },
};
