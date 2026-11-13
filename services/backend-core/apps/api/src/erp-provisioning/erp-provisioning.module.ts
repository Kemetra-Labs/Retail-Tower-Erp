/**
 * ErpProvisioningModule — RT-1358: the provisioning feed (pull, step ack, one-time
 * credential issue, outcome) behind the provisioner bearer, and the platform
 * admin's provisioner credential routes. The unlock trigger lives in
 * `TenantAccessEntitlementModule` (it calls `provisioning-trigger.ts`).
 *
 * Imports `AuthModule` (`AuthTokenRepository`, `PG_POOL`, the session guard's
 * repositories) and `ContextModule` (`MembershipRepository`).
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { ProvisionerAuthGuard } from "./provisioner-auth.guard";
import { ProvisionerCredentialController } from "./provisioner-credential.controller";
import { ProvisionerCredentialService } from "./provisioner-credential.service";
import { ProvisioningFeedController } from "./provisioning-feed.controller";
import { ProvisioningFeedService } from "./provisioning-feed.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [ProvisioningFeedController, ProvisionerCredentialController],
  providers: [ProvisioningFeedService, ProvisionerCredentialService, ProvisionerAuthGuard],
})
export class ErpProvisioningModule {}
