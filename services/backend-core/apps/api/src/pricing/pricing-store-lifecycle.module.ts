/**
 * RT-1525 — provides the stores port `STORE_PRICING_LIFECYCLE` (Pricing's adapter) to every module.
 *
 * `@Global()` and imported ONCE, by the composition root (`app.module.ts`), like `DatabaseModule`.
 * `StoresModule` must not import it: Stores may not import Pricing (RT-1454 cycle). A test module that
 * mounts `StoresModule` without `AppModule` imports this module too; without it Nest refuses to boot,
 * which is intended (the binding is not optional).
 */
import { Global, Module } from "@nestjs/common";

import { STORE_PRICING_LIFECYCLE } from "../stores";
import { PricingStoreLifecycleAdapter } from "./store-lifecycle/pricing-store-lifecycle.adapter";

@Global()
@Module({
  providers: [PricingStoreLifecycleAdapter, { provide: STORE_PRICING_LIFECYCLE, useExisting: PricingStoreLifecycleAdapter }],
  exports: [STORE_PRICING_LIFECYCLE],
})
export class PricingStoreLifecycleModule {}
