/**
 * RT-1462 — the store-deletion owner gate with the platform-admin amendment (RT-1437 D1).
 *
 * No database: `runWithTenantContext` is mocked and the membership repository is a stub. Pins:
 *   - a platform admin is admitted on the deletion routes and on the re-authentication route, member
 *     or not, whatever role they hold, and published as `actor_kind: platform_admin`;
 *   - an owner is admitted as `owner`; a `tenant_admin` is 403 `store_deletion_owner_only` on the
 *     deletion routes and admitted (to be refused later, after the store check) on the re-auth route;
 *   - every other role, and no membership, is the non-disclosing 404.
 */
// The guard's import graph reaches the real db package (status tables), so only the one function is replaced.
jest.mock("@data-pulse-2/db", () => ({
  ...jest.requireActual("@data-pulse-2/db"),
  runWithTenantContext: jest.fn(async (_pool: unknown, _ctx: unknown, work: (client: unknown) => unknown) => work({})),
}));

import "reflect-metadata";

import { ForbiddenException, NotFoundException, type ExecutionContext } from "@nestjs/common";
import type { Pool } from "pg";

import type { MembershipRepository } from "../../src/context/membership.repository";
import type { ResolvedContext } from "../../src/context/types";
import {
  ReauthRoleGuard,
  StoreDeletionOwnerGuard,
  type StoreDeletionRequestWithRole,
} from "../../src/stores/deletion/store-deletion-owner.guard";

const TENANT = "0198a0c4-0000-7000-8000-0000000000a1";
const USER = "0198a0c4-0000-7000-8000-0000000000b1";
const SUPPORT_SESSION = "0198a0c4-0000-7000-8000-0000000000c1";

function guards(role: string | null): { deletion: StoreDeletionOwnerGuard; reauth: ReauthRoleGuard } {
  const memberships = { findRoleCodeForUserInTenant: jest.fn(async () => role) } as unknown as MembershipRepository;
  const pool = {} as Pool;
  return { deletion: new StoreDeletionOwnerGuard(memberships, pool), reauth: new ReauthRoleGuard(memberships, pool) };
}

function request(overrides: Partial<ResolvedContext>): StoreDeletionRequestWithRole {
  const context: ResolvedContext = {
    userId: USER,
    tenantId: TENANT,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
    storeAccess: { kind: "all" },
    ...overrides,
  };
  return { method: "POST", context } as unknown as StoreDeletionRequestWithRole;
}

function exec(req: StoreDeletionRequestWithRole): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: <T>() => req as unknown as T }) } as unknown as ExecutionContext;
}

describe("StoreDeletionOwnerGuard and ReauthRoleGuard (RT-1462)", () => {
  describe.each([
    ["deletion routes", (g: ReturnType<typeof guards>) => g.deletion],
    ["re-authentication route", (g: ReturnType<typeof guards>) => g.reauth],
  ] as const)("%s", (_name, pick) => {
    it.each([null, "owner", "tenant_admin", "store_manager"])(
      "admits a platform admin with membership role %s, as actor_kind platform_admin",
      async (role) => {
        const req = request({ isPlatformAdmin: true });
        await expect(pick(guards(role)).canActivate(exec(req))).resolves.toBe(true);
        expect(req.storeDeletionActor).toMatchObject({
          kind: "platform_admin",
          role,
          onBehalfOf: { tenant_id: TENANT, support_session_id: null, ticket_ref: null },
        });
      },
    );

    it("records the support session and ticket reference of a non-member platform admin", async () => {
      const req = request({ isPlatformAdmin: true, supportSession: { id: SUPPORT_SESSION, ticketRef: "RT-4242" } });
      await expect(pick(guards(null)).canActivate(exec(req))).resolves.toBe(true);
      expect(req.storeDeletionActor?.onBehalfOf).toEqual({
        tenant_id: TENANT,
        support_session_id: SUPPORT_SESSION,
        ticket_ref: "RT-4242",
      });
    });

    it("admits an owner as owner, on behalf of no one", async () => {
      const req = request({});
      await expect(pick(guards("owner")).canActivate(exec(req))).resolves.toBe(true);
      expect(req.storeDeletionActor).toEqual({ kind: "owner", role: "owner", onBehalfOf: null });
    });

    it.each(["store_manager", "store_staff", null])("%s is the non-disclosing 404", async (role) => {
      const req = request({});
      await expect(pick(guards(role)).canActivate(exec(req))).rejects.toBeInstanceOf(NotFoundException);
      expect(req.storeDeletionActor).toBeUndefined();
    });
  });

  it("a tenant_admin is 403 store_deletion_owner_only on the deletion routes", async () => {
    const req = request({});
    const err: unknown = await guards("tenant_admin").deletion.canActivate(exec(req)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: "store_deletion_owner_only" });
  });

  it("a tenant_admin is admitted on the re-auth route as tenant_admin (the service refuses it after the store check)", async () => {
    const req = request({});
    await expect(guards("tenant_admin").reauth.canActivate(exec(req))).resolves.toBe(true);
    expect(req.storeDeletionActor).toEqual({ kind: "tenant_admin", role: "tenant_admin", onBehalfOf: null });
  });
});
