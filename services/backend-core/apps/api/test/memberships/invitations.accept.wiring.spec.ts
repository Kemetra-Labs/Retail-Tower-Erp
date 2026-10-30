/**
 * invitations.accept.wiring.spec.ts — RT-937 item 4.
 *
 * The three seams a NEW invitee's acceptance needs (provider credential port,
 * provider token verifier, session starter) are `@Optional()` on
 * `InvitationsService`, so that a token Nest cannot resolve does not crash boot.
 * The cost: a wiring mistake would silently turn every new-user accept into a 503
 * ("provisioning is not configured") and no unit test would notice. This spec
 * compiles the real module graph (no database, no network) and asserts all three
 * are actually injected, as the real classes.
 *
 * (The #611 trap from the NestJS notes: tests that construct a service by hand
 * hide wiring gaps. This one does not construct it by hand.)
 */
import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { Pool } from "pg";

import { AuthModule, PG_POOL, REDIS_CLIENT } from "../../src/auth/auth.module";
import { AuthService } from "../../src/auth/auth.service";
import { EMAIL_JOB_ENQUEUER } from "../../src/auth/email-job.enqueuer";
import {
  EXTERNAL_CREDENTIAL_PORT,
  type ExternalCredentialPort,
} from "../../src/auth/external-credential.port";
import { OPERATOR_TOKEN_VERIFIER } from "../../src/auth/operator-token-verifier";
import type { RedisLike } from "../../src/auth/rate-limit";
import { ContextModule } from "../../src/context/context.module";
import { InvitationAcceptController } from "../../src/memberships/invitation-accept.controller";
import { InvitationsService } from "../../src/memberships/invitations.service";
import { MembershipsModule } from "../../src/memberships/memberships.module";

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

const noopEnqueuer = {
  enqueueInvitation: jest.fn(),
  enqueuePasswordReset: jest.fn(),
  enqueueEmailVerification: jest.fn(),
};

type Seams = {
  external?: ExternalCredentialPort;
  tokenVerifier?: unknown;
  sessionStarter?: unknown;
};

describe("InvitationsService provisioning seams are wired (RT-937)", () => {
  it("injects the credential port, the token verifier and the AuthService session starter", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, ContextModule, MembershipsModule],
    })
      .overrideProvider(PG_POOL)
      .useValue({ query: jest.fn(), end: jest.fn() } as unknown as Pool)
      .overrideProvider(REDIS_CLIENT)
      .useValue(new AlwaysAllowRedis())
      .overrideProvider(EMAIL_JOB_ENQUEUER)
      .useValue(noopEnqueuer)
      .compile();

    const service = moduleRef.get(InvitationsService);
    const seams = service as unknown as Seams;

    expect(seams.external).toBeDefined();
    expect(seams.external).toBe(moduleRef.get(EXTERNAL_CREDENTIAL_PORT, { strict: false }));
    expect(seams.external?.identity.providerKey).toBe("descope");
    expect(seams.tokenVerifier).toBeDefined();
    expect(seams.tokenVerifier).toBe(moduleRef.get(OPERATOR_TOKEN_VERIFIER, { strict: false }));
    expect(seams.sessionStarter).toBe(moduleRef.get(AuthService));
    expect(typeof (seams.sessionStarter as AuthService).startSession).toBe("function");

    // The public route is mounted on the same service.
    expect(moduleRef.get(InvitationAcceptController)).toBeInstanceOf(InvitationAcceptController);

    await moduleRef.close();
  });
});
