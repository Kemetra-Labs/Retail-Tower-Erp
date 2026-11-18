/**
 * RT-1462 — `ForceActionAccessGuard` decision matrix (owner decision 2026-11-18, amending RT-1437 D1).
 *
 * No database: `runWithTenantContext` is mocked to hand the work a dummy client, and the membership
 * repository is a stub that answers the caller's role. What it pins:
 *
 *   - a platform admin is ADMITTED whatever the membership role (none, owner, store_manager) and is
 *     recorded as `actor_kind: platform_admin`, on behalf of the session's tenant and support session;
 *   - an owner or tenant_admin with all-store access is admitted as themselves, on behalf of no one;
 *   - a store_manager, a store_staff, a tenant_admin with specific-store access and a caller with no
 *     membership stay the non-disclosing 404;
 *   - the role is read under the TENANT's own context, never a platform-admin one.
 */
jest.mock("@data-pulse-2/db", () => ({
  runWithTenantContext: jest.fn(async (_pool: unknown, _ctx: unknown, work: (client: unknown) => unknown) => work({})),
}));

import "reflect-metadata";

import { NotFoundException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { ForceActionAccessGuard, forceActionActor, type ForceActionRequest } from "../../src/console-force-actions/force-action-access.guard";
import type { MembershipRepository } from "../../src/context/membership.repository";
import type { ResolvedContext } from "../../src/context/types";

const TENANT = "0198a0c4-0000-7000-8000-0000000000a1";
const USER = "0198a0c4-0000-7000-8000-0000000000b1";
const SUPPORT_SESSION = "0198a0c4-0000-7000-8000-0000000000c1";

function guardFor(role: string | null): ForceActionAccessGuard {
  const memberships = { findRoleCodeForUserInTenant: jest.fn(async () => role) } as unknown as MembershipRepository;
  return new ForceActionAccessGuard(memberships, {} as Pool);
}

function ctxOf(overrides: Partial<ResolvedContext>): ResolvedContext {
  return {
    userId: USER,
    tenantId: TENANT,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
    storeAccess: { kind: "all" },
    ...overrides,
  };
}

function exec(request: Partial<ForceActionRequest>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: <T>() => request as unknown as T }) } as unknown as ExecutionContext;
}

async function run(role: string | null, context: ResolvedContext | undefined, method = "POST"): Promise<ForceActionRequest> {
  const request = { method, context } as unknown as ForceActionRequest;
  await expect(guardFor(role).canActivate(exec(request))).resolves.toBe(true);
  return request;
}

describe("ForceActionAccessGuard (RT-1462)", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("a platform admin is admitted", () => {
    it.each([null, "owner", "tenant_admin", "store_manager"])(
      "with membership role %s, as actor_kind platform_admin on behalf of the tenant",
      async (role) => {
        const request = await run(role, ctxOf({ isPlatformAdmin: true }));
        const actor = forceActionActor(request);
        expect(actor).toMatchObject({
          tenantId: TENANT,
          userId: USER,
          kind: "platform_admin",
          role,
          onBehalfOf: { tenant_id: TENANT, support_session_id: null, ticket_ref: null },
        });
      },
    );

    it("a non-member in a support session records the session and its ticket reference", async () => {
      const request = await run(
        null,
        ctxOf({ isPlatformAdmin: true, supportSession: { id: SUPPORT_SESSION, ticketRef: "RT-4242" } }),
      );
      expect(forceActionActor(request).onBehalfOf).toEqual({
        tenant_id: TENANT,
        support_session_id: SUPPORT_SESSION,
        ticket_ref: "RT-4242",
      });
    });

    it.each(["GET", "POST"])("on a %s (the read and the write are both admitted)", async (method) => {
      const request = await run(null, ctxOf({ isPlatformAdmin: true }), method);
      expect(forceActionActor(request).kind).toBe("platform_admin");
    });
  });

  describe("a member is admitted only as owner or tenant_admin with all-store access", () => {
    it.each(["owner", "tenant_admin"] as const)("%s: admitted as themselves, on behalf of no one", async (role) => {
      const request = await run(role, ctxOf({}));
      expect(forceActionActor(request)).toMatchObject({ kind: role, role, onBehalfOf: null });
    });

    it.each(["store_manager", "store_staff", null])("%s: the non-disclosing 404", async (role) => {
      const request = { method: "POST", context: ctxOf({}) } as unknown as ForceActionRequest;
      await expect(guardFor(role).canActivate(exec(request))).rejects.toBeInstanceOf(NotFoundException);
      expect(request.forceActionActor).toBeUndefined();
    });

    it.each(["owner", "tenant_admin"])("%s with specific-store access: the 404", async (role) => {
      const request = {
        method: "POST",
        context: ctxOf({ storeAccess: { kind: "specific", storeIds: ["0198a0c4-0000-7000-8000-0000000000d1"] } }),
      } as unknown as ForceActionRequest;
      await expect(guardFor(role).canActivate(exec(request))).rejects.toBeInstanceOf(NotFoundException);
    });

    it("an owner whose store access is unresolved is the 404, never tenant-wide", async () => {
      const { storeAccess: _unresolved, ...unresolved } = ctxOf({});
      void _unresolved;
      const request = { method: "POST", context: unresolved } as unknown as ForceActionRequest;
      await expect(guardFor("owner").canActivate(exec(request))).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it("no context, or a context with no user or tenant, is 401", async () => {
    for (const context of [undefined, ctxOf({ userId: null }), ctxOf({ tenantId: null })]) {
      const request = { method: "GET", context } as unknown as ForceActionRequest;
      await expect(guardFor("owner").canActivate(exec(request))).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it("reads the caller's role under the TENANT's own context, never a platform-admin one", async () => {
    await run("owner", ctxOf({ isPlatformAdmin: true }));
    expect(runWithTenantContext).toHaveBeenCalledTimes(1);
    expect((runWithTenantContext as jest.Mock).mock.calls[0]?.[1]).toEqual({ tenantId: TENANT, isPlatformAdmin: false });
  });

  it("forceActionActor refuses a request the guard did not admit", () => {
    expect(() => forceActionActor({} as ForceActionRequest)).toThrow(UnauthorizedException);
  });
});
