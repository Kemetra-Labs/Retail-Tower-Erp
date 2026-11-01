/**
 * membership-hierarchy.unit.spec.ts — the RT-132 D2 matrix (Jira RT-1028).
 *
 * Pure policy, no I/O: every actor × target × grant cell of the ratified
 * matrix (RT-132 comment 10674), plus D3 (last owner), D4 (self) and D5a
 * (owner is 'all'). The DB side (lock, actor lookup, audit) is covered by the
 * real-Postgres specs.
 */
import {
  MEMBERSHIP_ROLE_RANK,
  invitationRefusal,
  membershipRevokeRefusal,
  membershipUpdateRefusal,
  type MembershipActor,
} from "../../src/memberships/membership-hierarchy";

const ACTOR_ID = "0193c000-0000-7000-8000-00000000a001";
const OTHER_ID = "0193c000-0000-7000-8000-00000000a002";

const ROLES = ["owner", "tenant_admin", "store_manager", "store_staff"] as const;

function actor(roleCode: string | null, isPlatformAdmin = false): MembershipActor {
  return { userId: ACTOR_ID, roleCode, isPlatformAdmin };
}

function target(roleCode: string, userId = OTHER_ID) {
  return { userId, roleCode };
}

describe("MEMBERSHIP_ROLE_RANK (D1)", () => {
  it("orders owner > tenant_admin > store_manager > store_staff", () => {
    const ranks = ROLES.map((r) => MEMBERSHIP_ROLE_RANK[r]!);
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
    expect(MEMBERSHIP_ROLE_RANK["platform_admin"]).toBeUndefined();
  });
});

describe("membershipUpdateRefusal — D2 matrix", () => {
  it.each(ROLES.flatMap((from) => ROLES.map((to) => [from, to] as const)))(
    "owner may change %s → %s",
    (from, to) => {
      expect(membershipUpdateRefusal(actor("owner"), target(from), { roleCode: to, storeAccessKind: "all" }, 2)).toBeNull();
    },
  );

  it.each(["tenant_admin", "store_manager", "store_staff"])("tenant_admin may change %s to a non-owner role", (from) => {
    for (const to of ["tenant_admin", "store_manager", "store_staff"]) {
      expect(membershipUpdateRefusal(actor("tenant_admin"), target(from), { roleCode: to, storeAccessKind: "all" }, 2)).toBeNull();
    }
  });

  it.each(["tenant_admin", "store_manager", "store_staff"])("tenant_admin may not promote %s to owner", (from) => {
    expect(
      membershipUpdateRefusal(actor("tenant_admin"), target(from), { roleCode: "owner", storeAccessKind: "all" }, 2),
    ).toBe("owner_managed_by_owner_only");
  });

  it.each(ROLES)("tenant_admin may not change an owner, even to %s", (to) => {
    expect(
      membershipUpdateRefusal(actor("tenant_admin"), target("owner"), { roleCode: to, storeAccessKind: "all" }, 3),
    ).toBe("owner_managed_by_owner_only");
  });

  it.each(["store_manager", "store_staff", null])("a %s actor manages nothing", (role) => {
    expect(
      membershipUpdateRefusal(actor(role), target("store_staff"), { roleCode: "store_staff", storeAccessKind: "all" }, 2),
    ).toBe("actor_not_authorized");
  });

  it("a platform-admin session bypasses the actor checks (break-glass)", () => {
    expect(
      membershipUpdateRefusal(actor(null, true), target("owner"), { roleCode: "tenant_admin", storeAccessKind: "all" }, 2),
    ).toBeNull();
    expect(
      membershipUpdateRefusal(actor(null, true), target("store_staff", ACTOR_ID), { roleCode: "owner", storeAccessKind: "all" }, 2),
    ).toBeNull();
  });
});

describe("membershipUpdateRefusal — D3, D4, D5a", () => {
  it.each(["owner", "tenant_admin"])("D4: a %s may not change its own membership", (role) => {
    expect(
      membershipUpdateRefusal(actor(role), target(role, ACTOR_ID), { roleCode: role, storeAccessKind: "all" }, 2),
    ).toBe("self_change");
  });

  it("D3: demoting the last active owner is refused", () => {
    expect(
      membershipUpdateRefusal(actor("owner"), target("owner"), { roleCode: "tenant_admin", storeAccessKind: "all" }, 1),
    ).toBe("last_owner");
  });

  it("D3: demoting one of two owners is allowed", () => {
    expect(
      membershipUpdateRefusal(actor("owner"), target("owner"), { roleCode: "tenant_admin", storeAccessKind: "all" }, 2),
    ).toBeNull();
  });

  it("D3 binds a platform admin too", () => {
    expect(
      membershipUpdateRefusal(actor(null, true), target("owner"), { roleCode: "store_staff", storeAccessKind: "all" }, 1),
    ).toBe("last_owner");
  });

  it("D5a: an owner grant with 'specific' access is refused, for every actor", () => {
    for (const a of [actor("owner"), actor(null, true)]) {
      expect(
        membershipUpdateRefusal(a, target("tenant_admin"), { roleCode: "owner", storeAccessKind: "specific" }, 2),
      ).toBe("owner_requires_all_stores");
      expect(
        membershipUpdateRefusal(a, target("owner"), { roleCode: "owner", storeAccessKind: "specific" }, 2),
      ).toBe("owner_requires_all_stores");
    }
  });
});

describe("membershipRevokeRefusal", () => {
  it.each(ROLES)("owner may revoke a %s", (role) => {
    expect(membershipRevokeRefusal(actor("owner"), target(role), 2)).toBeNull();
  });

  it("tenant_admin may revoke a tenant_admin peer and lower roles", () => {
    for (const role of ["tenant_admin", "store_manager", "store_staff"]) {
      expect(membershipRevokeRefusal(actor("tenant_admin"), target(role), 2)).toBeNull();
    }
  });

  it("tenant_admin may not revoke an owner", () => {
    expect(membershipRevokeRefusal(actor("tenant_admin"), target("owner"), 3)).toBe("owner_managed_by_owner_only");
  });

  it("D4: self-revoke is allowed", () => {
    expect(membershipRevokeRefusal(actor("tenant_admin"), target("tenant_admin", ACTOR_ID), 1)).toBeNull();
    expect(membershipRevokeRefusal(actor("owner"), target("owner", ACTOR_ID), 2)).toBeNull();
  });

  it("D3: revoking the last owner is refused, even by that owner or a platform admin", () => {
    expect(membershipRevokeRefusal(actor("owner"), target("owner", ACTOR_ID), 1)).toBe("last_owner");
    expect(membershipRevokeRefusal(actor("owner"), target("owner"), 1)).toBe("last_owner");
    expect(membershipRevokeRefusal(actor(null, true), target("owner"), 1)).toBe("last_owner");
  });

  it("a store_manager actor may not revoke anyone else", () => {
    expect(membershipRevokeRefusal(actor("store_manager"), target("store_staff"), 2)).toBe("actor_not_authorized");
  });
});

describe("invitationRefusal", () => {
  it.each(ROLES)("owner may invite a %s with all stores", (role) => {
    expect(invitationRefusal(actor("owner"), { roleCode: role, storeAccessKind: "all" })).toBeNull();
  });

  it("tenant_admin may invite tenant_admin and lower, but never an owner", () => {
    for (const role of ["tenant_admin", "store_manager", "store_staff"]) {
      expect(invitationRefusal(actor("tenant_admin"), { roleCode: role, storeAccessKind: "specific" })).toBeNull();
    }
    expect(invitationRefusal(actor("tenant_admin"), { roleCode: "owner", storeAccessKind: "all" })).toBe(
      "owner_managed_by_owner_only",
    );
  });

  it("D5a: an owner invitation with 'specific' access is refused", () => {
    expect(invitationRefusal(actor("owner"), { roleCode: "owner", storeAccessKind: "specific" })).toBe(
      "owner_requires_all_stores",
    );
    expect(invitationRefusal(actor(null, true), { roleCode: "owner", storeAccessKind: "specific" })).toBe(
      "owner_requires_all_stores",
    );
  });
});
