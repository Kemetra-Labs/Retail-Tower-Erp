/**
 * OffersModule — the Offer Engine V1 runtime (Jira RT-1337, RT-286 S4;
 * `offers.openapi.yaml`): the Console authoring and lifecycle routes and the
 * paired terminal's Offer Pack read.
 *
 * Imports:
 *   - `AuthModule`    — `PG_POOL`, the session repositories behind
 *                       `SessionOnlyAdminGuard`, and the device lookup pools.
 *   - `ContextModule` — `TenantContextGuard` and `MembershipRepository`.
 *   - `AuditModule`   — the `AuditEmitterInterceptor` behind `@Auditable`.
 * `DeviceRepository` (for `PosDeviceAuthGuard`) is built as in the cash
 * variance policy module: the device on the pre-tenant lookup pool, its tenant
 * status on the domain pool.
 */
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { AuditModule } from "../audit/audit.module";
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../auth/auth.module";
import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { ContextModule } from "../context/context.module";
import { DeviceRepository } from "../pos-operators/device.repository";
import { OfferPackService } from "./offer-pack.service";
import { OffersConsoleController } from "./offers-console.controller";
import { OffersPosController } from "./offers-pos.controller";
import { OffersService } from "./offers.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [OffersConsoleController, OffersPosController],
  providers: [
    OffersService,
    OfferPackService,
    {
      provide: DeviceRepository,
      useFactory: (lookupPool: Pool, domainPool: Pool): DeviceRepository => new DeviceRepository(lookupPool, domainPool),
      inject: [AUTH_LOOKUP_POOL, PG_POOL],
    },
    PosDeviceAuthGuard,
  ],
})
export class OffersModule {}
