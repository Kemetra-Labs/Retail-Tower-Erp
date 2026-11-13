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
    {
      provide: SignupsService,
      useFactory: (
        pool: Pool,
        lookupPool: Pool,
        store: SignupsStore,
        humanProof: HumanProofVerifier,
        limiter: RateLimiter,
        emailJobs: EmailJobEnqueuer,
        audit: AuditJobEnqueuer,
        external: ExternalCredentialPort,
        auth: AuthService,
      ): SignupsService =>
        new SignupsService({
          pool,
          store,
          humanProof,
          limiter,
          emailJobs,
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
        EMAIL_JOB_ENQUEUER,
        AUDIT_JOB_ENQUEUER,
        EXTERNAL_CREDENTIAL_PORT,
        AuthService,
      ],
    },
  ],
})
export class SignupsModule {}
