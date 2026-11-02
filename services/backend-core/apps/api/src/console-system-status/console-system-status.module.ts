/**
 * ConsoleSystemStatusModule — RT-1062: the console system-status read
 * (`console-system-status.openapi.yaml`, RT-1056). Read only.
 *
 * Imports:
 *   - `AuthModule`    — `PG_POOL` + the session/token repositories the
 *                       session-only `SessionOnlyAdminGuard` uses.
 *   - `ContextModule` — `TenantContextGuard` (publishes `request.context`).
 *
 * No AuditModule: the read is not audited (D-4). No outbound ERPNext call.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { ConsoleSystemStatusController } from "./console-system-status.controller";
import {
  CONSOLE_SYSTEM_STATUS_CHECK_TIMEOUT_MS,
  ConsoleSystemStatusService,
  DEFAULT_CHECK_TIMEOUT_MS,
} from "./console-system-status.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [ConsoleSystemStatusController],
  providers: [
    ConsoleSystemStatusService,
    { provide: CONSOLE_SYSTEM_STATUS_CHECK_TIMEOUT_MS, useValue: DEFAULT_CHECK_TIMEOUT_MS },
  ],
})
export class ConsoleSystemStatusModule {}
