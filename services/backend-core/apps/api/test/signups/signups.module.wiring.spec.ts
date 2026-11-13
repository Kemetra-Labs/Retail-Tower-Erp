/**
 * signups.module.wiring.spec.ts — RT-1350 slice 3.
 *
 * `SignupsService` is built by a `useFactory`, so a token the factory forgets to pass
 * compiles and boots but arrives `undefined` or a no-op (the #611 trap in the NestJS
 * notes: hand-built services hide wiring gaps). This spec compiles the real module graph
 * (no database, no network) and asserts every dependency is the real one: the SQL
 * repository, the shared limiter, the email and audit enqueuers, the provider port, the
 * AuthService session starter, the identity-link reader, and the fail-closed human-proof
 * adapter when nothing is configured.
 */
import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { Pool } from "pg";

import { AUDIT_JOB_ENQUEUER } from "../../src/audit/audit-job.enqueuer";
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL, REDIS_CLIENT } from "../../src/auth/auth.module";
import { AuthService } from "../../src/auth/auth.service";
import { EMAIL_JOB_ENQUEUER } from "../../src/auth/email-job.enqueuer";
import { EXTERNAL_CREDENTIAL_PORT } from "../../src/auth/external-credential.port";
import { RateLimiter, type RedisLike } from "../../src/auth/rate-limit";
import { HUMAN_PROOF_VERIFIER } from "../../src/signups/human-proof.port";
import { OwnTokenSignupLinkProvider } from "../../src/signups/own-token-signup-link.provider";
import { SIGNUP_LINK_PROVIDER } from "../../src/signups/signup-link.port";
import { SignupsController } from "../../src/signups/signups.controller";
import { SignupsModule } from "../../src/signups/signups.module";
import { SignupsRepository } from "../../src/signups/signups.repository";
import { SignupsService, type SignupsServiceDeps } from "../../src/signups/signups.service";
import { UnconfiguredHumanProofVerifier } from "../../src/signups/turnstile.verifier";

class AlwaysAllowRedis implements RedisLike {
  async incrWindow(): Promise<{ count: number; ttlMs: number }> {
    return { count: 1, ttlMs: -1 };
  }
  async pttl(): Promise<number> {
    return -1;
  }
  async decr(): Promise<number> {
    return 0;
  }
  async del(): Promise<number> {
    return 0;
  }
}

describe("SignupsService is wired from the real module graph (RT-1350 slice 3)", () => {
  it("injects the repository, limiter, enqueuers, provider port, session starter, link reader and a fail-closed verifier", async () => {
    const emailJobs = { enqueueSignupLink: jest.fn(), enqueueInvitation: jest.fn(), enqueuePasswordReset: jest.fn(), enqueueEmailVerification: jest.fn() };
    const audit = { enqueue: jest.fn() };
    const pool = { query: jest.fn(), end: jest.fn() } as unknown as Pool;

    const moduleRef = await Test.createTestingModule({ imports: [AuthModule, SignupsModule] })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .overrideProvider(AUTH_LOOKUP_POOL)
      .useValue(pool)
      .overrideProvider(REDIS_CLIENT)
      .useValue(new AlwaysAllowRedis())
      .overrideProvider(EMAIL_JOB_ENQUEUER)
      .useValue(emailJobs)
      .overrideProvider(AUDIT_JOB_ENQUEUER)
      .useValue(audit)
      .compile();

    const service = moduleRef.get(SignupsService);
    const deps = (service as unknown as { deps: SignupsServiceDeps }).deps;

    expect(deps.pool).toBe(pool);
    expect(deps.store).toBeInstanceOf(SignupsRepository);
    expect(deps.limiter).toBe(moduleRef.get(RateLimiter, { strict: false }));
    expect(deps.links).toBeInstanceOf(OwnTokenSignupLinkProvider);
    expect(moduleRef.get(SIGNUP_LINK_PROVIDER)).toBe(deps.links);
    // The adapter delivers through the injected email enqueuer.
    await deps.links.prepare({ email: "a@b.test", locale: null }).deliver();
    expect(emailJobs.enqueueSignupLink).toHaveBeenCalledTimes(1);
    expect(deps.audit).toBe(audit);
    expect(deps.external).toBe(moduleRef.get(EXTERNAL_CREDENTIAL_PORT, { strict: false }));
    expect(deps.external?.identity.providerKey).toBe("descope");
    expect(deps.sessions).toBe(moduleRef.get(AuthService));
    expect(typeof deps.linkState).toBe("function");
    expect(deps.limiterTimeoutMs).toBeGreaterThan(0);
    // Nothing configured: the public signup stays closed (503), never open without a human check.
    expect(deps.humanProof).toBeInstanceOf(UnconfiguredHumanProofVerifier);
    expect(moduleRef.get(HUMAN_PROOF_VERIFIER)).toBe(deps.humanProof);

    expect(moduleRef.get(SignupsController)).toBeInstanceOf(SignupsController);
    await moduleRef.close();
  });
});
