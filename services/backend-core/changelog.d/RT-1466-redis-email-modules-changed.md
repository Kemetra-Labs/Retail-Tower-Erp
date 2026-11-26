### Changed
- RT-1466 (audit A-10 remainder): `REDIS_CLIENT` is now provided by a global `RedisModule`
  (`apps/api/src/redis/`, with `redisClientFactory` and `AlwaysAllowRedis`) and `EMAIL_JOB_ENQUEUER`
  by a global `EmailModule` (`apps/api/src/email/`, with the enqueuer seam, `EmailQueueProducer`,
  `emailJobEnqueuerFactory` and `EMAIL_QUEUE_NAME`), instead of `AuthModule`. Token values and the
  factories are moved verbatim (including the `AuthModule:` prefix of the "REDIS_URL is required in
  production" message), so `overrideProvider(...)` keeps working. `auth.module.ts` no longer provides
  or exports a Redis, email-queue or pool token; `RateLimiter` stays wired and exported by `AuthModule`.
  No route, contract, table or wire change.
