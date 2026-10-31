import { groupMembers, memberCounts } from "@/operators/memberGroups";
import type { MemberRow } from "@/operators/useMembers";
import { describe, expect, test } from "vitest";

const row = (id: string, roleCode: string, revoked = false): MemberRow => ({
  membershipId: id,
  userId: `u-${id}`,
  email: `${id}@example.test`,
  displayName: null,
  roleCode,
  storeAccessKind: "all",
  accessibleStoreIds: [],
  revoked,
});

/** RT-1014: the role regroup and the counts are pure views of the loaded rows. */
describe("groupMembers", () => {
  test("puts every member in exactly one group, in a fixed role order", () => {
    const rows = [
      row("a", "cashier"),
      row("b", "owner"),
      row("c", "manager"),
      row("d", "tenant_admin"),
      row("e", "platform_admin"),
      row("f", "store_manager"),
    ];
    const groups = groupMembers(rows);
    expect(groups.map((g) => g.key)).toEqual([
      "role.owner",
      "role.platform_admin",
      "role.tenant_admin",
      "role.store_manager",
      "role.manager",
      "role.cashier",
    ]);
    expect(groups.flatMap((g) => g.rows.map((r) => r.membershipId)).sort()).toEqual(
      rows.map((r) => r.membershipId).sort(),
    );
  });

  test("collapses every unrecognised role code into one last unknown group", () => {
    const groups = groupMembers([row("a", "x_one"), row("b", "cashier"), row("c", "x_two")]);
    expect(groups.map((g) => g.key)).toEqual(["role.cashier", "role.unknown"]);
    expect(groups[1]?.rows.map((r) => r.membershipId)).toEqual(["a", "c"]);
  });

  test("keeps the server order inside a group, active members before revoked ones", () => {
    const [group] = groupMembers([
      row("r1", "cashier", true),
      row("a1", "cashier"),
      row("r2", "cashier", true),
      row("a2", "cashier"),
    ]);
    expect(group?.rows.map((r) => r.membershipId)).toEqual(["a1", "a2", "r1", "r2"]);
  });

  test("an empty list has no groups", () => {
    expect(groupMembers([])).toEqual([]);
  });
});

describe("memberCounts", () => {
  test("total is active plus revoked, from the whole list", () => {
    const counts = memberCounts([
      row("a", "cashier"),
      row("b", "cashier", true),
      row("c", "owner"),
    ]);
    expect(counts).toEqual({ total: 3, active: 2, revoked: 1 });
  });
});
