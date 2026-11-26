/**
 * HealthModule — liveness and readiness for deployment checks (RT-144).
 * Imports AuthModule (which brings the global DatabaseModule: PG_POOL, AUTH_LOOKUP_POOL) and
 * RedisModule (REDIS_CLIENT, RT-1466), so the checks probe the same clients that serve traffic.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { RedisModule } from "../redis";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
