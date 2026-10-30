/**
 * auth.service.external-signin.unit.spec.ts — RT-937 item 1 (RT-790 approach A, D-A).
 *
 * Admin sign-in for a user who has an ACTIVE external identity link verifies the
 * password at the external provider (server side), then mints the SAME native
 * session as before. Rules pinned here (RT-791 c13467 rule 1, c13436):
 *
 *   - a linked user's LOCAL password never signs in: refusal is the same 401
 *     and the same audit/metric path as a wrong password (no linkage oracle);
 *   - the provider's answer alone authenticates nobody: its session token is
 *     verified and its subject must equal the link's subject;
 *   - an outage is a 503, never a 401 (an outage is not a wrong password);
 *   - a user with NO active link keeps native sign-in until migrated, and the
 *     provider is never called for an unknown or unlinked email;
 *   - the native argon2 verify still runs on every path (latency does not
 *     depend on whether the user exists or is linked).
 *
 * Docker-free: hand-written fakes, no DB, no network.
 */
import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "../../src/auth/auth.service";
import type { SessionRepository } from "../../src/auth/session.repository";
import type { AuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import type {
  ExternalCredentialPort,
  PasswordSignInResult,
} from "../../src/auth/external-credential.port";
import type { OperatorTokenVerifier } from "../../src/auth/operator-token-verifier";

let selectRows: unknown[] = [];

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => {
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => ({
        limit: () => Promise.resolve(selectRows),
        then: (resolve: (v: unknown) => void) => resolve({ rowCount: 1 }),
      }),
      update: () => chain,
      set: () => chain,
    };
    return chain;
  }),
}));

jest.mock("@data-pulse-2/auth", () => {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return {
    verifyPassword: jest.fn(),
    hashPassword: jest.fn(),
    needsRehash: jest.fn(() => true),
    generateRawToken: jest.fn(() => "raw-session-credential"),
    hashToken: (token: string): Buffer => createHash("sha256").update(token).digest(),
  };
});

import { verifyPassword, hashPassword } from "@data-pulse-2/auth";

const mockVerifyPassword = verifyPassword as jest.MockedFunction<typeof verifyPassword>;
const mockHashPassword = hashPassword as jest.MockedFunction<typeof hashPassword>;

const USER_ID = "0193a000-0000-7000-8000-000000000001";
const EMAIL = "manager@tower.com";
const SUBJECT = "U2externalSubject";
const PASSWORD = "Correct-Horse-Battery-9!";

function userRow(overrides: Partial<{ passwordHash: string | null }> = {}) {
  return {
    id: USER_ID,
    email: EMAIL,
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$fake$fakehash",
    displayName: "Manager",
    isPlatformAdmin: false,
    deletedAt: null,
    ...overrides,
  };
}

class FakeSessions {
  create = jest.fn().mockResolvedValue({});
}

function build(opts: {
  signIn?: PasswordSignInResult;
  verifiedSubject?: string | Error;
  linkSubject?: string | null;
}) {
  const sessions = new FakeSessions();
  const audit = { enqueue: jest.fn().mockResolvedValue(undefined) } as unknown as AuditJobEnqueuer & {
    enqueue: jest.Mock;
  };
  const port = {
    passwordSignIn: jest.fn().mockResolvedValue(opts.signIn ?? { kind: "ok", sessionJwt: "jwt" }),
  } as unknown as ExternalCredentialPort & { passwordSignIn: jest.Mock };
  const verifier: OperatorTokenVerifier = {
    verify: jest.fn().mockImplementation(() =>
      opts.verifiedSubject instanceof Error
        ? Promise.reject(opts.verifiedSubject)
        : Promise.resolve({ providerKey: "p", sub: opts.verifiedSubject ?? SUBJECT }),
    ),
  };
  const activeLinkSubject = jest
    .fn()
    .mockResolvedValue(opts.linkSubject === undefined ? SUBJECT : opts.linkSubject);
  const service = new AuthService({} as never, sessions as unknown as SessionRepository, undefined, undefined, {
    auditEnqueuer: audit,
    externalCredentials: { port, verifier, activeLinkSubject },
  });
  return { service, sessions, audit, port, verifier, activeLinkSubject };
}

beforeEach(() => {
  selectRows = [userRow()];
  mockVerifyPassword.mockResolvedValue(false);
  mockHashPassword.mockResolvedValue("$argon2id$v=19$rehash");
});

describe("AuthService.signIn — user with an active external link", () => {
  it("authenticates at the provider, then mints the native session", async () => {
    const { service, sessions, port, verifier, audit } = build({});

    const result = await service.signIn({ email: EMAIL, password: PASSWORD });

    expect(port.passwordSignIn).toHaveBeenCalledWith(EMAIL, PASSWORD);
    expect(verifier.verify).toHaveBeenCalledWith("jwt");
    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(result.userId).toBe(USER_ID);
    expect(result.sessionCredential).toBe("raw-session-credential");
    expect(result.user).toEqual({
      id: USER_ID,
      email: EMAIL,
      display_name: "Manager",
      is_platform_admin: false,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(audit.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.signin.ok", actor_user_id: USER_ID }),
    );
  });

  it("still runs the native argon2 verify on every path", async () => {
    const { service } = build({});
    await service.signIn({ email: EMAIL, password: PASSWORD });
    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
  });

  it("never lets the LOCAL password sign a linked user in (the provider refuses)", async () => {
    mockVerifyPassword.mockResolvedValue(true); // the old local hash would match
    const { service, sessions, audit } = build({ signIn: { kind: "refused" } });

    await expect(service.signIn({ email: EMAIL, password: PASSWORD })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessions.create).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(audit.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.signin.failed", actor_user_id: null }),
    );
  });

  it("refuses with the same message as a wrong password (no linkage oracle)", async () => {
    mockVerifyPassword.mockResolvedValue(false);
    const linked = build({ signIn: { kind: "refused" } });
    const linkedError = await linked.service
      .signIn({ email: EMAIL, password: "wrong" })
      .catch((e: unknown) => e as UnauthorizedException);

    const unlinked = build({ linkSubject: null });
    const unlinkedError = await unlinked.service
      .signIn({ email: EMAIL, password: "wrong" })
      .catch((e: unknown) => e as UnauthorizedException);

    expect((linkedError as UnauthorizedException).getResponse()).toEqual(
      (unlinkedError as UnauthorizedException).getResponse(),
    );
  });

  it("refuses when the provider's token subject is not the link's subject", async () => {
    const { service, sessions } = build({ verifiedSubject: "U2someoneElse" });
    await expect(service.signIn({ email: EMAIL, password: PASSWORD })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("refuses when the provider's token fails verification", async () => {
    const { service, sessions } = build({ verifiedSubject: new Error("bad signature") });
    await expect(service.signIn({ email: EMAIL, password: PASSWORD })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("answers 503, not 401, when the provider is unavailable", async () => {
    const { service, sessions } = build({ signIn: { kind: "unavailable" } });
    await expect(service.signIn({ email: EMAIL, password: PASSWORD })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("signs in a provider-only user (no local hash)", async () => {
    selectRows = [userRow({ passwordHash: null })];
    const { service, sessions } = build({});
    await service.signIn({ email: EMAIL, password: PASSWORD });
    expect(sessions.create).toHaveBeenCalledTimes(1);
  });

  it("does not re-hash a local password on a provider sign-in", async () => {
    mockVerifyPassword.mockResolvedValue(true);
    const { service } = build({});
    await service.signIn({ email: EMAIL, password: PASSWORD });
    expect(mockHashPassword).not.toHaveBeenCalled();
  });
});

describe("AuthService.signIn — user without an active external link", () => {
  it("keeps native sign-in until migrated, and never calls the provider", async () => {
    mockVerifyPassword.mockResolvedValue(true);
    const { service, sessions, port } = build({ linkSubject: null });

    await service.signIn({ email: EMAIL, password: PASSWORD });

    expect(port.passwordSignIn).not.toHaveBeenCalled();
    expect(sessions.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a wrong native password without calling the provider", async () => {
    const { service, port } = build({ linkSubject: null });
    await expect(service.signIn({ email: EMAIL, password: "wrong" })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(port.passwordSignIn).not.toHaveBeenCalled();
  });

  it("never forwards an unknown email's password to the provider", async () => {
    selectRows = [];
    const { service, port, activeLinkSubject } = build({});
    await expect(service.signIn({ email: "nobody@tower.com", password: PASSWORD })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(port.passwordSignIn).not.toHaveBeenCalled();
    expect(activeLinkSubject).not.toHaveBeenCalled();
    expect(mockVerifyPassword).toHaveBeenCalledTimes(1);
  });
});

describe("AuthService.startSession (shared by sign-in and invitation acceptance)", () => {
  it("creates one native session for the user and returns its id, credential and absolute expiry", async () => {
    const { service, sessions } = build({});

    const started = await service.startSession(USER_ID);

    expect(sessions.create).toHaveBeenCalledTimes(1);
    const row = sessions.create.mock.calls[0]?.[0] as {
      id: string;
      userId: string;
      absoluteExpiresAt: Date;
      credentialHash: Buffer;
    };
    expect(row.userId).toBe(USER_ID);
    expect(row.id).toBe(started.sessionId);
    expect(row.absoluteExpiresAt).toEqual(started.absoluteExpiresAt);
    expect(started.sessionCredential).toBe("raw-session-credential");
    // Only the SHA-256 of the cookie value is persisted, never the value itself.
    expect(row.credentialHash).toBeInstanceOf(Buffer);
    expect(JSON.stringify(row)).not.toContain("raw-session-credential");
    expect(started.absoluteExpiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });
});
