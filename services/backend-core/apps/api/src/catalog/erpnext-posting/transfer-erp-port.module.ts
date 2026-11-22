/**
 * RT-1463 — provides Inventory's inverted port `TRANSFER_ERP_PORT` (the ERP posting adapter) to every module.
 *
 * `@Global()` and imported ONCE, by the composition root (`app.module.ts`), like
 * `PricingStoreLifecycleModule`. `InventoryModule` must not import it: Inventory may not import the ERP
 * posting code (RT-1454 cycle). A test module that mounts `InventoryModule` without `AppModule` imports this
 * module too; without it Nest refuses to boot, which is intended (the binding is not optional).
 */
import { Global, Module } from "@nestjs/common";

import { TRANSFER_ERP_PORT } from "../../inventory";
import { transferErpAdapter } from "./transfer-erp.adapter";

@Global()
@Module({
  providers: [{ provide: TRANSFER_ERP_PORT, useValue: transferErpAdapter }],
  exports: [TRANSFER_ERP_PORT],
})
export class TransferErpPortModule {}
