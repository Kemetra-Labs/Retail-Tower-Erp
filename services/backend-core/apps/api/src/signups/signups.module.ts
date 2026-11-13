/**
 * SignupsModule — RT-1350 slice 3: customer self-signup (two public routes, fallback A).
 *
 * Wiring: the domain pool (`PG_POOL`) for every write, the AUTH LOOKUP pool only to read
 * the identity-link state (the domain role cannot), the shared Redis limiter, the email
 * and audit enqueuers, the identity provider port, and `AuthService.startSession` for the
 * native session. The human-proof verifier comes from the environment
 * (`humanProofVerifierFromEnv`): Turnstile when configured, otherwise the fail-closed
 * adapter, so the public signup stays closed until it is configured.
 */
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { OutboxAuditEnqueuerModule } from "../audit/outbox-audit-enqueuer.module";
import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "../audit/audit-job.enqueuer";
import { AuthModule, AUTH_LOOKUP_POOL, PG_POOL } from "../auth/auth.module";
import { AuthService } from "../auth/auth.service";
import { EMAIL_JOB_ENQUEUER, type EmailJobEnqueuer } from "../auth/email-job.enqueuer";
import { EXTERNAL_CREDENTIAL_PORT, type ExternalCredentialPort } from "../auth/external-credential.port";
import { readPublicAuthLimiterTimeoutMs } from "../auth/public-auth-limiter";
import { RateLimiter } from "../auth/rate-limit";
import { HUMAN_PROOF_VERIFIER, type HumanProofVerifier } from "./human-proof.port";
import { OwnTokenSignupLinkProvider } from "./own-token-signup-link.provider";
import { SIGNUP_LINK_PROVIDER, type SignupLinkProvider } from "./signup-link.port";
import { linkStateReader } from "./signup-link-state";
import { SignupsController } from "./signups.controller";
import { SignupsRepository } from "./signups.repository";
import { SignupsService } from "./signups.service";
import { SIGNUPS_STORE, type SignupsStore } from "./signups.store";
import { humanProofVerifierFromEnv } from "./turnstile.verifier";

@Module({
  imports: [AuthModule, OutboxAuditEnqueuerModule],
  controllers: [SignupsController],
  providers: [
    { provide: SIGNUPS_STORE, useClass: SignupsRepository },
    { provide: HUMAN_PROOF_VERIFIER, useFactory: (): HumanProofVerifier => humanProofVerifierFromEnv() },
    // Fallback A (RT-1350 c16859): Backend-Core's own opaque token, e-mailed by the worker.
    {
      provide: SIGNUP_LINK_PROVIDER,
      useFactory: (emailJobs: EmailJobEnqueuer): SignupLinkProvider => new OwnTokenSignupLinkProvider(emailJobs),
      inject: [EMAIL_JOB_ENQUEUER],
    },
    {
      provide: SignupsService,
      useFactory: (
        pool: Pool,
        lookupPool: Pool,
        store: SignupsStore,
        humanProof: HumanProofVerifier,
        limiter: RateLimiter,
        links: SignupLinkProvider,
        audit: AuditJobEnqueuer,
        external: ExternalCredentialPort,
        auth: AuthService,
      ): SignupsService =>
        new SignupsService({
          pool,
          store,
          humanProof,
          limiter,
          links,
          audit,
          external,
          sessions: auth,
          linkState: linkStateReader(lookupPool, external.identity.providerKey),
          limiterTimeoutMs: readPublicAuthLimiterTimeoutMs(),
        }),
      inject: [
        PG_POOL,
        AUTH_LOOKUP_POOL,
        SIGNUPS_STORE,
        HUMAN_PROOF_VERIFIER,
        RateLimiter,
        SIGNUP_LINK_PROVIDER,
        AUDIT_JOB_ENQUEUER,
        EXTERNAL_CREDENTIAL_PORT,
        AuthService,
      ],
    },
  ],
})
export class SignupsModule {}
