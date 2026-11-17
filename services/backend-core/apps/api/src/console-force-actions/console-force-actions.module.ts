/**
 * ConsoleForceActionsModule — RT-1445: the Console open-shifts read, force-close
 * preview and force close (`console-force-actions.openapi.yaml`), over the
 * existing `ShiftForceCloseService` rows and stuck rule.
 *
 * Imports:
 *   - `AuthModule`    — `PG_POOL` (the NOBYPASSRLS domain pool) and the
 *                       session/token repositories `SessionOnlyAdminGuard` uses.
 *   - `ContextModule` — `TenantContextGuard` and `MembershipRepository` (the
 *                       caller's role and store authority).
 *
 * `IdempotencyModule`'s interceptor is the app-wide one (as in
 * `StockLevelsModule`); the audit row is written in the write's transaction, so
 * `AuditModule` is not needed.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { ConsoleForceActionsController } from "./console-force-actions.controller";
import { ConsoleForceActionsService } from "./console-force-actions.service";
import { ForceActionAccessGuard } from "./force-action-access.guard";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [ConsoleForceActionsController],
  providers: [ConsoleForceActionsService, ForceActionAccessGuard],
})
export class ConsoleForceActionsModule {}
