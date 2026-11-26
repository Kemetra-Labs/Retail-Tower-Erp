/**
 * The public surface of `redis` (RT-1466, RT-1453 convention): the client token, the module and
 * the no-Redis stub. Other api modules import only this file.
 */
export { AlwaysAllowRedis, REDIS_CLIENT, redisClientFactory } from "./redis-client";
export { RedisModule } from "./redis.module";
