/**
 * invitations.accept-provisioning.unit.spec.ts — RT-937 item 4 (D-D, c13436, c13437, c13467).
 *
 * Accepting an invitation:
 *   - an EXISTING Backend-Core user gains the membership only: no provider call,
 *     no session (an invite token alone must never mint a session for an
 *     existing account);
 *   - a NEW user is created at the identity provider with a verified email and
 *     an ACTIVE password, then user + identity link + membership are written in
 *     ONE transaction, and a session is minted for that new user only;
 *   - the token is single-use: a used, expired or unknown token is the same
 *     opaque 400 with ZERO provider calls and ZERO writes;
 *   - tenant, role and stores come from the invitation row, never from the body;
 *   - a retry after a partial provider failure converges on one identity.
 *
 * Docker-free: fakes for the repository, transaction runner and provider port.
 * RLS is a DB-layer guarantee and is covered only by the db-integration suite.
 */
import "reflect-metadata";
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

let _roleCodeRows: Array<{ code: string }> = [{ code: "store_manager" }];

jest.mock("drizzle-orm/node-postgres", () => ({
  drizzle: jest.fn(() => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(_roleCodeRows),
    };
    return chain;
  }),
}));

jest.mock("@data-pulse-2/auth", () => ({
  generateRawToken: jest.fn(),
  hashToken: jest.fn(() => Buffer.from("token-hash")),
  verifyPassword: jest.fn(),
  hashPassword: jest.fn(),
}));

jest.mock("@data-pulse-2/shared", () => ({
  QUEUE_NAMES: jest.requireActual("@data-pulse-2/shared").QUEUE_NAMES,
  loadFragmentDir: jest.requireActual("@data-pulse-2/shared").loadFragmentDir,
  newId: jest.fn(),
  assertMetricLabels: jest.fn(),
  getMeter: jest.fn(() => ({
    createCounter: jest.fn(() => ({ add: jest.fn() })),
    createHistogram: jest.fn(() => ({ record: jest.fn() })),
    createObservableGauge: jest.fn(() => ({ addCallback: jest.fn(), removeCallback: jest.fn() })),
  })),
}));

import { InvitationsService } from "../../src/memberships/invitations.service";
import type { InvitationsRepository } from "../../src/memberships/invitations.repository";
import type { EmailJobEnqueuer } from "../../src/auth/email-job.enqueuer";
import type { ExternalCredentialPort } from "../../src/auth/external-credential.port";
import type { OperatorTokenVerifier } from "../../src/auth/operator-token-verifier";
import type { InvitationRow, UserRow } from "@data-pulse-2/db/schema";
import {
  asHierarchy,
  makeFakeHierarchy,
  type FakeMembershipHierarchy,
} from "../_helpers/fake-membership-hierarchy";
import { newId } from "@data-pulse-2/shared";

const mockNewId = newId as jest.MockedFunction<typeof newId>;

const TENANT_ID = "0193c000-0000-7000-8000-0000000000a1";
const INVITATION_ID = "0193c000-0000-7000-8000-000000000001";
const ROLE_ID = "0193c000-0000-7000-8000-000000000002";
const NEW_USER_ID = "0193c000-0000-7000-8000-000000000003";
const MEMBERSHIP_ID = "0193c000-0000-7000-8000-000000000004";
const EXISTING_USER_ID = "0193c000-0000-7000-8000-000000000005";
const STORE_ID = "0193c000-0000-7000-8000-000000000010";
const EMAIL = "newhire@example.com";
const PASSWORD = "Correct-Horse-Battery-9!";
const PROVIDER_USER_ID = "U2providerUser";
const ISSUER = "https://api.descope.com/v1/apps/P2abc";

function invitation(overrides: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: INVITATION_ID,
    tenantId: TENANT_ID,
    email: EMAIL,
    roleId: ROLE_ID,
    storeAccessKind: "specific",
    invitedStoreIds: [STORE_ID],
    invitedByUserId: "0193c000-0000-7000-8000-000000000099",
    tokenHash: Buffer.from("token-hash"),
    status: "pending",
    expiresAt: new Date(Date.now() + 60_000),
    acceptedByUserId: null,
    acceptedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as InvitationRow;
}

function existingUser(): UserRow {
  return { id: EXISTING_USER_ID, email: EMAIL, displayName: "Existing" } as UserRow;
}

/** Records the order of every DB write so ordering is assertable. */
const writes: string[] = [];

function fakeRepo(opts: { invitation?: InvitationRow | null; user?: UserRow | null; markAccepted?: boolean }) {
  const repo = {
    findByTokenHash: jest.fn().mockResolvedValue(opts.invitation === undefined ? invitation() : opts.invitation),
    findUserByEmail: jest.fn().mockResolvedValue(opts.user ?? null),
    insertUser: jest.fn().mockImplementation(() => (writes.push("insertUser"), Promise.resolve())),
    insertExternalIdentityLink: jest
      .fn()
      .mockImplementation(() => (writes.push("insertExternalIdentityLink"), Promise.resolve())),
    markAccepted: jest
      .fn()
      .mockImplementation(() => (writes.push("markAccepted"), Promise.resolve(opts.markAccepted ?? true))),
    createMembership: jest.fn().mockImplementation(() => (writes.push("createMembership"), Promise.resolve({}))),
    insertStoreAccessRows: jest
      .fn()
      .mockImplementation(() => (writes.push("insertStoreAccessRows"), Promise.resolve())),
  };
  return repo;
}

function fakePort(over: Partial<Record<keyof ExternalCredentialPort, jest.Mock>> = {}) {
  const port = {
    identity: { providerKey: "p", issuer: ISSUER },
    passwordSignIn: jest.fn().mockResolvedValue({ kind: "ok", sessionJwt: "jwt" }),
    replacePassword: jest.fn(),
    createUser: jest.fn().mockResolvedValue({ kind: "created", userId: PROVIDER_USER_ID }),
    loadUser: jest.fn(),
    setActivePassword: jest.fn().mockResolvedValue({ kind: "ok" }),
    ...over,
  };
  return port as unknown as ExternalCredentialPort & Record<string, jest.Mock>;
}

function build(opts: {
  repo?: ReturnType<typeof fakeRepo>;
  port?: ReturnType<typeof fakePort>;
  verifiedSub?: string | Error;
  hierarchy?: FakeMembershipHierarchy;
}) {
  const repo = opts.repo ?? fakeRepo({ user: null });
  const hierarchy = opts.hierarchy ?? makeFakeHierarchy();
  const port = opts.port ?? fakePort();
  const verifier: OperatorTokenVerifier = {
    verify: jest.fn().mockImplementation(() =>
      opts.verifiedSub instanceof Error
        ? Promise.reject(opts.verifiedSub)
        : Promise.resolve({ providerKey: "p", sub: opts.verifiedSub ?? PROVIDER_USER_ID }),
    ),
  };
  const sessions = {
    startSession: jest.fn().mockResolvedValue({
      sessionId: "sess-1",
      sessionCredential: "cookie-1",
      absoluteExpiresAt: new Date(Date.now() + 86_400_000),
    }),
  };
  const tx = jest.fn(
    async (_pool: Pool, _ctx: unknown, work: (c: PoolClient) => Promise<unknown>): Promise<never> =>
      (await work({} as PoolClient)) as never,
  );
  const service = new InvitationsService(
    {} as Pool,
    repo as unknown as InvitationsRepository,
    { enqueueInvitation: jest.fn() } as unknown as EmailJobEnqueuer,
    tx as never,
    port,
    verifier,
    sessions,
    asHierarchy(hierarchy),
  );
  return { service, repo, port, verifier, sessions, tx, hierarchy };
}

beforeEach(() => {
  writes.length = 0;
  _roleCodeRows = [{ code: "store_manager" }];
  mockNewId.mockReset();
  mockNewId.mockReturnValueOnce(NEW_USER_ID).mockReturnValue(MEMBERSHIP_ID);
});

const accept = { token: "raw-token", password: PASSWORD, displayName: "New Hire" };

describe("acceptInvitation — NEW user", () => {
  it("provisions at the provider, writes user + link + membership in one transaction, and mints a session", async () => {
    const { service, repo, port, sessions } = build({});

    const result = await service.acceptInvitation(accept);

    expect(port.createUser).toHaveBeenCalledWith({ loginId: EMAIL, email: EMAIL, name: "New Hire" });
    expect(port.setActivePassword).toHaveBeenCalledWith(EMAIL, PASSWORD);
    expect(repo.insertUser).toHaveBeenCalledWith(expect.anything(), {
      id: NEW_USER_ID,
      email: EMAIL,
      displayName: "New Hire",
    });
    expect(repo.insertExternalIdentityLink).toHaveBeenCalledWith(expect.anything(), {
      providerKey: "p",
      issuer: ISSUER,
      subject: PROVIDER_USER_ID,
      userId: NEW_USER_ID,
      email: EMAIL,
    });
    // FK order: the user and its link exist before the invitation names the user.
    expect(writes).toEqual([
      "insertUser",
      "insertExternalIdentityLink",
      "markAccepted",
      "createMembership",
      "insertStoreAccessRows",
    ]);
    expect(sessions.startSession).toHaveBeenCalledWith(NEW_USER_ID);
    expect(result.session).toEqual(expect.objectContaining({ sessionCredential: "cookie-1" }));
    expect(result.membership).toEqual(
      expect.objectContaining({
        membershipId: MEMBERSHIP_ID,
        roleCode: "store_manager",
        storeAccessKind: "specific",
        accessibleStoreIds: [STORE_ID],
        user: expect.objectContaining({ id: NEW_USER_ID, email: EMAIL }),
      }),
    );
  });

  it("takes tenant, role and stores from the invitation row, never from the request", async () => {
    const { service, repo } = build({});
    await service.acceptInvitation({ ...accept, tenantId: "evil", roleCode: "owner" } as never);

    expect(repo.createMembership).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: TENANT_ID, roleId: ROLE_ID, userId: NEW_USER_ID }),
    );
  });

  it("uses the email's local part as the display name when none is given", async () => {
    const { service, port } = build({});
    await service.acceptInvitation({ token: "raw-token", password: PASSWORD });
    expect(port.createUser).toHaveBeenCalledWith(expect.objectContaining({ name: "newhire" }));
  });

  it("requires a password for a new user, with no provider call and no write", async () => {
    const { service, port, repo } = build({});
    await expect(service.acceptInvitation({ token: "raw-token" })).rejects.toBeInstanceOf(BadRequestException);
    expect(port.createUser).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(repo.insertUser).not.toHaveBeenCalled();
  });

  it("a password the provider rejects is a 400 and nothing is written", async () => {
    const { service } = build({ port: fakePort({ setActivePassword: jest.fn().mockResolvedValue({ kind: "rejected" }) }) });
    await expect(service.acceptInvitation(accept)).rejects.toBeInstanceOf(BadRequestException);
    expect(writes).toEqual([]);
  });

  it("an unconfigured or unavailable provider is a 503 and nothing is written", async () => {
    for (const kind of ["unconfigured", "unavailable"] as const) {
      writes.length = 0;
      mockNewId.mockReset();
      mockNewId.mockReturnValueOnce(NEW_USER_ID).mockReturnValue(MEMBERSHIP_ID);
      const { service } = build({ port: fakePort({ createUser: jest.fn().mockResolvedValue({ kind }) }) });
      await expect(service.acceptInvitation(accept)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(writes).toEqual([]);
    }
  });

  it("converges on retry: the provider user exists without a password, so the password is set and the flow completes", async () => {
    const port = fakePort({
      createUser: jest.fn().mockResolvedValue({ kind: "rejected" }),
      loadUser: jest.fn().mockResolvedValue({ kind: "found", userId: PROVIDER_USER_ID, passwordSet: false }),
    });
    const { service, repo } = build({ port });

    await service.acceptInvitation(accept);

    expect(port.setActivePassword).toHaveBeenCalledWith(EMAIL, PASSWORD);
    expect(repo.insertExternalIdentityLink).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subject: PROVIDER_USER_ID }),
    );
  });

  it("converges on retry: the provider user already has this password, proved by a verified sign-in", async () => {
    const port = fakePort({
      createUser: jest.fn().mockResolvedValue({ kind: "rejected" }),
      loadUser: jest.fn().mockResolvedValue({ kind: "found", userId: PROVIDER_USER_ID, passwordSet: true }),
    });
    const { service, port: p, verifier } = build({ port });

    await service.acceptInvitation(accept);

    expect(p.setActivePassword).not.toHaveBeenCalled();
    expect(p.passwordSignIn).toHaveBeenCalledWith(EMAIL, PASSWORD);
    expect(verifier.verify).toHaveBeenCalledWith("jwt");
  });

  it("refuses (409) a provider user that already has a password the invitee cannot prove", async () => {
    const port = fakePort({
      createUser: jest.fn().mockResolvedValue({ kind: "rejected" }),
      loadUser: jest.fn().mockResolvedValue({ kind: "found", userId: PROVIDER_USER_ID, passwordSet: true }),
      passwordSignIn: jest.fn().mockResolvedValue({ kind: "refused" }),
    });
    const { service } = build({ port });
    await expect(service.acceptInvitation(accept)).rejects.toBeInstanceOf(ConflictException);
    expect(writes).toEqual([]);
  });

  it("refuses (409) when the proof's token names a different provider user", async () => {
    const port = fakePort({
      createUser: jest.fn().mockResolvedValue({ kind: "rejected" }),
      loadUser: jest.fn().mockResolvedValue({ kind: "found", userId: PROVIDER_USER_ID, passwordSet: true }),
    });
    const { service } = build({ port, verifiedSub: "U2someoneElse" });
    await expect(service.acceptInvitation(accept)).rejects.toBeInstanceOf(ConflictException);
    expect(writes).toEqual([]);
  });

  it("a create refusal for a user that cannot be loaded either is a generic 400", async () => {
    const port = fakePort({
      createUser: jest.fn().mockResolvedValue({ kind: "rejected" }),
      loadUser: jest.fn().mockResolvedValue({ kind: "not_found" }),
    });
    const { service } = build({ port });
    await expect(service.acceptInvitation(accept)).rejects.toBeInstanceOf(BadRequestException);
    expect(writes).toEqual([]);
  });

  it("answers 409, creating no session, when the email or the link already exists (unique violation)", async () => {
    const repo = fakeRepo({ user: null });
    repo.insertUser.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    const { service, sessions } = build({ repo });
    await expect(service.acceptInvitation(accept)).rejects.toBeInstanceOf(ConflictException);
    expect(sessions.startSession).not.toHaveBeenCalled();
  });

  it("loses a race (markAccepted false): the transaction fails with the opaque 400 and no session", async () => {
    const repo = fakeRepo({ user: null, markAccepted: false });
    const { service, sessions } = build({ repo });
    await expect(service.acceptInvitation(accept)).rejects.toBeInstanceOf(BadRequestException);
    expect(sessions.startSession).not.toHaveBeenCalled();
  });
});

describe("acceptInvitation — token validity (zero provider calls, zero writes)", () => {
  it.each([
    ["unknown token", null],
    ["used token", invitation({ status: "accepted" })],
    ["revoked token", invitation({ status: "revoked" })],
    ["expired token", invitation({ expiresAt: new Date(Date.now() - 1000) })],
  ])("%s: the same opaque 400", async (_name, row) => {
    const { service, port, sessions } = build({ repo: fakeRepo({ invitation: row as InvitationRow | null }) });

    const error = await service.acceptInvitation(accept).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe("Invalid or expired invitation token");
    expect(port.createUser).not.toHaveBeenCalled();
    expect(port.loadUser).not.toHaveBeenCalled();
    expect(port.passwordSignIn).not.toHaveBeenCalled();
    expect(sessions.startSession).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});

describe("acceptInvitation — EXISTING user", () => {
  it("grants the membership only: no provider call, no session, the password is ignored", async () => {
    const repo = fakeRepo({ user: existingUser() });
    const { service, port, sessions } = build({ repo });

    const result = await service.acceptInvitation(accept);

    expect(result.session).toBeNull();
    expect(result.membership.user.id).toBe(EXISTING_USER_ID);
    expect(port.createUser).not.toHaveBeenCalled();
    expect(port.passwordSignIn).not.toHaveBeenCalled();
    expect(sessions.startSession).not.toHaveBeenCalled();
    expect(repo.insertUser).not.toHaveBeenCalled();
    expect(repo.insertExternalIdentityLink).not.toHaveBeenCalled();
    expect(writes).toEqual(["markAccepted", "createMembership", "insertStoreAccessRows"]);
  });
});

// RT-1028 accept-time check: the stored grant is re-checked against the
// hierarchy with the inviter, as it is today, as the actor.
describe("acceptInvitation — RT-1028 accept-time hierarchy check", () => {
  const OPAQUE = "Invalid or expired invitation token";

  it("A1: NEW user, owner invitation by a (now) tenant_admin → opaque 400 before any provider call or write; one audit row", async () => {
    _roleCodeRows = [{ code: "owner" }];
    const hierarchy = makeFakeHierarchy({ actorRole: "tenant_admin" });
    const repo = fakeRepo({ user: null, invitation: invitation({ storeAccessKind: "all", invitedStoreIds: [] }) });
    const { service, port, sessions } = build({ repo, hierarchy });

    const error = await service.acceptInvitation(accept).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(OPAQUE);
    expect(port.createUser).not.toHaveBeenCalled();
    expect(port.loadUser).not.toHaveBeenCalled();
    expect(sessions.startSession).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(hierarchy.recordRefusal).toHaveBeenCalledTimes(1);
    const [, auditCtx, audit] = hierarchy.recordRefusal.mock.calls[0]!;
    expect(audit).toEqual({
      operation: "invitation.accept",
      reason: "owner_managed_by_owner_only",
      targetMembershipId: null,
      targetInvitationId: INVITATION_ID,
      targetRoleCode: null,
      requestedRoleCode: "owner",
      requestedStoreAccessKind: "all",
    });
    expect(auditCtx).toMatchObject({ userId: null, tenantId: TENANT_ID, isPlatformAdmin: false });
    expect(JSON.stringify(audit)).not.toContain(EMAIL);
  });

  it("A2: the in-transaction check is authoritative and runs first: a refusal there writes no user, no grant, no session, one audit row", async () => {
    const hierarchy = makeFakeHierarchy();
    // Pre-check sees the inviter as owner; by the grant it has been demoted.
    hierarchy.actorFor
      .mockImplementationOnce(async (_c, ctx) => ({ userId: ctx.userId, roleCode: "owner", isPlatformAdmin: false }))
      .mockImplementation(async (_c, ctx) => ({ userId: ctx.userId, roleCode: "store_manager", isPlatformAdmin: false }));
    const { service, repo, port, sessions } = build({ hierarchy });

    const error = await service.acceptInvitation(accept).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(OPAQUE);
    // The race window: the provider identity was created before the demotion
    // was seen (a later acceptance adopts it); nothing local is written.
    expect(port.createUser).toHaveBeenCalledTimes(1);
    expect(repo.insertUser).not.toHaveBeenCalled();
    expect(repo.insertExternalIdentityLink).not.toHaveBeenCalled();
    expect(repo.markAccepted).not.toHaveBeenCalled();
    expect(repo.createMembership).not.toHaveBeenCalled();
    expect(sessions.startSession).not.toHaveBeenCalled();
    expect(hierarchy.recordRefusal).toHaveBeenCalledTimes(1);
    expect(hierarchy.recordRefusal.mock.calls[0]![2].reason).toBe("actor_not_authorized");
    // The inviter's membership is locked before its role is read, in both checks.
    expect(hierarchy.lockActorMembership).toHaveBeenCalledTimes(2);
    expect(hierarchy.lockActorMembership.mock.calls[1]![1]).toMatchObject({
      userId: invitation().invitedByUserId,
      tenantId: TENANT_ID,
    });
  });

  it("A3: EXISTING user, owner invitation with 'specific' access → opaque 400, no write; no account named as the actor", async () => {
    _roleCodeRows = [{ code: "owner" }];
    const hierarchy = makeFakeHierarchy({ actorRole: "owner" });
    const repo = fakeRepo({ user: existingUser() });
    const { service, port } = build({ repo, hierarchy });

    const error = await service.acceptInvitation(accept).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(OPAQUE);
    expect(port.createUser).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(hierarchy.recordRefusal).toHaveBeenCalledTimes(1);
    const [, auditCtx, audit] = hierarchy.recordRefusal.mock.calls[0]!;
    expect(audit.reason).toBe("owner_requires_all_stores");
    expect(auditCtx.userId).toBeNull();
  });

  it("A4: no hierarchy wired → 503 before any provider call (fails closed)", async () => {
    const repo = fakeRepo({ user: null });
    const port = fakePort();
    const tx = jest.fn(
      async (_pool: Pool, _ctx: unknown, work: (c: PoolClient) => Promise<unknown>): Promise<never> =>
        (await work({} as PoolClient)) as never,
    );
    const service = new InvitationsService(
      {} as Pool,
      repo as unknown as InvitationsRepository,
      { enqueueInvitation: jest.fn() } as unknown as EmailJobEnqueuer,
      tx as never,
      port,
      { verify: jest.fn() } as unknown as OperatorTokenVerifier,
      { startSession: jest.fn() },
    );

    await expect(service.acceptInvitation(accept)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(port.createUser).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("A5: a valid invitation still passes both checks (store_manager by an active tenant_admin)", async () => {
    const hierarchy = makeFakeHierarchy({ actorRole: "tenant_admin" });
    const { service, sessions } = build({ hierarchy });

    const result = await service.acceptInvitation(accept);

    expect(result.session).not.toBeNull();
    expect(sessions.startSession).toHaveBeenCalledTimes(1);
    expect(hierarchy.recordRefusal).not.toHaveBeenCalled();
  });
});
