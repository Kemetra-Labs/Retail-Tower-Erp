/**
 * VouchersPosModule — RT-1112 (RT-1098 slice R-3): the V-A routes
 * (`pos-payments/vouchers.yaml`): validate, redeem and reverse.
 *
 * Imports:
 *   - `AuthModule`        — `PG_POOL`, `AUTH_LOOKUP_POOL` and `RateLimiter`.
 *   - `IdempotencyModule` — `IDEMPOTENCY_KEY_STORE` for the redeem replay
 *     lookup; the `IdempotencyInterceptor` itself is global (APP_INTERCEPTOR).
 * The guards are class-referenced on the routes (reflection-instantiated), so
 * every dependency here is a plain, module-resolvable token.
 */
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../auth/auth.module";
import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import {
  PgTrackedLineCashierVerifier,
  TRACKED_LINE_CASHIER_VERIFIER,
  type TrackedLineCashierVerifier,
} from "../catalog/sales/tracked-lines/tracked-line-cashier";
import { IdempotencyModule } from "../idempotency/idempotency.module";
import { CashierEligibilityRepository } from "../pos-cashier-admissions/cashier-eligibility";
import { DeviceRepository } from "../pos-operators/device.repository";
import { RedeemVoucherAuthGuard, ValidateVoucherAuthGuard } from "./voucher-cashier-auth.guard";
import { VoucherLookupLimiter } from "./voucher-lookup-limit";
import { VouchersPosController } from "./vouchers-pos.controller";
import { VouchersPosService } from "./vouchers-pos.service";

@Module({
  imports: [AuthModule, IdempotencyModule],
  controllers: [VouchersPosController],
  providers: [
    VouchersPosService,
    VoucherLookupLimiter,
    {
      provide: DeviceRepository,
      useFactory: (lookupPool: Pool, domainPool: Pool): DeviceRepository => new DeviceRepository(lookupPool, domainPool),
      inject: [AUTH_LOOKUP_POOL, PG_POOL],
    },
    PosDeviceAuthGuard,
    {
      // The live cashier claim of the TLV (RT-451), reused: a live admission of
      // this device and store, plus the live eligibility rules.
      provide: TRACKED_LINE_CASHIER_VERIFIER,
      useFactory: (pool: Pool, lookupPool: Pool): TrackedLineCashierVerifier =>
        new PgTrackedLineCashierVerifier(pool, new CashierEligibilityRepository(lookupPool)),
      inject: [PG_POOL, AUTH_LOOKUP_POOL],
    },
    ValidateVoucherAuthGuard,
    RedeemVoucherAuthGuard,
  ],
})
export class VouchersPosModule {}
