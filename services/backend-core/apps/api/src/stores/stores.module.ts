/**
 * StoresModule — slice US2 (T134).
 *
 * Wires the store-CRUD surface:
 *
 *   StoresController
 *     ├─ AuthGuard            (from AuthModule, class-level)
 *     ├─ TenantContextGuard   (from ContextModule, class-level)
 *     ├─ RolesGuard           (per-method on POST/PATCH/DELETE)
 *     │     ├─ Reflector         (auto-provided by @nestjs/core)
 *     │     └─ MembershipRepository (from ContextModule)
 *     └─ StoresService
 *          ├─ PG_POOL          (from AuthModule)
 *          ├─ StoresRepository (provided here)
 *          ├─ MembershipRepository (from ContextModule)
 *          └─ STORE_PRICING_LIFECYCLE (RT-1525; provided by Pricing's @Global()
 *             PricingStoreLifecycleModule, imported by app.module.ts only —
 *             never import Pricing here, that closes a module cycle)
 *
 * `ContextModule` is imported for both `TenantContextGuard` (which it
 * exports for downstream modules to mount) and `MembershipRepository`
 * (used by `StoresService` for the `kind='specific'` store-access
 * check on read).
 *
 * `RolesGuard` is registered as a plain class provider; Nest auto-
 * provides `Reflector`, and `MembershipRepository` is reachable via
 * the `ContextModule` import. No `useFactory` needed.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { RolesGuard } from "../auth/roles.guard";
import { ContextModule } from "../context/context.module";
import { ConsoleReauthService } from "./deletion/reauth.service";
import { ReauthGrantStore } from "./deletion/reauth-grant.store";
import { StoreDeletionController } from "./deletion/store-deletion.controller";
import { ReauthRoleGuard, StoreDeletionOwnerGuard } from "./deletion/store-deletion-owner.guard";
import { StoreDeletionService } from "./deletion/store-deletion.service";
import { StoresController } from "./stores.controller";
import { StoresRepository } from "./stores.repository";
import { StoresService } from "./stores.service";

/**
 * RT-1439: the guarded store deletion (`StoreDeletionController`: the preview, the owner-only
 * deletion and the re-authentication that deletion needs) shares this module's repository and
 * pool. The interceptor `consoleDeleteStore` is `@Idempotent` on is the global `APP_INTERCEPTOR`
 * of `IdempotencyModule` (imported by other modules such as `DevicesModule`); this module does not
 * import it, so the existing StoresModule specs do not need its providers.
 */
@Module({
  imports: [AuthModule, ContextModule],
  controllers: [StoresController, StoreDeletionController],
  providers: [
    StoresRepository,
    StoresService,
    RolesGuard,
    StoreDeletionOwnerGuard,
    ReauthRoleGuard,
    StoreDeletionService,
    ConsoleReauthService,
    ReauthGrantStore,
  ],
  exports: [StoresService, StoresRepository],
})
export class StoresModule {}
