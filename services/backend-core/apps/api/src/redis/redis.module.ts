/**
 * The shared Redis client as infrastructure (RT-1466, audit A-10), on the `DatabaseModule` pattern
 * (RT-1456). One client serves rate limiting (`RateLimiter`, still wired by `AuthModule`),
 * idempotency, health and store deletion. Global, so a module that used to receive `REDIS_CLIENT`
 * through `AuthModule`'s exports still resolves it; direct consumers also import it explicitly.
 */
import { Global, Module } from "@nestjs/common";

import { REDIS_CLIENT, redisClientFactory } from "./redis-client";

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: redisClientFactory,
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
