/**
 * PriceInquiryModule — RT-1484 (RT-282 PR-08b): the runtime of `pricing/price-inquiry.yaml`
 * (price, timeline and "why this price"). See `price-inquiry.controller.ts`.
 *
 * Imports:
 *   - `AuthModule`    — `PG_POOL` and the human `SessionOnlyAdminGuard`.
 *   - `ContextModule` — `TenantContextGuard` and the `MembershipRepository` the store scope uses.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../../auth/auth.module";
import { ContextModule } from "../../context/context.module";
import { PriceInquiryController } from "./price-inquiry.controller";
import { PriceInquiryService } from "./price-inquiry.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [PriceInquiryController],
  providers: [PriceInquiryService],
})
export class PriceInquiryModule {}
