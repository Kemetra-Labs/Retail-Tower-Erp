/**
 * PosPilotReleasesModule: RT-1292 (`pos-pilot-releases.openapi.yaml`), RT-1297
 * (S3 presigner) and RT-1298 (registry writes).
 *
 * Controllers and principals:
 *
 *   PilotReleasesController          (SessionOnlyAdminGuard → TenantContextGuard → RolesGuard)
 *     └─ PilotReleaseService         allowlist + current pilot release, presign, audit
 *   PilotTenantsController           (SessionOnlyAdminGuard → PlatformAdminGuard)
 *     └─ PilotTenantsService         the pilot allowlist, audited change
 *   PilotReleaseWritesController     (@Public + PromotionWriterGuard: the workflow's GitHub OIDC token)
 *     └─ PilotReleaseRegistryService register, withdraw
 *   PilotReleaseActivationController (SessionOnlyAdminGuard → PlatformAdminGuard)
 *     └─ PilotReleaseRegistryService activate
 *
 * Imports `AuthModule` (`PG_POOL` and the session guards) and `ContextModule`
 * (`TenantContextGuard`, `MembershipRepository`, `PlatformAdminGuard`'s
 * `isPlatformAdmin` read). No `AuditModule`: each service writes its own audit
 * row in its transaction.
 *
 * Configuration is resolved once, at boot, from the environment
 * (`pilot-release.config.ts`). The S3 presigner (RT-1297) is bound from the
 * explicit `POS_PILOT_RELEASE_S3_*` key (`pilot-release.s3-settings.ts`); it is
 * `null` unless the region and both key halves are valid, and with `null` the
 * resolver answers `available:false` (fail closed), never an error. The
 * promotion verifier (RT-1298) is bound from the `POS_PILOT_PROMOTION_OIDC_*`
 * pins (`promotion-oidc.config.ts`); it is `null` unless all five are valid, and
 * with `null` every registry write from the workflow is 401.
 */
import { Logger, Module } from "@nestjs/common";

import { PlatformAdminGuard } from "../audit/platform-admin.guard";
import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { resolvePilotReleaseConfig } from "./pilot-release.config";
import { bindPilotReleasePresigner } from "./pilot-release.binding";
import { PILOT_RELEASE_CONFIG, PILOT_RELEASE_PRESIGNER } from "./pilot-release.presigner";
import { PilotReleaseActivationController } from "./pilot-release-activation.controller";
import { PilotReleaseRegistryService } from "./pilot-release-registry.service";
import { PilotReleaseWritesController } from "./pilot-release-writes.controller";
import { PilotReleaseService } from "./pilot-release.service";
import { PilotReleasesController } from "./pilot-releases.controller";
import { PilotTenantsController } from "./pilot-tenants.controller";
import { PilotTenantsService } from "./pilot-tenants.service";
import { bindPromotionVerifier } from "./promotion-oidc.binding";
import { PROMOTION_OIDC_VERIFIER } from "./promotion-oidc.verifier";
import { PromotionWriterGuard } from "./promotion-writer.guard";

/** Warn through the Nest logger; the binders pass closed reasons only, never a value. */
function warn(message: string): void {
  new Logger("PosPilotReleasesModule").warn(message);
}

/** Wires the pilot release resolver, the allowlist and the registry writes; see the module comment above. */
@Module({
  imports: [AuthModule, ContextModule],
  controllers: [
    PilotReleasesController,
    PilotTenantsController,
    PilotReleaseWritesController,
    PilotReleaseActivationController,
  ],
  providers: [
    { provide: PILOT_RELEASE_CONFIG, useFactory: () => resolvePilotReleaseConfig(process.env) },
    // RT-1297: null (the lane stays inert, `available:false`) unless the pilot S3 key is complete.
    { provide: PILOT_RELEASE_PRESIGNER, useFactory: () => bindPilotReleasePresigner(process.env, warn) },
    // RT-1298: null (every workflow write is 401) unless all five promotion pins are valid.
    { provide: PROMOTION_OIDC_VERIFIER, useFactory: () => bindPromotionVerifier(process.env, warn) },
    PlatformAdminGuard,
    PromotionWriterGuard,
    PilotReleaseService,
    PilotTenantsService,
    PilotReleaseRegistryService,
  ],
})
export class PosPilotReleasesModule {}
