/**
 * PosTelemetryModule — the POS device telemetry tunnel (RT-1252).
 *
 * Imports AuthModule for the shared Redis-backed RateLimiter and the pools.
 * `PosDeviceAuthGuard` ← `DeviceRepository` on `AUTH_LOOKUP_POOL` (the
 * pre-tenant device lookup), as in `DeviceHealthModule`. The network call
 * goes through POS_TELEMETRY_FETCH (global `fetch`), so tests replace it.
 */
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../auth/auth.module";
import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import type { TelemetryFetch } from "../console-telemetry/console-telemetry.forwarder";
import { DeviceRepository } from "../pos-operators/device.repository";
import { PosTelemetryController } from "./pos-telemetry.controller";
import { POS_TELEMETRY_FETCH, PosTelemetryForwarder } from "./pos-telemetry.forwarder";

const globalFetch: TelemetryFetch = (url, init) => fetch(url, init);

/** The POS device telemetry tunnel module (RT-1252), registered in AppModule. */
@Module({
  imports: [AuthModule],
  controllers: [PosTelemetryController],
  providers: [
    {
      provide: DeviceRepository,
      useFactory: (lookupPool: Pool, domainPool: Pool): DeviceRepository => new DeviceRepository(lookupPool, domainPool),
      inject: [AUTH_LOOKUP_POOL, PG_POOL],
    },
    PosDeviceAuthGuard,
    PosTelemetryForwarder,
    { provide: POS_TELEMETRY_FETCH, useValue: globalFetch },
  ],
})
export class PosTelemetryModule {}
