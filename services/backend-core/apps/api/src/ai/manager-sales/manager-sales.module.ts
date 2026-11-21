/**
 * ManagerSalesModule — RT-1539 (W8 P-06): the Manager Sales Ask/Explain route and the feature it
 * registers with the AI Gateway.
 *
 * The Gateway is `AiModule.withOverrides(...)`: the safe defaults (fail-closed budget, empty route
 * allowlist, disabled provider, kill switch OFF) stay, and only this feature's registration
 * (`AI_FEATURES`) and its evidence builder (`AI_EVIDENCE_BUILDER`, which reads the two console sales
 * services in process) are replaced.
 *
 * ENTITLEMENT (expected, not a defect): the production plan catalogue `core@1` grants no AI feature,
 * and a new catalogue version needs a migration, which RT-1539 does not add. So in production the
 * route answers `unavailable / not_entitled` for every caller (and `feature_disabled_system` while
 * `AI_GATEWAY_ENABLED` is unset) until a later, gated migration grants `ai.manager_sales.ask_explain`.
 *
 * Imports mirror `ConsoleSalesModule`: `AuthModule` (`PG_POOL`, the session guards' repositories),
 * `ContextModule` (`TenantContextGuard`, `MembershipRepository`) and `AuditModule` (the audit
 * enqueuer).
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { AuthModule } from "../../auth/auth.module";
import { ConsoleSalesModule } from "../../console-sales/console-sales.module";
import { ContextModule } from "../../context/context.module";
import { AiModule } from "../ai.module";
import { AI_EVIDENCE_BUILDER, AI_FEATURES } from "../ai.tokens";
import { ManagerSalesController } from "./manager-sales.controller";
import { ManagerSalesEvidenceBuilder } from "./msx.evidence";
import { managerSalesFeature } from "./msx.feature";
import { ManagerSalesScope, NoPlatformAdminGuard } from "./msx.scope";

@Module({
  imports: [
    AuthModule,
    AuditModule,
    ContextModule,
    AiModule.withOverrides({
      imports: [ConsoleSalesModule],
      providers: [
        { provide: AI_FEATURES, useValue: [managerSalesFeature] },
        { provide: AI_EVIDENCE_BUILDER, useClass: ManagerSalesEvidenceBuilder },
      ],
    }),
  ],
  controllers: [ManagerSalesController],
  providers: [ManagerSalesScope, NoPlatformAdminGuard],
})
export class ManagerSalesModule {}
