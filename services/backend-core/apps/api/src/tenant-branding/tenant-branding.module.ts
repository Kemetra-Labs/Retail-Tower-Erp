/**
 * TenantBrandingModule — RT-473 S2 (spec 039): the tenant logo runtime of
 * tenant-branding.openapi.yaml: the POS device read and the Console read,
 * preview, save and remove.
 *
 * Imports:
 *   - `AuthModule`    — `PG_POOL` and the session/token repositories of the
 *                       session-only `SessionOnlyAdminGuard`.
 *   - `ContextModule` — `TenantContextGuard` (the session's tenant and role).
 *   - `AuditModule`   — the `AuditEmitterInterceptor` the reads use.
 *
 * `DeviceRepository` (for `PosDeviceAuthGuard`) is built as in ReadDownModule:
 * the device on the pre-tenant lookup pool, its tenant status on the domain pool.
 *
 * The upload routes also need `logoUploadPassthrough` registered on the HTTP
 * adapter before the body parsers (main.ts), see logo-body.ts.
 */
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { AuditModule } from "../audit/audit.module";
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../auth/auth.module";
import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { ContextModule } from "../context/context.module";
import { DeviceRepository } from "../pos-operators/device.repository";
import { TenantBrandingConsoleController } from "./branding-console.controller";
import { TenantBrandingDeviceController } from "./branding-device.controller";
import { TenantBrandingService } from "./branding.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [TenantBrandingConsoleController, TenantBrandingDeviceController],
  providers: [
    TenantBrandingService,
    {
      provide: DeviceRepository,
      useFactory: (lookupPool: Pool, domainPool: Pool): DeviceRepository => new DeviceRepository(lookupPool, domainPool),
      inject: [AUTH_LOOKUP_POOL, PG_POOL],
    },
    PosDeviceAuthGuard,
  ],
})
export class TenantBrandingModule {}
