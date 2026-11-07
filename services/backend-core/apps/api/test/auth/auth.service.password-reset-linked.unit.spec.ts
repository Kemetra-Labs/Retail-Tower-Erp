/**
 * auth.service.password-reset-linked.unit.spec.ts — RT-1262 (auth review F-001).
 *
 * A user with an ACTIVE external identity link signs in with the provider's
 * password only (RT-937 D-A); the local hash is never read for them. Until the
 * provider-backed recovery of RT-937 item 3 exists, the legacy local reset must
 * not act on such a user:
 *
 *   - request: no token is issued and no email is sent (the route still answers
 *     202, decided by the controller, so nothing reveals the link);
 *   - confirm: the token is consumed, then refused with the same generic 400 as
 *     an invalid token. No hash is written, no session is revoked, and no address
 *     is returned (so the controller clears no sign-in lockout);
 *   - a user with no active link resets exactly as before.
 *
 * Docker-free: hand-written fakes, no DB, no network.
 */
import { BadRequestException } from "@nestjs/common";
import { AuthService, AUTH_TOKEN_SCOPES } from "../../src/auth/auth.service";
import type { SessionRepository } from "../../src/auth/session.repository";
import type { AuthTokenRepository } from "../../src/auth/auth-token.repository";
import type { EmailJobEnqueuer } from "../../src/auth/email-job.enqueuer";
import type { ExternalCredentialPort } from "../../src/auth/external-credential.port";
import type { OperatorTokenVerifier } from "../../src/auth/operator-token-verifier";

let selectRows: unknown[] = [];
let updateReturningRows: unknown[] = [];
/** Every `.update()` the service starts (password hash write, session revocation). */
const updateCalls = jest.fn();

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => {
    const chain = {
      select: () => chain,
      from: () => chain,
      update: (...args: unknown[]) => {
        updateCalls(...args);
        return chain;
      },
      set: () => chain,
      where: () => ({
        limit: () => Promise.resolve(selectRows),
        returning: () => Promise.resolve(updateReturningRows),
        then: (resolve: (v: unknown) => void) => resolve({ rowCount: 1 }),
      }),
    };
    return chain;
  }),
}));

jest.mock("@data-pulse-2/auth", () => ({
  verifyPassword: jest.fn(),
  hashPassword: jest.fn(),
  needsRehash: jest.fn(() => false),
  generateRawToken: jest.fn(),
  hashToken: jest.fn(),
}));

import { generateRawToken, hashPassword } from "@data-pulse-2/auth";

const mockHashPassword = hashPassword as jest.MockedFunction<typeof hashPassword>;
const mockGenerateRawToken = generateRawToken as jest.MockedFunction<typeof generateRawToken>;

const USER_ID = "0193a000-0000-7000-8000-000000000001";
const TOKEN_ID = "0193a000-0000-7000-8000-000000000003";
const EMAIL = "manager@tower.com";
const SUBJECT = "U2externalSubject";
const NEW_PASSWORD = "New-Password-12";

function resetTokenRow() {
  return {
    id: TOKEN_ID,
    tokenHash: Buffer.from("fakehash"),
    tenantId: null,
    userId: USER_ID,
    deviceId: null,
    storeId: null,
    scope: AUTH_TOKEN_SCOPES.passwordReset,
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    revokedAt: null,
  };
}

function build(linkSubject: string | null) {
  const authTokens = {
    issue: jest.fn().mockResolvedValue(resetTokenRow()),
    consumeActiveByRawToken: jest.fn().mockResolvedValue(resetTokenRow()),
  };
  const emailJobs = {
    enqueuePasswordReset: jest.fn().mockResolvedValue(undefined),
    enqueueEmailVerification: jest.fn().mockResolvedValue(undefined),
    enqueueInvitation: jest.fn().mockResolvedValue(undefined),
  };
  const activeLinkSubject = jest.fn().mockResolvedValue(linkSubject);
  const endSupportSessions = jest.fn().mockResolvedValue(undefined);
  const service = new AuthService(
    {} as never,
    {} as unknown as SessionRepository,
    authTokens as unknown as AuthTokenRepository,
    emailJobs as unknown as EmailJobEnqueuer,
    {
      endSupportSessions,
      externalCredentials: {
        port: {} as ExternalCredentialPort,
        verifier: { verify: jest.fn() } as OperatorTokenVerifier,
        activeLinkSubject,
      },
    },
  );
  return { service, authTokens, emailJobs, activeLinkSubject, endSupportSessions };
}

beforeEach(() => {
  jest.clearAllMocks();
  selectRows = [{ id: USER_ID, email: EMAIL, passwordHash: null, deletedAt: null }];
  updateReturningRows = [{ email: EMAIL }];
  mockGenerateRawToken.mockReturnValue("reset-raw-token");
  mockHashPassword.mockResolvedValue("$argon2id$v=19$newhash");
});

describe("AuthService.requestPasswordReset — external identity link (RT-1262)", () => {
  it("issues no token and sends no email for a user with an active link", async () => {
    const { service, authTokens, emailJobs, activeLinkSubject } = build(SUBJECT);

    await expect(service.requestPasswordReset({ email: EMAIL })).resolves.toBeUndefined();

    expect(activeLinkSubject).toHaveBeenCalledWith(USER_ID);
    expect(mockGenerateRawToken).not.toHaveBeenCalled();
    expect(authTokens.issue).not.toHaveBeenCalled();
    expect(emailJobs.enqueuePasswordReset).not.toHaveBeenCalled();
  });

  it("still issues a token and sends the email for a user with no active link", async () => {
    const { service, authTokens, emailJobs } = build(null);

    await service.requestPasswordReset({ email: EMAIL });

    expect(authTokens.issue).toHaveBeenCalledTimes(1);
    expect(emailJobs.enqueuePasswordReset).toHaveBeenCalledWith(
      expect.objectContaining({ email: EMAIL, rawToken: "reset-raw-token", userId: USER_ID }),
    );
  });
});

describe("AuthService.confirmPasswordReset — external identity link (RT-1262)", () => {
  it("consumes the token, then refuses with the generic invalid-token 400 for a user with an active link", async () => {
    const { service, authTokens, activeLinkSubject } = build(SUBJECT);

    const error = await service
      .confirmPasswordReset({ rawToken: "valid-token", newPassword: NEW_PASSWORD })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe("Invalid or expired token");
    expect(authTokens.consumeActiveByRawToken).toHaveBeenCalledWith(
      "valid-token",
      AUTH_TOKEN_SCOPES.passwordReset,
    );
    expect(activeLinkSubject).toHaveBeenCalledWith(USER_ID);
  });

  it("writes no password hash, revokes no session and ends no support session for a linked user", async () => {
    const { service, endSupportSessions } = build(SUBJECT);

    await service
      .confirmPasswordReset({ rawToken: "valid-token", newPassword: NEW_PASSWORD })
      .catch(() => undefined);

    expect(mockHashPassword).not.toHaveBeenCalled();
    expect(updateCalls).not.toHaveBeenCalled();
    expect(endSupportSessions).not.toHaveBeenCalled();
  });

  it("resets exactly as before for a user with no active link", async () => {
    const { service, endSupportSessions } = build(null);

    await expect(
      service.confirmPasswordReset({ rawToken: "valid-token", newPassword: NEW_PASSWORD }),
    ).resolves.toBe(EMAIL);

    expect(mockHashPassword).toHaveBeenCalledWith(NEW_PASSWORD);
    // One update for the password hash, one for revoking the sessions.
    expect(updateCalls).toHaveBeenCalledTimes(2);
    expect(endSupportSessions).toHaveBeenCalledWith({ userId: USER_ID }, null);
  });
});
