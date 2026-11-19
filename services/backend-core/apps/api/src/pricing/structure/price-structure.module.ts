/**
 * PriceStructureModule — RT-1484 (RT-282 PR-09a): the runtime of `pricing/price-structure.yaml`
 * (Price Books, Zones and Zone-membership reads). See `price-structure.controller.ts`.
 *
 * Imports:
 *   - `AuthModule`        — `PG_POOL` and the human `SessionOnlyAdminGuard`.
 *   - `ContextModule`     — `TenantContextGuard` and the `MembershipRepository` the store scope uses.
 *   - `IdempotencyModule` — the interceptor `@Idempotent("required")` engages on every write.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../../auth/auth.module";
import { ContextModule } from "../../context/context.module";
import { IdempotencyModule } from "../../idempotency/idempotency.module";
import { PriceStructureController } from "./price-structure.controller";
import { PriceStructureService } from "./price-structure.service";

@Module({
  imports: [AuthModule, ContextModule, IdempotencyModule],
  controllers: [PriceStructureController],
  providers: [PriceStructureService],
})
export class PriceStructureModule {}
