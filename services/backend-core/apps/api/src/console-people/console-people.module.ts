/**
 * ConsolePeopleModule — RT-1063: the console people-name read
 * (`console-people.openapi.yaml`, RT-968). Read only.
 *
 * Imports:
 *   - `AuthModule`    — `PG_POOL` + the session/token repositories the
 *                       session-only `SessionOnlyAdminGuard` uses.
 *   - `ContextModule` — `TenantContextGuard` (publishes `request.context`) and
 *                       `MembershipRepository` (the caller's role → store scope).
 *   - `AuditModule`   — the global `AuditEmitterInterceptor` the `@Auditable`
 *                       decorator triggers.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { ConsolePeopleController } from "./console-people.controller";
import { ConsolePeopleService } from "./console-people.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [ConsolePeopleController],
  providers: [ConsolePeopleService],
})
export class ConsolePeopleModule {}
