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
 * (`pilot-release.config.ts`). The presigner is `null` until the S3 adapter
 * slice binds one: with `null` the resolver answers `available:false`
 * (fail closed), never an error.
 */
import { Module } from "@nestjs/common";

import { PlatformAdminGuard } from "../audit/platform-admin.guard";
import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { resolvePilotReleaseConfig } from "./pilot-release.config";
import { PILOT_RELEASE_CONFIG, PILOT_RELEASE_PRESIGNER } from "./pilot-release.presigner";
import { PilotReleaseService } from "./pilot-release.service";
import { PilotReleasesController } from "./pilot-releases.controller";
import { PilotTenantsController } from "./pilot-tenants.controller";
import { PilotTenantsService } from "./pilot-tenants.service";

/** Wires the pilot release resolver and the pilot allowlist routes; see the module comment above. */
@Module({
  imports: [AuthModule, ContextModule],
  controllers: [PilotReleasesController, PilotTenantsController],
  providers: [
    { provide: PILOT_RELEASE_CONFIG, useFactory: () => resolvePilotReleaseConfig(process.env) },
    // The S3 presigner is a later, separately gated slice: until it is bound the lane is inert.
    { provide: PILOT_RELEASE_PRESIGNER, useValue: null },
    PlatformAdminGuard,
    PilotReleaseService,
    PilotTenantsService,
  ],
})
export class PosPilotReleasesModule {}
