/**
 * CashierSuspensionsModule: RT-1138, the per-store cashier suspension write API
 * and list on the 0106 storage. The enforcement points (cashier admission and
 * the POS roster) read the state in `pos-cashier-admissions` and need no
 * provider from here.
 *
 * Imports `AuthModule` (`PG_POOL`, the session guard's repositories) and
 * `ContextModule` (`TenantContextGuard`, the role lookup `RolesGuard` uses).
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { CashierSuspensionsController } from "./cashier-suspensions.controller";
import { CashierSuspensionsService } from "./cashier-suspensions.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [CashierSuspensionsController],
  providers: [CashierSuspensionsService],
})
export class CashierSuspensionsModule {}
