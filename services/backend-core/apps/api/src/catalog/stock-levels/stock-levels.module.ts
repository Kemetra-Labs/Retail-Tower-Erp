/**
 * StockLevelsModule — RT-1066: the console read and writes of a product's
 * low-stock thresholds (`catalog/stock-levels.yaml`), over
 * `product_stock_levels` (0078).
 *
 * Imports:
 *   - `AuthModule`    — `PG_POOL` + the session/token repositories the
 *                       session-only `SessionOnlyAdminGuard` uses.
 *   - `ContextModule` — `TenantContextGuard` (publishes `request.context`) and
 *                       `MembershipRepository` (the caller's role → store scope).
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../../auth/auth.module";
import { ContextModule } from "../../context/context.module";
import { StockLevelsController } from "./stock-levels.controller";
import { StockLevelsService } from "./stock-levels.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [StockLevelsController],
  providers: [StockLevelsService],
})
export class StockLevelsModule {}
