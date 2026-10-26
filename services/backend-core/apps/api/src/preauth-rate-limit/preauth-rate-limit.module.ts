/**
 * PreAuthRateLimitModule — RT-630.
 *
 * Provides the boot-time pre-auth config and the report-only reporter that
 * the global FailClosedAuthGuard calls after a 401. The reporter uses the one
 * shared Redis-backed `RateLimiter` exported by AuthModule. With the default
 * mode `off` it never touches Redis.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { PREAUTH_RATE_LIMIT_CONFIG, readPreAuthRateLimitConfig } from "./preauth-rate-limit.config";
import { PreAuthRateLimitReporter } from "./preauth-rate-limit.reporter";

@Module({
  imports: [AuthModule],
  providers: [
    { provide: PREAUTH_RATE_LIMIT_CONFIG, useFactory: () => readPreAuthRateLimitConfig() },
    PreAuthRateLimitReporter,
  ],
  exports: [PreAuthRateLimitReporter],
})
export class PreAuthRateLimitModule {}
