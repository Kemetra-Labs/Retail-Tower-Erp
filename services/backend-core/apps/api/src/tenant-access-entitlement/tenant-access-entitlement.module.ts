/**
 * TenantAccessEntitlementModule — RT-1353: the tenant access state
 * (`restricted` / `unrestricted`) read for the Console banner and the
 * platform-admin unlock and mark-provisioned actions, on the 0104 storage.
 * The enforcement points (pairing, posting) read the state through
 * `@data-pulse-2/db` (`readTenantAccessState`) and need no provider from here.
 *
 * Imports `AuthModule` (`PG_POOL`, the session guard's repositories) and
 * `ContextModule` (`TenantContextGuard`, `MembershipRepository`).
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import {
  TenantAccessEntitlementConsoleController,
  TenantAccessEntitlementPlatformController,
} from "./access-entitlement.controller";
import { AccessEntitlementService } from "./access-entitlement.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [TenantAccessEntitlementConsoleController, TenantAccessEntitlementPlatformController],
  providers: [AccessEntitlementService],
})
export class TenantAccessEntitlementModule {}
