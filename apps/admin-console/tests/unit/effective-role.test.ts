import { isPlatformAdminRole, roleCodeOf, storeAccessOf } from "@/context/effectiveRole";
import { describe, expect, test } from "vitest";

/**
 * RT-1468 (owner decision 2026-11-18): the role the Console gates its UI on. A platform admin with
 * an organization open is gated as an owner, member or not; everyone else keeps their own role.
 */
const tenant = { id: "t1" };
const admin = { is_platform_admin: true };
const plain = { is_platform_admin: false };

describe("roleCodeOf", () => {
  test.each([
    [
      "a member keeps their membership role",
      { user: plain, active_tenant: tenant, active_role_code: "store_manager" },
      "store_manager",
      false,
    ],
    [
      "a non-admin with no role has none",
      { user: plain, active_tenant: tenant, active_role_code: null },
      null,
      false,
    ],
    [
      "a platform admin without a membership is gated as an owner",
      { user: admin, active_tenant: tenant, active_role_code: null },
      "owner",
      true,
    ],
    [
      "a platform admin who is also a store_manager member is still gated as an owner",
      { user: admin, active_tenant: tenant, active_role_code: "store_manager" },
      "owner",
      true,
    ],
    [
      "a platform admin with no organization open has no role",
      { user: admin, active_tenant: null, active_role_code: null },
      null,
      false,
    ],
    [
      "a missing flag is not an admin",
      { user: {}, active_tenant: tenant, active_role_code: null },
      null,
      false,
    ],
  ])("%s", (_case, context, role, adminRule) => {
    expect(roleCodeOf(context)).toBe(role);
    expect(isPlatformAdminRole(context)).toBe(adminRule);
  });

  test("no context, no role", () => {
    expect(roleCodeOf(null)).toBeNull();
    expect(isPlatformAdminRole(undefined)).toBe(false);
  });
});

describe("storeAccessOf", () => {
  test("a platform admin reaches every store whatever the membership; others keep theirs", () => {
    const specific = { store_access_kind: "specific" as const };
    expect(storeAccessOf({ user: admin, active_tenant: tenant }, specific)).toBe("all");
    expect(storeAccessOf({ user: plain, active_tenant: tenant }, specific)).toBe("specific");
    expect(storeAccessOf({ user: plain, active_tenant: tenant }, undefined)).toBeUndefined();
  });
});
