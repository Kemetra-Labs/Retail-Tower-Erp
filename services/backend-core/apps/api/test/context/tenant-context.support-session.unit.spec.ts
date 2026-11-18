/**
 * RT-1462 — `TenantContextGuard` publishes the support session that admitted a non-member platform
 * admin (`ResolvedContext.supportSession`), so the force actions can record "on behalf of" without
 * opening a second platform-admin database context.
 *
 * No database: `runWithTenantContext` and `runWithSystemPrivilege` are passthroughs and `SupportSessionGate.enforce` is spied. Pins:
 *   - a non-member platform admin: the context carries `{ id, ticketRef }` of the session the gate returned;
 *   - a platform admin who IS a member: the gate is never asked and the key is absent;
 *   - a non-platform-admin member: the key is absent;
 *   - the existing refusals are unchanged (the gate's 403 propagates).
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

function guardWith(opts: { isPlatformAdmin: boolean; member: boolean }): TenantContextGuard {
  const sessions = {
    findActiveById: jest.fn().mockResolvedValue({ id: SESSION_ID, activeTenantId: TENANT_ID, activeStoreId: null }),
  } as unknown as SessionRepository;
  const memberships = {
    isPlatformAdmin: jest.fn().mockResolvedValue(opts.isPlatformAdmin),
    hasLiveMembership: jest.fn().mockResolvedValue(opts.member),
    findActiveMembership: jest.fn().mockResolvedValue({ membershipId: "m1", storeAccessKind: "all" }),
    canAccessStore: jest.fn().mockResolvedValue(true),
  } as unknown as MembershipRepository;
  return new TenantContextGuard(sessions, memberships, {} as Pool);
}

function record(ticketRef: string | null): SupportSessionRecord {
  return { id: SUPPORT_ID, ticketRef, tenantId: TENANT_ID } as unknown as SupportSessionRecord;
}

describe("TenantContextGuard publishes the admitting support session (RT-1462)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("a non-member platform admin: the context carries the session id and ticket reference", async () => {
    const enforce = jest.spyOn(SupportSessionGate.prototype, "enforce").mockResolvedValue(record("RT-4242"));
    const ctx = await guardWith({ isPlatformAdmin: true, member: false }).resolve(principal);
    expect(ctx.supportSession).toEqual({ id: SUPPORT_ID, ticketRef: "RT-4242" });
    expect(enforce).toHaveBeenCalledTimes(1);
  });

  it("a session with no ticket reference publishes ticketRef null", async () => {
    jest.spyOn(SupportSessionGate.prototype, "enforce").mockResolvedValue(record(null));
    const ctx = await guardWith({ isPlatformAdmin: true, member: false }).resolve(principal);
    expect(ctx.supportSession).toEqual({ id: SUPPORT_ID, ticketRef: null });
  });

  it("a platform admin who is a member: no gate call, no supportSession key", async () => {
    const enforce = jest.spyOn(SupportSessionGate.prototype, "enforce");
    const ctx = await guardWith({ isPlatformAdmin: true, member: true }).resolve(principal);
    expect(enforce).not.toHaveBeenCalled();
    expect("supportSession" in ctx).toBe(false);
  });

  it("an ordinary member: no supportSession key", async () => {
    const ctx = await guardWith({ isPlatformAdmin: false, member: true }).resolve(principal);
    expect("supportSession" in ctx).toBe(false);
  });

  describe("a direct route (RT-1462): no support session is needed", () => {
    const direct = { method: "POST", route: "/api/v1/shifts/:shift_id/force-close", requestId: () => null, platformDirect: true };

    it("a non-member platform admin is admitted through admitDirect, never enforce; the live session, if any, is published", async () => {
      const enforce = jest.spyOn(SupportSessionGate.prototype, "enforce");
      const admitDirect = jest.spyOn(SupportSessionGate.prototype, "admitDirect").mockResolvedValue(record("RT-4242"));
      const ctx = await guardWith({ isPlatformAdmin: true, member: false }).resolve(principal, direct);
      expect(ctx.supportSession).toEqual({ id: SUPPORT_ID, ticketRef: "RT-4242" });
      expect(admitDirect).toHaveBeenCalledTimes(1);
      expect(enforce).not.toHaveBeenCalled();
    });

    it("with no live session the context carries none (on_behalf_of then names the tenant only)", async () => {
      jest.spyOn(SupportSessionGate.prototype, "admitDirect").mockResolvedValue(null);
      const ctx = await guardWith({ isPlatformAdmin: true, member: false }).resolve(principal, direct);
      expect(ctx).toMatchObject({ tenantId: TENANT_ID, isPlatformAdmin: true });
      expect("supportSession" in ctx).toBe(false);
    });

    it("a refusal of admitDirect (a suspended tenant's write, a missing tenant) propagates", async () => {
      jest
        .spyOn(SupportSessionGate.prototype, "admitDirect")
        .mockRejectedValue(new ForbiddenException({ code: "support_session_read_only", message: "x" }));
      await expect(guardWith({ isPlatformAdmin: true, member: false }).resolve(principal, direct)).rejects.toMatchObject({
        status: 403,
        response: { code: "support_session_read_only" },
      });
    });

    it("a route that is NOT direct still enforces the support session", async () => {
      const enforce = jest.spyOn(SupportSessionGate.prototype, "enforce").mockResolvedValue(record(null));
      const admitDirect = jest.spyOn(SupportSessionGate.prototype, "admitDirect");
      await guardWith({ isPlatformAdmin: true, member: false }).resolve(principal, { ...direct, platformDirect: false });
      await guardWith({ isPlatformAdmin: true, member: false }).resolve(principal, {
        method: "GET",
        route: "/api/v1/stores",
        requestId: () => null,
      });
      expect(enforce).toHaveBeenCalledTimes(2);
      expect(admitDirect).not.toHaveBeenCalled();
    });
  });

  it("the gate's refusal still propagates (no session, no context)", async () => {
    jest
      .spyOn(SupportSessionGate.prototype, "enforce")
      .mockRejectedValue(new ForbiddenException({ code: "support_session_required", message: "x" }));
    await expect(guardWith({ isPlatformAdmin: true, member: false }).resolve(principal)).rejects.toMatchObject({
      status: 403,
      response: { code: "support_session_required" },
    });
  });
});
