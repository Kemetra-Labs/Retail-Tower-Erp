/**
 * RT-1468 — `TenantContextGuard` admits every platform admin in the active tenant (member or not, with or
 * without a support session) through `SupportSessionGate.admit`, and publishes the live support session it
 * returns (`ResolvedContext.supportSession`), so the force actions record "on behalf of" without opening a
 * second platform-admin database context.
 *
 * No database: `runWithTenantContext` and `runWithSystemPrivilege` are passthroughs and
 * `SupportSessionGate.admit` is spied. Pins:
 *   - a platform admin, member or not: exactly one `admit` call (one cross-tenant row), the live session's
 *     `{ id, ticketRef }` published, no key when there is none;
 *   - no membership lookup decides a platform admin's admission any more;
 *   - a non-platform-admin member: the gate is never asked and the key is absent;
 *   - a refusal of the gate (a tenant that no longer exists) propagates.
 */
jest.mock("@data-pulse-2/db", () => ({
  ...jest.requireActual("@data-pulse-2/db"),
  runWithTenantContext: jest.fn(async (_pool: unknown, _ctx: unknown, work: (client: unknown) => unknown) => work({})),
  runWithSystemPrivilege: jest.fn(async (_pool: unknown, _ctx: unknown, work: (client: unknown) => unknown) => work({})),
}));

import "reflect-metadata";

import { ForbiddenException } from "@nestjs/common";
import type { Pool } from "pg";

import type { Principal } from "../../src/auth/auth.guard";
import type { SessionRepository } from "../../src/auth/session.repository";
import type { MembershipRepository } from "../../src/context/membership.repository";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import { SupportSessionGate } from "../../src/platform-support-sessions/support-session.gate";
import type { SupportSessionRecord } from "../../src/platform-support-sessions/support-session.store";

const SESSION_ID = "0a000000-0000-7000-8000-0000000ses01";
const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const TENANT_ID = "0a000000-0000-7000-8000-0000000ten01";
const SUPPORT_ID = "0a000000-0000-7000-8000-0000000sup01";

const principal: Extract<Principal, { kind: "session" }> = {
  kind: "session",
  sessionId: SESSION_ID,
  userId: USER_ID,
} as Extract<Principal, { kind: "session" }>;

function setup(opts: { isPlatformAdmin: boolean; member: boolean }): {
  guard: TenantContextGuard;
  memberships: { hasLiveMembership: jest.Mock };
} {
  const sessions = {
    findActiveById: jest.fn().mockResolvedValue({ id: SESSION_ID, activeTenantId: TENANT_ID, activeStoreId: null }),
  } as unknown as SessionRepository;
  const memberships = {
    isPlatformAdmin: jest.fn().mockResolvedValue(opts.isPlatformAdmin),
    hasLiveMembership: jest.fn().mockResolvedValue(opts.member),
    findActiveMembership: jest.fn().mockResolvedValue({ membershipId: "m1", storeAccessKind: "all" }),
    canAccessStore: jest.fn().mockResolvedValue(true),
  };
  return {
    guard: new TenantContextGuard(sessions, memberships as unknown as MembershipRepository, {} as Pool),
    memberships,
  };
}

function record(ticketRef: string | null): SupportSessionRecord {
  return { id: SUPPORT_ID, ticketRef, tenantId: TENANT_ID } as unknown as SupportSessionRecord;
}

const ACCESS = { method: "POST", route: "/api/v1/stores", requestId: () => "rid-1" };

describe("TenantContextGuard admits every platform admin through SupportSessionGate.admit (RT-1468)", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ["not a member", false],
    ["a member", true],
  ])("a platform admin who is %s: one admit call, the live session published", async (_label, member) => {
    const admit = jest.spyOn(SupportSessionGate.prototype, "admit").mockResolvedValue(record("RT-4242"));
    const { guard, memberships } = setup({ isPlatformAdmin: true, member });
    const ctx = await guard.resolve(principal, ACCESS);
    expect(ctx).toMatchObject({ tenantId: TENANT_ID, isPlatformAdmin: true });
    expect(ctx.supportSession).toEqual({ id: SUPPORT_ID, ticketRef: "RT-4242" });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledWith(TENANT_ID, {
      authSessionId: SESSION_ID,
      userId: USER_ID,
      method: "POST",
      route: "/api/v1/stores",
      requestId: "rid-1",
    });
    // Membership no longer decides a platform admin's admission.
    expect(memberships.hasLiveMembership).not.toHaveBeenCalled();
  });

  it("a session with no ticket reference publishes ticketRef null", async () => {
    jest.spyOn(SupportSessionGate.prototype, "admit").mockResolvedValue(record(null));
    const ctx = await setup({ isPlatformAdmin: true, member: false }).guard.resolve(principal, ACCESS);
    expect(ctx.supportSession).toEqual({ id: SUPPORT_ID, ticketRef: null });
  });

  it("no live session: admitted, and the context carries no supportSession key", async () => {
    jest.spyOn(SupportSessionGate.prototype, "admit").mockResolvedValue(null);
    const ctx = await setup({ isPlatformAdmin: true, member: false }).guard.resolve(principal, ACCESS);
    expect(ctx).toMatchObject({ tenantId: TENANT_ID, isPlatformAdmin: true });
    expect("supportSession" in ctx).toBe(false);
  });

  it("an ordinary member: the gate is never asked and no supportSession key", async () => {
    const admit = jest.spyOn(SupportSessionGate.prototype, "admit");
    const ctx = await setup({ isPlatformAdmin: false, member: true }).guard.resolve(principal, ACCESS);
    expect(admit).not.toHaveBeenCalled();
    expect("supportSession" in ctx).toBe(false);
  });

  it("the gate's refusal (a tenant that no longer exists) propagates", async () => {
    jest
      .spyOn(SupportSessionGate.prototype, "admit")
      .mockRejectedValue(new ForbiddenException({ code: "support_session_required", message: "x" }));
    await expect(setup({ isPlatformAdmin: true, member: false }).guard.resolve(principal, ACCESS)).rejects.toMatchObject({
      status: 403,
      response: { code: "support_session_required" },
    });
  });

  it("without a pool a platform admin fails closed (no request runs unrecorded)", async () => {
    const sessions = {
      findActiveById: jest.fn().mockResolvedValue({ id: SESSION_ID, activeTenantId: TENANT_ID, activeStoreId: null }),
    } as unknown as SessionRepository;
    const memberships = {
      isPlatformAdmin: jest.fn().mockResolvedValue(true),
      hasLiveMembership: jest.fn().mockResolvedValue(true),
    } as unknown as MembershipRepository;
    await expect(new TenantContextGuard(sessions, memberships).resolve(principal, ACCESS)).rejects.toMatchObject({
      status: 403,
      response: { code: "support_session_required" },
    });
  });
});
