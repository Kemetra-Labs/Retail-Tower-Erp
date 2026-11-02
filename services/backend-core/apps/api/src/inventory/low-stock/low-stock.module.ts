/**
 * ConsoleLowStockModule — RT-1069: the console low-stock read
 * (`inventory/low-stock.yaml`, `consoleListLowStock`) over
 * `product_stock_levels` (0078) and the stock ledger.
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
import { ConsoleLowStockController } from "./low-stock.controller";
import { ConsoleLowStockService } from "./low-stock.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [ConsoleLowStockController],
  providers: [ConsoleLowStockService],
})
export class ConsoleLowStockModule {}
