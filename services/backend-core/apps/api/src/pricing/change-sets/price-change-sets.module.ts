/**
 * PriceChangeSetsModule — RT-1484 (RT-282 PR-09b): the authoring runtime of
 * `pricing/price-change-sets.yaml` (list, create, get, update, cancel; validate and preview,
 * PR-4b). See `price-change-sets.controller.ts`.
 *
 * Imports:
 *   - `AuthModule`        — `PG_POOL` and the human `SessionOnlyAdminGuard`.
 *   - `ContextModule`     — `TenantContextGuard`.
 *   - `IdempotencyModule` — the interceptor `@Idempotent("required")` engages on every write.
 *
 * `PRICING_AUTHORING_CONFIG` is read once from the process environment
 * (`PRICING_AUTHORING_TENANT_ALLOWLIST`, owner decision 1, RT-1484 comment 17829).
 */
import { Logger, Module } from "@nestjs/common";

import { AuthModule } from "../../auth/auth.module";
import { ContextModule } from "../../context/context.module";
import { IdempotencyModule } from "../../idempotency/idempotency.module";
import {
  PRICING_AUTHORING_CONFIG,
  resolvePricingAuthoringConfig,
  type PricingAuthoringConfig,
} from "./price-authoring.config";
import { PricingAuthoringGuard } from "./price-authoring.guard";
import { PriceChangeSetsController } from "./price-change-sets.controller";
import { PriceChangeSetsService } from "./price-change-sets.service";

function bindAuthoringConfig(): PricingAuthoringConfig {
  const config = resolvePricingAuthoringConfig(process.env);
  if (config.ignored.length > 0) {
    // Only the count: the entries themselves are not logged.
    new Logger("PriceChangeSetsModule").warn(
      `PRICING_AUTHORING_TENANT_ALLOWLIST: ${config.ignored.length} entry(ies) not a tenant UUID, ignored`,
    );
  }
  return config;
}

@Module({
  imports: [AuthModule, ContextModule, IdempotencyModule],
  controllers: [PriceChangeSetsController],
  providers: [
    PriceChangeSetsService,
    PricingAuthoringGuard,
    { provide: PRICING_AUTHORING_CONFIG, useFactory: bindAuthoringConfig },
  ],
})
export class PriceChangeSetsModule {}
