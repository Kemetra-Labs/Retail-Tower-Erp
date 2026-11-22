/**
 * RT-1463 — provides the catalog inverted port `PRODUCT_SALE_LINES_PORT` (sales' adapter) to every module.
 *
 * `@Global()` and imported ONCE, by the composition root (`app.module.ts`), like
 * `PricingStoreLifecycleModule`. The Tracking Profile module must not import it (catalog may not import
 * sales, RT-1454 cycle).
 */
import { Global, Module } from "@nestjs/common";

import { PRODUCT_SALE_LINES_PORT } from "..";
import { productSaleLinesAdapter } from "./product-sale-lines.adapter";

@Global()
@Module({
  providers: [{ provide: PRODUCT_SALE_LINES_PORT, useValue: productSaleLinesAdapter }],
  exports: [PRODUCT_SALE_LINES_PORT],
})
export class ProductSaleLinesPortModule {}
