/**
 * RT-1470 — the effective role a service decides with (`src/context/effective-role.ts`).
 * A session platform admin is an owner, member or not; a bearer token never is, whatever its user
 * (RT-132 D6); everyone else keeps their membership role. `callerStoreScope` uses it, so a session
 * platform admin is tenant-wide on every operator surface.
 */
import type { PoolClient } from "pg";

import {
  PLATFORM_ADMIN_EFFECTIVE_ROLE,
  effectiveRoleCode,
  findCallerRoleCode,
  isSessionPlatformAdmin,
} from "../../src/context/effective-role";
import { callerStoreScope } from "../../src/context/operator-store-scope";
import type { MembershipRepository } from "../../src/context/membership.repository";
import type { ResolvedContext } from "../../src/context/types";

const TENANT = "0a000000-0000-7000-8000-000014700001";
const STORE = "0a000000-0000-7000-8000-000014700002";
const USER = "0a000000-0000-7000-8000-000014700003";
const client = {} as PoolClient;

function context(over: Partial<ResolvedContext> = {}): ResolvedContext {
  return {
    userId: USER,
    tenantId: TENANT,
    storeId: null,
    isPlatformAdmin: false,
    source: "session",
    storeAccess: { kind: "all" },
    ...over,
  } as ResolvedContext;
}

function repo(role: string | null): Pick<MembershipRepository, "findRoleCodeForUserInTenant"> & { calls: number } {
  const r = {
    calls: 0,
    findRoleCodeForUserInTenant: async () => {
      r.calls += 1;
      return role;
    },
  };
  return r;
}

describe("isSessionPlatformAdmin", () => {
  it.each([
    ["a session platform admin", context({ isPlatformAdmin: true }), true],
    ["a session member", context(), false],
    ["a token, even flagged", context({ isPlatformAdmin: true, source: "token" }), false],
    ["no context", undefined, false],
  ])("%s", (_case, ctx, expected) => {
    expect(isSessionPlatformAdmin(ctx)).toBe(expected);
  });
});

describe("effectiveRoleCode", () => {
  it("a session platform admin is an owner whatever the membership role", () => {
    expect(effectiveRoleCode(context({ isPlatformAdmin: true }), null)).toBe(PLATFORM_ADMIN_EFFECTIVE_ROLE);
    expect(effectiveRoleCode(context({ isPlatformAdmin: true }), "store_manager")).toBe("owner");
  });

  it("anyone else keeps the membership role, a token included", () => {
    expect(effectiveRoleCode(context(), "store_manager")).toBe("store_manager");
    expect(effectiveRoleCode(context(), null)).toBeNull();
    expect(effectiveRoleCode(context({ isPlatformAdmin: true, source: "token" }), "store_manager")).toBe("store_manager");
  });
});

describe("findCallerRoleCode", () => {
  it("a session platform admin is an owner without a membership read", async () => {
    const r = repo(null);
    await expect(findCallerRoleCode(r, client, { tenantId: TENANT, context: context({ isPlatformAdmin: true }) })).resolves.toBe("owner");
    expect(r.calls).toBe(0);
  });

  it("a member gets the membership role; a userless context gets null with no read", async () => {
    const r = repo("store_manager");
    await expect(findCallerRoleCode(r, client, { tenantId: TENANT, context: context() })).resolves.toBe("store_manager");
    const none = repo("owner");
    await expect(findCallerRoleCode(none, client, { tenantId: TENANT, context: context({ userId: null }) })).resolves.toBeNull();
    expect(none.calls).toBe(0);
  });
});

describe("callerStoreScope", () => {
  it("a session platform admin is tenant-wide even with an active store", async () => {
    const scope = await callerStoreScope(client, repo(null) as unknown as MembershipRepository, {
      tenantId: TENANT,
      context: context({ isPlatformAdmin: true, storeId: STORE }),
    });
    expect(scope.kind).toBe("tenant");
  });

  it("a store_manager stays narrowed to the active store (unchanged)", async () => {
    const scope = await callerStoreScope(client, repo("store_manager") as unknown as MembershipRepository, {
      tenantId: TENANT,
      context: context({ storeId: STORE }),
    });
    expect(scope).toEqual({ kind: "stores", storeIds: [STORE] });
  });
});
