/**
 * The public surface of `database` (RT-1456 A-10, RT-1453 convention): the pool tokens and the
 * module. Other api modules import only this file; the factories stay internal.
 */
export { AUTH_LOOKUP_POOL, PG_POOL } from "./database-pools";
export { DatabaseModule } from "./database.module";
