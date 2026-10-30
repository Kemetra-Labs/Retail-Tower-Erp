/**
 * auth.service.change-password.unit.spec.ts — RT-937 item 2 (D-C).
 *
 * Change password for a user with an ACTIVE external identity link replaces the
 * password at the provider (old + new), then revokes the user's OTHER native
 * sessions and ends their support sessions. Rules pinned here:
 *
 *   - a wrong current password, a rejected new password and a provider answer
 *     that fails verification are ONE generic 400, with no revocation;
 *   - the current session survives; only the others are revoked (D-C);
 *   - a provider outage is a 503;
 *   - a user with no active link gets a 409 and the provider is never called
 *     (no native change-password exists, and none is invented here);
 *   - the native password hash is never read or written.
 *
 * Docker-free: hand-written fakes, no DB, no network.
 */
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthService } from "../../src/auth/auth.service";
import type { SessionRepository } from "../../src/auth/session.repository";
import type {
  ExternalCredentialPort,
  ReplacePasswordResult,
} from "../../src/auth/external-credential.port";
import type { OperatorTokenVerifier } from "../../src/auth/operator-token-verifier";

let selectRows: unknown[] = [];

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => ({ limit: () => Promise.resolve(selectRows) }),
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

import { verifyPassword, hashPassword } from "@data-pulse-2/auth";

const mockVerifyPassword = verifyPassword as jest.MockedFunction<typeof verifyPassword>;
const mockHashPassword = hashPassword as jest.MockedFunction<typeof hashPassword>;

const USER_ID = "0193a000-0000-7000-8000-000000000001";
const SESSION_ID = "0193a000-0000-7000-8000-000000000002";
const OTHER_A = "0193a000-0000-7000-8000-0000000000a1";
const OTHER_B = "0193a000-0000-7000-8000-0000000000a2";
const EMAIL = "manager@tower.com";
const SUBJECT = "U2externalSubject";
const CURRENT = "Old-Password-1!";
const NEXT = "New-Password-2!";

function build(opts: {
  replace?: ReplacePasswordResult;
  verifiedSubject?: string | Error;
  linkSubject?: string | null;
  revoked?: string[];
}) {
  const sessions = {
    revokeOthersForUser: jest.fn().mockResolvedValue(opts.revoked ?? [OTHER_A, OTHER_B]),
  };
  const port = {
    replacePassword: jest.fn().mockResolvedValue(opts.replace ?? { kind: "ok", sessionJwt: "jwt" }),
  } as unknown as ExternalCredentialPort & { replacePassword: jest.Mock };
  const verifier: OperatorTokenVerifier = {
    verify: jest.fn().mockImplementation(() =>
      opts.verifiedSubject instanceof Error
        ? Promise.reject(opts.verifiedSubject)
        : Promise.resolve({ providerKey: "p", sub: opts.verifiedSubject ?? SUBJECT }),
    ),
  };
  const endSupportSessions = jest.fn().mockResolvedValue(undefined);
  const service = new AuthService({} as never, sessions as unknown as SessionRepository, undefined, undefined, {
    endSupportSessions,
    externalCredentials: {
      port,
      verifier,
      activeLinkSubject: jest.fn().mockResolvedValue(opts.linkSubject === undefined ? SUBJECT : opts.linkSubject),
    },
  });
  return { service, sessions, port, verifier, endSupportSessions };
}

const input = {
  userId: USER_ID,
  sessionId: SESSION_ID,
  currentPassword: CURRENT,
  newPassword: NEXT,
  requestId: "req-1",
};

beforeEach(() => {
  selectRows = [{ id: USER_ID, email: EMAIL, deletedAt: null }];
});

describe("AuthService.changePassword", () => {
  it("replaces the password at the provider and verifies the answer against the link", async () => {
    const { service, port, verifier } = build({});

    await service.changePassword(input);

    expect(port.replacePassword).toHaveBeenCalledWith(EMAIL, CURRENT, NEXT);
    expect(verifier.verify).toHaveBeenCalledWith("jwt");
  });

  it("revokes the OTHER sessions, keeps the current one, and ends each revoked session's support sessions (D-C)", async () => {
    const { service, sessions, endSupportSessions } = build({});

    await service.changePassword(input);

    expect(sessions.revokeOthersForUser).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    expect(endSupportSessions).toHaveBeenCalledTimes(2);
    expect(endSupportSessions).toHaveBeenCalledWith({ authSessionId: OTHER_A }, "req-1");
    expect(endSupportSessions).toHaveBeenCalledWith({ authSessionId: OTHER_B }, "req-1");
  });

  it("succeeds when there are no other sessions", async () => {
    const { service, endSupportSessions } = build({ revoked: [] });
    await expect(service.changePassword(input)).resolves.toBeUndefined();
    expect(endSupportSessions).not.toHaveBeenCalled();
  });

  it("never reads or writes the native password hash", async () => {
    const { service } = build({});
    await service.changePassword(input);
    expect(mockVerifyPassword).not.toHaveBeenCalled();
    expect(mockHashPassword).not.toHaveBeenCalled();
  });

  it("answers one generic 400 when the provider refuses (wrong current or rejected new password)", async () => {
    const { service, sessions } = build({ replace: { kind: "refused" } });

    const error = await service.changePassword(input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify((error as BadRequestException).getResponse())).not.toContain(CURRENT);
    expect(sessions.revokeOthersForUser).not.toHaveBeenCalled();
  });

  it("answers 503 when the provider is unavailable, and revokes nothing", async () => {
    const { service, sessions } = build({ replace: { kind: "unavailable" } });
    await expect(service.changePassword(input)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sessions.revokeOthersForUser).not.toHaveBeenCalled();
  });

  it("answers the same generic 400 when the provider token's subject is not the link's", async () => {
    const { service, sessions } = build({ verifiedSubject: "U2someoneElse" });
    await expect(service.changePassword(input)).rejects.toBeInstanceOf(BadRequestException);
    expect(sessions.revokeOthersForUser).not.toHaveBeenCalled();
  });

  it("answers the same generic 400 when the provider token fails verification", async () => {
    const { service, sessions } = build({ verifiedSubject: new Error("bad signature") });
    await expect(service.changePassword(input)).rejects.toBeInstanceOf(BadRequestException);
    expect(sessions.revokeOthersForUser).not.toHaveBeenCalled();
  });

  it("answers 409, without calling the provider, for a user with no active link", async () => {
    const { service, port } = build({ linkSubject: null });
    await expect(service.changePassword(input)).rejects.toBeInstanceOf(ConflictException);
    expect(port.replacePassword).not.toHaveBeenCalled();
  });

  it("answers 401, without calling the provider, when the session's user no longer exists", async () => {
    selectRows = [];
    const { service, port } = build({});
    await expect(service.changePassword(input)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(port.replacePassword).not.toHaveBeenCalled();
  });
});
