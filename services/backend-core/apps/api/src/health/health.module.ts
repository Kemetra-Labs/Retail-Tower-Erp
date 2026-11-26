/**
 * HealthModule — liveness and readiness for deployment checks (RT-144).
 * Imports DatabaseModule (PG_POOL, AUTH_LOOKUP_POOL) and RedisModule (REDIS_CLIENT), the shared
 * infrastructure (RT-1456, RT-1466), so the checks probe the same clients that serve traffic. It has
 * no auth dependency: the routes are marked `@Public()`.
 */
import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database";
import { RedisModule } from "../redis";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
