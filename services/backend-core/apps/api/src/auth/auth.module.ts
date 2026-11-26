/**
 * AuthModule — slice 3c.
 *
 * Wires AuthController and its dependency graph:
 *
 *   AuthController
 *     ├─ AuthService
 *     │    ├─ Pool          (PG_POOL token)
 *     │    ├─ SessionRepository
 *     │    ├─ AuthTokenRepository
 *     │    └─ EmailJobEnqueuer (NoOpEmailJobEnqueuer until T112/T113)
 *     ├─ AuthGuard
 *     │    ├─ SessionRepository
 *     │    └─ AuthTokenRepository
 *     └─ RateLimiter
 *          └─ RedisLike      (REDIS_CLIENT, from RedisModule)
 *
 * Shared infrastructure is imported, not provided here (RT-1456, RT-1466 audit A-10):
 *
 *   - PG_POOL / AUTH_LOOKUP_POOL — `DatabaseModule` (`../database`).
 *   - REDIS_CLIENT — `RedisModule` (`../redis`): real ioredis when `REDIS_URL`
 *     is set, the loud `AlwaysAllowRedis` stub otherwise.
 *   - EMAIL_JOB_ENQUEUER — `EmailModule` (`../email`): the BullMQ-backed
 *     `EmailQueueProducer` when `REDIS_URL` is set, a throw in production
 *     without it, `NoOpEmailJobEnqueuer` in dev / test.
 *
 * All three are global modules, so modules that used to receive these tokens
 * through AuthModule's exports still resolve them. Tests substitute fakes via
 * `Test.createTestingModule(...).overrideProvider(...)`; the token values are unchanged.
 */
import { Module } from "@nestjs/common";
import { Pool } from "pg";

import { DatabasePoolBoundaryVerifier } from "./database-pools";
import { AUTH_LOOKUP_POOL, DatabaseModule, PG_POOL } from "../database";

import { outboxOrLegacyAuditJobEnqueuerFactory } from "../audit/audit-enqueuer.module";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../audit/audit-job.enqueuer";

import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { DashboardAuthGuard } from "./dashboard-auth.guard";
import { PosOperatorAuthGuard } from "./pos-operator-auth.guard";
import {
  externalCredentialFactory,
  identityProviderFactory,
  operatorTokenVerifierFactory,
} from "./identity-provider.factory";
import { EXTERNAL_CREDENTIAL_PORT, type ExternalCredentialPort } from "./external-credential.port";
import { activeLinkSubjectForProvider, findLiveUserByActiveLink } from "./identity-link-lookup";
import {
  OPERATOR_CONTEXT_RESOLVER,
  PgOperatorContextResolver,
} from "./operator-context-resolver";
import { DeviceRepository } from "../pos-operators/device.repository";
import { AuthService } from "./auth.service";
import { AuthTokenRepository } from "./auth-token.repository";
import { EMAIL_JOB_ENQUEUER, EmailModule, type EmailJobEnqueuer } from "../email";
import { REDIS_CLIENT, RedisModule } from "../redis";
import { RateLimiter, type RedisLike } from "../common/rate-limit/rate-limit";
import { SessionRepository } from "./session.repository";
import { signInMembershipsReader } from "./signin-memberships";
import { endSupportSessions } from "../platform-support-sessions/support-session.lifecycle";

@Module({
  // PG_POOL and AUTH_LOOKUP_POOL come from DatabaseModule, REDIS_CLIENT from RedisModule and
  // EMAIL_JOB_ENQUEUER from EmailModule; all three are global infrastructure (RT-1456, RT-1466).
  imports: [DatabaseModule, RedisModule, EmailModule],
  controllers: [AuthController],
  providers: [
    // RT-124: auth audits (sign-in ok/failed, …) take the same outbox-aware
    // path as the request graph, instead of always going straight to BullMQ.
    // PG_POOL comes from the global DatabaseModule (RT-1456 A-10).
    {
      provide: AUDIT_JOB_ENQUEUER,
      useFactory: (pool: Pool | null): AuditJobEnqueuer =>
        outboxOrLegacyAuditJobEnqueuerFactory(pool),
      inject: [PG_POOL],
    },
    {
      provide: SessionRepository,
      useFactory: (pool: Pool): SessionRepository => new SessionRepository(pool),
      inject: [AUTH_LOOKUP_POOL],
    },
    {
      provide: AuthTokenRepository,
      useFactory: (pool: Pool): AuthTokenRepository =>
        new AuthTokenRepository(pool),
      inject: [AUTH_LOOKUP_POOL],
    },
    {
      provide: RateLimiter,
      useFactory: (redis: RedisLike): RateLimiter => new RateLimiter(redis),
      inject: [REDIS_CLIENT],
    },
    AuthGuard,
    DashboardAuthGuard,
    // RT-137: PosOperatorAuthGuard re-verifies device / membership / role /
    // store access live on every request (the same reverifier SalesModule
    // registers for PosOperatorEnvelopeSaleGuard). Exported
    // because Nest builds a @UseGuards guard in the controller's own module,
    // which must therefore see this token; a module's local binding (Sales)
    // still takes precedence there.
    {
      provide: OPERATOR_CONTEXT_RESOLVER,
      useFactory: (pool: Pool, lookupPool: Pool): PgOperatorContextResolver =>
        new PgOperatorContextResolver(
          pool,
          identityProviderFactory(lookupPool),
          new DeviceRepository(lookupPool, pool),
          undefined,
          lookupPool,
        ),
      inject: [PG_POOL, AUTH_LOOKUP_POOL],
    },
    PosOperatorAuthGuard,
    // RT-937: password verify / replace and invited-user provisioning at the
    // configured identity provider. Exported so the invitation service shares it.
    {
      provide: EXTERNAL_CREDENTIAL_PORT,
      useFactory: externalCredentialFactory,
    },
    {
      provide: AuthService,
      useFactory: (
        pool: Pool,
        sessions: SessionRepository,
        authTokens: AuthTokenRepository,
        emailJobs: EmailJobEnqueuer,
        auditEnqueuer: AuditJobEnqueuer,
        domainPool: Pool,
        externalCredential: ExternalCredentialPort,
      ): AuthService =>
        new AuthService(pool, sessions, authTokens, emailJobs, {
          auditEnqueuer,
          // RT-937 (D-A): a user with an ACTIVE identity link signs in with the
          // provider's password. `pool` is the auth-lookup pool, the role the
          // link lookup is documented to use (identity-link-lookup.ts).
          externalCredentials: {
            port: externalCredential,
            verifier: operatorTokenVerifierFactory(),
            // Only a link to THIS provider counts: a pre-cutover link to another
            // provider leaves the user on native sign-in (review finding, RT-937).
            activeLinkSubject: (userId) =>
              activeLinkSubjectForProvider(pool, userId, externalCredential.identity.providerKey),
            // RT-1327: a recovery proof names its account only through an ACTIVE link
            // (ambiguous or soft-deleted resolves to nobody, so the confirm is refused).
            findUserByLinkSubject: (subject) =>
              findLiveUserByActiveLink(pool, { providerKey: externalCredential.identity.providerKey, subject }),
          },
          // RT-343: memberships are read on the domain pool, never the lookup pool.
          listMemberships: signInMembershipsReader(domainPool),
          // RT-414: support sessions live on the domain pool (0062).
          endSupportSessions: (owner, requestId) =>
            endSupportSessions(domainPool, owner, "signed_out", requestId),
        }),
      inject: [
        AUTH_LOOKUP_POOL,
        SessionRepository,
        AuthTokenRepository,
        EMAIL_JOB_ENQUEUER,
        AUDIT_JOB_ENQUEUER,
        PG_POOL,
        EXTERNAL_CREDENTIAL_PORT,
      ],
    },
    DatabasePoolBoundaryVerifier,
  ],
  exports: [
    AuthService,
    AuthGuard,
    DashboardAuthGuard,
    PosOperatorAuthGuard,
    OPERATOR_CONTEXT_RESOLVER,
    EXTERNAL_CREDENTIAL_PORT,
    SessionRepository,
    AuthTokenRepository,
    // RateLimiter is exported (ADR 0009) so downstream modules (SalesModule)
    // can wire PosWriteRateLimitGuard over the SAME single
    // Redis-backed limiter rather than re-provisioning a second client — keeps
    // the rate-limit policy in one place (rate-limit.ts).
    RateLimiter,
  ],
})
export class AuthModule {}
