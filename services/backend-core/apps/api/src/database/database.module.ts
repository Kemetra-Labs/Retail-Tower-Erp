/**
 * The database pools as shared infrastructure (RT-1456 A-10). `PG_POOL` (the tenant-scoped domain
 * pool) and `AUTH_LOOKUP_POOL` (the BYPASSRLS pre-tenant lookup pool) used to be provided by
 * `AuthModule`, which made every module look auth-dependent. Token values and the factories are
 * unchanged, so `overrideProvider(PG_POOL)` keeps working; the role/grant boot checks stay with
 * auth (`DatabasePoolBoundaryVerifier`).
 */
import { Global, Module } from "@nestjs/common";

import { AUTH_LOOKUP_POOL, DatabasePoolLifecycle, PG_POOL, authLookupPoolFactory, domainPoolFactory } from "./database-pools";

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: domainPoolFactory,
    },
    {
      provide: AUTH_LOOKUP_POOL,
      useFactory: authLookupPoolFactory,
      inject: [PG_POOL],
    },
    DatabasePoolLifecycle,
  ],
  exports: [PG_POOL, AUTH_LOOKUP_POOL],
})
export class DatabaseModule {}
