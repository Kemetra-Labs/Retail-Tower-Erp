/**
 * RT-1439 — `AuthService.verifyCurrentPassword`, the password check behind `consoleReauthenticate`.
 *
 *   - a user with an ACTIVE external link is verified at the provider (token verified, subject must
 *     be the link's); the LOCAL hash is never consulted, so an old local password never re-authenticates;
 *   - the provider session the check creates is ended again: that ONE session (`endSession`), never
 *     `logoutAllSessions` (the user's other provider sessions, a POS operator's among them, survive);
 *     a failed or impossible discard does not fail the check;
 *   - a user with no link is verified against the native Argon2 hash; no hash is a refusal;
 *   - an outage is a 503, never a refusal; a refusal, a subject mismatch and a bad token are all `refused`.
 *
 * Docker-free: hand-written fakes, no DB, no network.
 */
import { ServiceUnavailableException } from "@nestjs/common";

import { AuthService } from "../../src/auth/auth.service";
import type { ExternalCredentialPort, VerifyPasswordResult } from "../../src/auth/external-credential.port";
import type { OperatorTokenVerifier } from "../../src/auth/operator-token-verifier";
import type { SessionRepository } from "../../src/auth/session.repository";

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
  generateRawToken: jest.fn(() => "raw"),
  hashToken: jest.fn(() => Buffer.alloc(32)),
}));

import { verifyPassword } from "@data-pulse-2/auth";

const mockVerifyPassword = verifyPassword as jest.MockedFunction<typeof verifyPassword>;

const USER_ID = "0193a000-0000-7000-8000-000000000001";
const EMAIL = "owner@tower.com";
const SUBJECT = "U2externalSubject";
const PASSWORD = "Correct-Horse-Battery-9!";

const userRow = (passwordHash: string | null = "$argon2id$native") => ({
  id: USER_ID,
  email: EMAIL,
  passwordHash,
  displayName: "Owner",
  isPlatformAdmin: false,
  deletedAt: null,
});

function build(opts: {
  verify?: VerifyPasswordResult;
  verifiedSubject?: string | Error;
  linkSubject?: string | null;
  endSession?: "ok" | "refused" | "unavailable" | "throws";
}) {
  const port = {
    verifyPassword: jest.fn().mockResolvedValue(opts.verify ?? { kind: "ok", sessionJwt: "jwt", refreshJwt: "refresh-1" }),
    endSession: jest.fn().mockImplementation(() =>
      opts.endSession === "throws" ? Promise.reject(new Error("boom")) : Promise.resolve({ kind: opts.endSession ?? "ok" }),
    ),
    logoutAllSessions: jest.fn(),
    passwordSignIn: jest.fn(),
  } as unknown as ExternalCredentialPort & Record<"verifyPassword" | "endSession" | "logoutAllSessions" | "passwordSignIn", jest.Mock>;
  const verifier: OperatorTokenVerifier = {
    verify: jest.fn().mockImplementation(() =>
      opts.verifiedSubject instanceof Error
        ? Promise.reject(opts.verifiedSubject)
        : Promise.resolve({ providerKey: "p", sub: opts.verifiedSubject ?? SUBJECT }),
    ),
  };
  const service = new AuthService({} as never, {} as unknown as SessionRepository, undefined, undefined, {
    externalCredentials: {
      port,
      verifier,
      activeLinkSubject: jest.fn().mockResolvedValue(opts.linkSubject === undefined ? SUBJECT : opts.linkSubject),
      findUserByLinkSubject: jest.fn().mockResolvedValue(null),
    },
  });
  return { service, port, verifier };
}

beforeEach(() => {
  selectRows = [userRow()];
  mockVerifyPassword.mockResolvedValue(false);
});

describe("AuthService.verifyCurrentPassword — user with an active external link", () => {
  it("verifies at the provider, then ends THAT session only (never logoutAll)", async () => {
    const { service, port, verifier } = build({});
    await expect(service.verifyCurrentPassword(USER_ID, PASSWORD)).resolves.toBe("ok");
    expect(port.verifyPassword).toHaveBeenCalledWith(EMAIL, PASSWORD);
    expect(verifier.verify).toHaveBeenCalledWith("jwt");
    expect(port.endSession).toHaveBeenCalledWith("refresh-1");
    expect(port.logoutAllSessions).not.toHaveBeenCalled();
    expect(mockVerifyPassword).not.toHaveBeenCalled(); // the local hash is never consulted
  });

  it("the LOCAL password never re-authenticates a linked user", async () => {
    mockVerifyPassword.mockResolvedValue(true);
    const { service, port } = build({ verify: { kind: "refused" } });
    await expect(service.verifyCurrentPassword(USER_ID, PASSWORD)).resolves.toBe("refused");
    expect(port.endSession).not.toHaveBeenCalled(); // no session was created
  });

  it.each([
    ["a subject that is not the link's", { verifiedSubject: "U2someoneElse" }],
    ["a token that fails verification", { verifiedSubject: new Error("bad signature") }],
  ])("refuses %s, and still ends the session the check created", async (_name, opts) => {
    const { service, port } = build(opts);
    await expect(service.verifyCurrentPassword(USER_ID, PASSWORD)).resolves.toBe("refused");
    expect(port.endSession).toHaveBeenCalledWith("refresh-1");
  });

  it.each(["refused", "unavailable", "throws"] as const)("a discard that is %s does not fail the check", async (endSession) => {
    const { service } = build({ endSession });
    await expect(service.verifyCurrentPassword(USER_ID, PASSWORD)).resolves.toBe("ok");
  });

  it("no refresh token: the session cannot be ended from here, and the check still succeeds", async () => {
    const { service, port } = build({ verify: { kind: "ok", sessionJwt: "jwt", refreshJwt: null } });
    await expect(service.verifyCurrentPassword(USER_ID, PASSWORD)).resolves.toBe("ok");
    expect(port.endSession).not.toHaveBeenCalled();
  });

  it("answers 503, not a refusal, when the provider is unavailable", async () => {
    const { service } = build({ verify: { kind: "unavailable" } });
    await expect(service.verifyCurrentPassword(USER_ID, PASSWORD)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe("AuthService.verifyCurrentPassword — user with no link", () => {
  it("verifies the native hash and never calls the provider", async () => {
    mockVerifyPassword.mockResolvedValue(true);
    const { service, port } = build({ linkSubject: null });
    await expect(service.verifyCurrentPassword(USER_ID, PASSWORD)).resolves.toBe("ok");
    expect(mockVerifyPassword).toHaveBeenCalledWith("$argon2id$native", PASSWORD);
    expect(port.verifyPassword).not.toHaveBeenCalled();
  });

  it("refuses a wrong native password, a user with no hash and an unknown user", async () => {
    const { service } = build({ linkSubject: null });
    await expect(service.verifyCurrentPassword(USER_ID, "wrong")).resolves.toBe("refused");
    selectRows = [userRow(null)];
    await expect(service.verifyCurrentPassword(USER_ID, PASSWORD)).resolves.toBe("refused");
    selectRows = [];
    await expect(service.verifyCurrentPassword(USER_ID, PASSWORD)).resolves.toBe("refused");
  });
});
