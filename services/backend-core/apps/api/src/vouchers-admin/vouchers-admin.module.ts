/**
 * VouchersAdminModule — RT-1108: the Console voucher issuance routes
 * (`vouchers-admin.openapi.yaml`).
 *
 * Imports:
 *   - `AuthModule`    — `PG_POOL` + the repositories `DashboardAuthGuard` uses.
 *   - `ContextModule` — `TenantContextGuard` and `MembershipRepository` (`RolesGuard`).
 *   - `AuditModule`   — the global `AuditEmitterInterceptor` behind `@Auditable` (the two reads).
 * The `IdempotencyInterceptor` the two POSTs engage is global (APP_INTERCEPTOR).
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { VouchersAdminController } from "./vouchers-admin.controller";
import { VouchersAdminService } from "./vouchers-admin.service";

@Module({
  imports: [AuthModule, ContextModule, AuditModule],
  controllers: [VouchersAdminController],
  providers: [VouchersAdminService],
})
export class VouchersAdminModule {}
