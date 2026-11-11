/**
 * auth.service.password-reset-provider.unit.spec.ts — RT-1327 (RT-937 item 3).
 *
 * Provider-backed password recovery for a user with an ACTIVE external identity
 * link. The provider (Descope) owns the credential and the one-time recovery
 * proof; Backend-Core verifies the provider's answer and never writes a local
 * hash for such a user:
 *
 *   - request: a linked user's reset is sent by the provider (the legacy token and
 *     email are NOT issued); every outcome stays a silent success, so the route's
 *     202 reveals nothing;
 *   - confirm: a token Backend-Core does not hold is treated as the provider's
 *     recovery proof. It is verified at the provider, its session token is
 *     verified and must name an ACTIVE link, and only then is the password
 *     updated. All failures are the same generic 400.
 *
 * The existing local reset (unlinked users) and RT-1262's refusal of a stale local
 * token for a linked user are pinned by `auth.service.password-reset-linked`.
 *
 * Docker-free: hand-written fakes, no DB, no network. Mocks prove branching and
 * non-leakage only; provider expiry and replay need live evidence.
 */
import { BadRequestException, HttpException, ServiceUnavailableException } from "@nestjs/common";
import { AuthService } from "../../src/auth/auth.service";
import type { SessionRepository } from "../../src/auth/session.repository";
import type { AuthTokenRepository } from "../../src/auth/auth-token.repository";
import type { EmailJobEnqueuer } from "../../src/auth/email-job.enqueuer";
import type { OperatorTokenVerifier } from "../../src/auth/operator-token-verifier";

let selectRows: unknown[] = [];
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
        returning: () => Promise.resolve([]),
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

/** The service's logger: a provider-session revocation failure is logged here, never surfaced. */
const logWarn = jest.fn();
jest.mock("@data-pulse-2/shared", () => ({
  ...jest.requireActual<Record<string, unknown>>("@data-pulse-2/shared"),
  createLogger: jest.fn(() => ({ warn: logWarn, info: jest.fn(), error: jest.fn(), debug: jest.fn() })),
}));

import { generateRawToken, hashPassword } from "@data-pulse-2/auth";

const mockHashPassword = hashPassword as jest.MockedFunction<typeof hashPassword>;
const mockGenerateRawToken = generateRawToken as jest.MockedFunction<typeof generateRawToken>;

const USER_ID = "0193a000-0000-7000-8000-000000000001";
const EMAIL = "manager@tower.com";
const SUBJECT = "U2externalSubject";
const NEW_PASSWORD = "New-Password-12!";
const PROOF = "provider-recovery-proof";
const REFRESH = "provider-refresh-jwt";
const SESSION_JWT = "provider-session-jwt";
const GENERIC = "Invalid or expired token";
/** The same 503 message sign-in and password change use for a provider outage. */
const PROVIDER_UNAVAILABLE = "Identity provider unavailable";

type VerifyResult =
  | { kind: "ok"; sessionJwt: string; refreshJwt: string }
  | { kind: "refused" }
  | { kind: "unavailable" };

interface Overrides {
  linkSubject?: string | null;
  localTokenRow?: { userId: string | null } | null;
  sendReset?: { kind: string };
  verifyReset?: VerifyResult;
  verifierSub?: string | Error;
  linkedUser?: { userId: string; email: string } | null;
  update?: { kind: string };
  logoutAll?: { kind: string };
  noExternal?: boolean;
}

function build(o: Overrides = {}) {
  const authTokens = {
    issue: jest.fn().mockResolvedValue({}),
    consumeActiveByRawToken: jest.fn().mockResolvedValue(o.localTokenRow ?? null),
  };
  const emailJobs = {
    enqueuePasswordReset: jest.fn().mockResolvedValue(undefined),
    enqueueEmailVerification: jest.fn().mockResolvedValue(undefined),
    enqueueInvitation: jest.fn().mockResolvedValue(undefined),
  };
  const port = {
    sendPasswordReset: jest.fn().mockResolvedValue(o.sendReset ?? { kind: "sent" }),
    verifyResetToken: jest
      .fn()
      .mockResolvedValue(o.verifyReset ?? { kind: "ok", sessionJwt: SESSION_JWT, refreshJwt: REFRESH }),
    updatePassword: jest.fn().mockResolvedValue(o.update ?? { kind: "ok" }),
    logoutAllSessions: jest.fn().mockResolvedValue(o.logoutAll ?? { kind: "ok" }),
  };
  const verify = jest.fn().mockImplementation(() => {
    const sub = o.verifierSub ?? SUBJECT;
    return sub instanceof Error ? Promise.reject(sub) : Promise.resolve({ sub });
  });
  const activeLinkSubject = jest.fn().mockResolvedValue(o.linkSubject === undefined ? SUBJECT : o.linkSubject);
  const findUserByLinkSubject = jest
    .fn()
    .mockResolvedValue(o.linkedUser === undefined ? { userId: USER_ID, email: EMAIL } : o.linkedUser);
  const endSupportSessions = jest.fn().mockResolvedValue(undefined);
  const service = new AuthService(
    {} as never,
    {} as unknown as SessionRepository,
    authTokens as unknown as AuthTokenRepository,
    emailJobs as unknown as EmailJobEnqueuer,
    {
      endSupportSessions,
      ...(o.noExternal
        ? {}
        : {
            externalCredentials: {
              port: port as never,
              verifier: { verify } as unknown as OperatorTokenVerifier,
              activeLinkSubject,
              findUserByLinkSubject,
            },
          }),
    },
  );
  return { service, authTokens, emailJobs, port, verify, activeLinkSubject, findUserByLinkSubject, endSupportSessions };
}

async function failure(p: Promise<unknown>): Promise<BadRequestException> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  return error as BadRequestException;
}

async function outage(p: Promise<unknown>): Promise<ServiceUnavailableException> {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ServiceUnavailableException);
  return error as ServiceUnavailableException;
}

beforeEach(() => {
  jest.clearAllMocks();
  selectRows = [{ id: USER_ID, email: EMAIL, passwordHash: null, deletedAt: null }];
  mockGenerateRawToken.mockReturnValue("reset-raw-token");
  mockHashPassword.mockResolvedValue("$argon2id$v=19$newhash");
});

describe("AuthService.requestPasswordReset — provider-backed recovery (RT-1327)", () => {
  it("asks the provider to send the reset to a linked user, and issues no local token or email", async () => {
    const { service, port, authTokens, emailJobs } = build();

    await expect(service.requestPasswordReset({ email: EMAIL })).resolves.toBeUndefined();

    expect(port.sendPasswordReset).toHaveBeenCalledTimes(1);
    expect(port.sendPasswordReset).toHaveBeenCalledWith(EMAIL);
    expect(authTokens.issue).not.toHaveBeenCalled();
    expect(emailJobs.enqueuePasswordReset).not.toHaveBeenCalled();
  });

  it.each([{ kind: "refused" }, { kind: "unavailable" }, { kind: "unconfigured" }])(
    "stays a silent success when the provider answers $kind (unverified email, outage, no return URL)",
    async (sendReset) => {
      const { service, authTokens, emailJobs } = build({ sendReset });

      await expect(service.requestPasswordReset({ email: EMAIL })).resolves.toBeUndefined();

      expect(authTokens.issue).not.toHaveBeenCalled();
      expect(emailJobs.enqueuePasswordReset).not.toHaveBeenCalled();
    },
  );

  it("does not contact the provider for an unlinked user, whose legacy reset is unchanged", async () => {
    const { service, port, authTokens, emailJobs } = build({ linkSubject: null });

    await service.requestPasswordReset({ email: EMAIL });

    expect(port.sendPasswordReset).not.toHaveBeenCalled();
    expect(authTokens.issue).toHaveBeenCalledTimes(1);
    expect(emailJobs.enqueuePasswordReset).toHaveBeenCalledTimes(1);
  });

  it("does not contact the provider for an unknown address", async () => {
    selectRows = [];
    const { service, port, authTokens } = build();

    await expect(service.requestPasswordReset({ email: "nobody@tower.com" })).resolves.toBeUndefined();

    expect(port.sendPasswordReset).not.toHaveBeenCalled();
    expect(authTokens.issue).not.toHaveBeenCalled();
  });
});

describe("AuthService.confirmPasswordReset — provider recovery proof (RT-1327)", () => {
  it("verifies the proof, checks the session token, updates the provider password and returns the address", async () => {
    const { service, port, verify, findUserByLinkSubject, endSupportSessions } = build();

    await expect(service.confirmPasswordReset({ rawToken: PROOF, newPassword: NEW_PASSWORD })).resolves.toBe(EMAIL);

    expect(port.verifyResetToken).toHaveBeenCalledWith(PROOF);
    expect(verify).toHaveBeenCalledWith(SESSION_JWT);
    expect(findUserByLinkSubject).toHaveBeenCalledWith(SUBJECT);
    expect(port.updatePassword).toHaveBeenCalledTimes(1);
    expect(port.updatePassword).toHaveBeenCalledWith(EMAIL, NEW_PASSWORD, REFRESH);
    // Provider is the credential authority: no local hash is written.
    expect(mockHashPassword).not.toHaveBeenCalled();
    // The only write is the Backend-Core session revocation.
    expect(updateCalls).toHaveBeenCalledTimes(1);
    expect(endSupportSessions).toHaveBeenCalledWith({ userId: USER_ID }, null);
  });

  it("never contacts the provider when the token is one Backend-Core holds (unlinked legacy reset)", async () => {
    const { service, port } = build({ linkSubject: null, localTokenRow: { userId: USER_ID } });

    await service.confirmPasswordReset({ rawToken: "local-token", newPassword: NEW_PASSWORD });

    expect(port.verifyResetToken).not.toHaveBeenCalled();
    expect(port.updatePassword).not.toHaveBeenCalled();
    expect(mockHashPassword).toHaveBeenCalledWith(NEW_PASSWORD);
  });

  it("still refuses a held local token of a linked user (RT-1262), without contacting the provider", async () => {
    const { service, port } = build({ localTokenRow: { userId: USER_ID } });

    const error = await failure(service.confirmPasswordReset({ rawToken: "local-token", newPassword: NEW_PASSWORD }));

    expect(error.message).toBe(GENERIC);
    expect(port.verifyResetToken).not.toHaveBeenCalled();
    expect(mockHashPassword).not.toHaveBeenCalled();
  });

  it("refuses an invalid, expired or replayed proof with the generic 400 and changes nothing", async () => {
    const { service, port, endSupportSessions } = build({ verifyReset: { kind: "refused" } });

    const error = await failure(service.confirmPasswordReset({ rawToken: PROOF, newPassword: NEW_PASSWORD }));

    expect(error.message).toBe(GENERIC);
    expect(port.updatePassword).not.toHaveBeenCalled();
    expect(updateCalls).not.toHaveBeenCalled();
    expect(endSupportSessions).not.toHaveBeenCalled();
  });

  it("answers a provider outage while verifying with a 503, not the invalid-proof 400, and changes nothing", async () => {
    const { service, port, endSupportSessions } = build({ verifyReset: { kind: "unavailable" } });

    const error = await outage(service.confirmPasswordReset({ rawToken: PROOF, newPassword: NEW_PASSWORD }));

    expect(error.message).toBe(PROVIDER_UNAVAILABLE);
    expect(port.updatePassword).not.toHaveBeenCalled();
    expect(updateCalls).not.toHaveBeenCalled();
    expect(endSupportSessions).not.toHaveBeenCalled();
  });

  it("answers a provider outage while updating with a 503, and revokes nothing", async () => {
    const { service, port, endSupportSessions } = build({ update: { kind: "unavailable" } });

    const error = await outage(service.confirmPasswordReset({ rawToken: PROOF, newPassword: NEW_PASSWORD }));

    expect(error.message).toBe(PROVIDER_UNAVAILABLE);
    expect(port.logoutAllSessions).not.toHaveBeenCalled();
    expect(updateCalls).not.toHaveBeenCalled();
    expect(endSupportSessions).not.toHaveBeenCalled();
  });

  it("refuses a session token that fails verification", async () => {
    const { service, port } = build({ verifierSub: new Error("bad signature") });

    const error = await failure(service.confirmPasswordReset({ rawToken: PROOF, newPassword: NEW_PASSWORD }));

    expect(error.message).toBe(GENERIC);
    expect(port.updatePassword).not.toHaveBeenCalled();
  });

  it.each([
    ["no active link (unknown, unlinked or disabled)", null],
  ])("refuses a verified subject with %s, so no second identity is ever created or reset", async (_name, linkedUser) => {
    const { service, port } = build({ linkedUser });

    const error = await failure(service.confirmPasswordReset({ rawToken: PROOF, newPassword: NEW_PASSWORD }));

    expect(error.message).toBe(GENERIC);
    expect(port.updatePassword).not.toHaveBeenCalled();
    expect(updateCalls).not.toHaveBeenCalled();
  });

  it.each([{ kind: "refused" }])(
    "revokes no session and returns no address when the provider update answers $kind (policy, reuse)",
    async (update) => {
      const { service, endSupportSessions } = build({ update });

      const error = await failure(service.confirmPasswordReset({ rawToken: PROOF, newPassword: NEW_PASSWORD }));

      expect(error.message).toBe(GENERIC);
      expect(updateCalls).not.toHaveBeenCalled();
      expect(endSupportSessions).not.toHaveBeenCalled();
    },
  );

  it("signs the user out of every provider session with the same refresh token, only after the update", async () => {
    const { service, port } = build();

    await service.confirmPasswordReset({ rawToken: PROOF, newPassword: NEW_PASSWORD });

    expect(port.logoutAllSessions).toHaveBeenCalledTimes(1);
    expect(port.logoutAllSessions).toHaveBeenCalledWith(REFRESH);
    const updateOrder = port.updatePassword.mock.invocationCallOrder[0] ?? Infinity;
    const logoutOrder = port.logoutAllSessions.mock.invocationCallOrder[0] ?? -Infinity;
    expect(logoutOrder).toBeGreaterThan(updateOrder);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it.each([
    ["verify refused", { verifyReset: { kind: "refused" } as VerifyResult }],
    ["no active link", { linkedUser: null }],
    ["update refused", { update: { kind: "refused" } }],
  ])("does not sign out provider sessions when %s", async (_name, overrides) => {
    const { service, port } = build(overrides);

    await failure(service.confirmPasswordReset({ rawToken: PROOF, newPassword: NEW_PASSWORD }));

    expect(port.logoutAllSessions).not.toHaveBeenCalled();
  });

  it.each([{ kind: "refused" }, { kind: "unavailable" }])(
    "still succeeds and revokes Backend-Core sessions when the provider sign-out answers $kind, logging a fixed warning",
    async (logoutAll) => {
      const { service, endSupportSessions } = build({ logoutAll });

      // The password is already changed and the link spent: a 400 here would lie to the user.
      await expect(service.confirmPasswordReset({ rawToken: PROOF, newPassword: NEW_PASSWORD })).resolves.toBe(EMAIL);

      expect(updateCalls).toHaveBeenCalledTimes(1);
      expect(endSupportSessions).toHaveBeenCalledWith({ userId: USER_ID }, null);
      expect(logWarn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(logWarn.mock.calls);
      expect(logged).toContain(logoutAll.kind);
      for (const secret of [PROOF, REFRESH, SESSION_JWT, SUBJECT, EMAIL, NEW_PASSWORD, USER_ID]) {
        expect(logged).not.toContain(secret);
      }
    },
  );

  it("lets only one of two submissions of the same proof change the password (duplicate submit)", async () => {
    const { service, port } = build();
    port.verifyResetToken
      .mockResolvedValueOnce({ kind: "ok", sessionJwt: SESSION_JWT, refreshJwt: REFRESH })
      .mockResolvedValueOnce({ kind: "refused" });

    await expect(service.confirmPasswordReset({ rawToken: PROOF, newPassword: NEW_PASSWORD })).resolves.toBe(EMAIL);
    await failure(service.confirmPasswordReset({ rawToken: PROOF, newPassword: NEW_PASSWORD }));

    expect(port.updatePassword).toHaveBeenCalledTimes(1);
  });

  it("refuses with the generic 400 when no provider is wired", async () => {
    const { service } = build({ noExternal: true });

    const error = await failure(service.confirmPasswordReset({ rawToken: PROOF, newPassword: NEW_PASSWORD }));

    expect(error.message).toBe(GENERIC);
    expect(updateCalls).not.toHaveBeenCalled();
  });

  it.each([
    ["verify refused", { verifyReset: { kind: "refused" } as VerifyResult }],
    ["verify unavailable", { verifyReset: { kind: "unavailable" } as VerifyResult }],
    ["bad session token", { verifierSub: new Error("bad signature") }],
    ["no active link", { linkedUser: null }],
    ["update refused", { update: { kind: "refused" } }],
    ["update unavailable", { update: { kind: "unavailable" } }],
  ])("leaks no credential or identity information in the %s failure", async (_name, overrides) => {
    const { service } = build(overrides);

    const error = await service.confirmPasswordReset({ rawToken: PROOF, newPassword: NEW_PASSWORD }).then(
      () => null,
      (e: unknown) => e as HttpException,
    );
    expect(error).toBeInstanceOf(HttpException);
    if (error === null) return;
    const text = JSON.stringify([error.message, error.getResponse(), logWarn.mock.calls]);

    for (const secret of [PROOF, REFRESH, SESSION_JWT, SUBJECT, EMAIL, NEW_PASSWORD, USER_ID]) {
      expect(text).not.toContain(secret);
    }
  });
});
