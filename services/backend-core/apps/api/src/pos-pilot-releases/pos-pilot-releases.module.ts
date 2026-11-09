/**
 * PosPilotReleasesModule: RT-1292 (`pos-pilot-releases.openapi.yaml`).
 *
 * Two controllers, two principals:
 *
 *   PilotReleasesController   (SessionOnlyAdminGuard → TenantContextGuard → RolesGuard)
 *     └─ PilotReleaseService  allowlist + current pilot release, presign, audit
 *   PilotTenantsController    (SessionOnlyAdminGuard → PlatformAdminGuard)
 *     └─ PilotTenantsService  the pilot allowlist, audited change
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
 * resolver answers `available:false` (fail closed), never an error.
 */
import { Logger, Module } from "@nestjs/common";

import { PlatformAdminGuard } from "../audit/platform-admin.guard";
import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { resolvePilotReleaseConfig } from "./pilot-release.config";
import { bindPilotReleasePresigner } from "./pilot-release.binding";
import { PILOT_RELEASE_CONFIG, PILOT_RELEASE_PRESIGNER } from "./pilot-release.presigner";
import { PilotReleaseService } from "./pilot-release.service";
import { PilotReleasesController } from "./pilot-releases.controller";
import { PilotTenantsController } from "./pilot-tenants.controller";
import { PilotTenantsService } from "./pilot-tenants.service";

/** Bind the S3 presigner from the environment, or null (the lane stays off); only closed reasons are logged. */
function bindFromEnvironment(env: NodeJS.ProcessEnv) {
  return bindPilotReleasePresigner(env, (message) => new Logger("PosPilotReleasesModule").warn(message));
}

/** Wires the pilot release resolver and the pilot allowlist routes; see the module comment above. */
@Module({
  imports: [AuthModule, ContextModule],
  controllers: [PilotReleasesController, PilotTenantsController],
  providers: [
    { provide: PILOT_RELEASE_CONFIG, useFactory: () => resolvePilotReleaseConfig(process.env) },
    // RT-1297: null (the lane stays inert, `available:false`) unless the pilot S3 key is complete.
    { provide: PILOT_RELEASE_PRESIGNER, useFactory: () => bindFromEnvironment(process.env) },
    PlatformAdminGuard,
    PilotReleaseService,
    PilotTenantsService,
  ],
})
export class PosPilotReleasesModule {}
