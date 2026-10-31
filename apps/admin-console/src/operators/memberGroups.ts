/**
 * RT-1014 (v4.0 Users): the member list regrouped by role, and the counts of
 * the whole list. Both are pure client-side views of the rows `listMembers`
 * already returned (the read is unpaged: an array with no paging parameters), so
 * no new read or contract is involved.
 */
import { type MessageKey, roleKey } from "@/i18n";
import type { MemberRow } from "./useMembers";

export interface MemberGroup {
  /** The role label's message key: the group's title and its identity. */
  key: MessageKey;
  rows: MemberRow[];
}

export interface MemberCounts {
  total: number;
  active: number;
  revoked: number;
}

/**
 * The fixed order of the groups, widest authority first. A role code the console
 * does not know maps to `role.unknown` and falls into the last group, so a raw
 * code never reaches the copy (UX-12).
 */
const GROUP_ORDER: readonly MessageKey[] = [
  "role.owner",
  "role.platform_admin",
  "role.tenant_admin",
  "role.store_manager",
  "role.manager",
  "role.cashier",
  "role.unknown",
];

/** Every member is in exactly one group; the server's order holds inside it. */
export function groupMembers(rows: readonly MemberRow[]): MemberGroup[] {
  const byRole = new Map<MessageKey, MemberRow[]>();
  for (const row of rows) {
    const key = roleKey(row.roleCode);
    const group = byRole.get(key);
    if (group) group.push(row);
    else byRole.set(key, [row]);
  }
  const rank = (key: MessageKey): number => {
    const at = GROUP_ORDER.indexOf(key);
    return at === -1 ? GROUP_ORDER.length : at;
  };
  return [...byRole.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([key, members]) => ({
      key,
      // Active memberships first, then revoked ones, each in the server's order.
      rows: [...members.filter((m) => !m.revoked), ...members.filter((m) => m.revoked)],
    }));
}

export function memberCounts(rows: readonly MemberRow[]): MemberCounts {
  const revoked = rows.filter((m) => m.revoked).length;
  return { total: rows.length, active: rows.length - revoked, revoked };
}
