import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { RolesGuard } from "../auth/roles.guard";
import { MembershipsController } from "./memberships.controller";
import { MembershipsRepository } from "./memberships.repository";
import { MembershipsService } from "./memberships.service";
import { InvitationAcceptController } from "./invitation-accept.controller";
import { InvitationsController } from "./invitations.controller";
import { InvitationsRepository } from "./invitations.repository";
import { InvitationsService } from "./invitations.service";
import { IdempotencyModule } from "../idempotency/idempotency.module";
import { operatorTokenVerifierFactory } from "../auth/identity-provider.factory";
import { OPERATOR_TOKEN_VERIFIER } from "../auth/operator-token-verifier";

@Module({
  imports: [AuthModule, ContextModule, IdempotencyModule],
  controllers: [MembershipsController, InvitationsController, InvitationAcceptController],
  providers: [
    // RT-937: verifies the identity provider's session token during a NEW invitee's
    // provisioning (the configured provider's verifier; EXTERNAL_CREDENTIAL_PORT and
    // AuthService come from AuthModule).
    { provide: OPERATOR_TOKEN_VERIFIER, useFactory: operatorTokenVerifierFactory },
    MembershipsRepository,
    MembershipsService,
    InvitationsRepository,
    InvitationsService,
    RolesGuard,
  ],
})
export class MembershipsModule {}
