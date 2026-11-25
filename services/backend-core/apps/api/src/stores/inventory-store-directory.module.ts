/**
 * RT-1597 — provides inventory's inverted port `INVENTORY_STORE_DIRECTORY` (the tenant's live stores) to every module.
 *
 * `@Global()` and imported ONCE, by the composition root (`app.module.ts`). Inventory may not import Stores (Stores
 * already imports inventory, RT-1454), so inventory declares the port and Stores answers it here with its own lookup;
 * the `stores` SQL never leaves this module. A test module that needs the port imports this module too.
 */
import { Global, Module } from "@nestjs/common";

import { INVENTORY_STORE_DIRECTORY, type InventoryStoreDirectory } from "../inventory";
import { liveAndNamedStores } from "./store-lookups";

const directory: InventoryStoreDirectory = { liveAndNamedStores };

@Global()
@Module({
  providers: [{ provide: INVENTORY_STORE_DIRECTORY, useValue: directory }],
  exports: [INVENTORY_STORE_DIRECTORY],
})
export class InventoryStoreDirectoryModule {}
