/**
 * RT-782 (RT-777 S3, screen 30): pure rules for the tenant directory.
 * `listTenants` returns `TenantSummary` (id, slug, name) only. It carries no
 * `status` and no store counts (OQ-8), so the directory derives neither: the
 * suspended-tenant rule is a static note, and the server decides at open time.
 *
 * The search is client-side over the one list read (no filter on the contract).
 * RT-1468 (owner decisions 2026-11-18): every row offers "Open organization"
 * (`switchActiveTenant`, admitted for a platform admin on any existing tenant,
 * no support session needed). A tenant the caller is NOT a member of also
 * offers "Start support session", which adds a purpose and ticket to the
 * record; a member is never offered one, since `openSupportSession` would
 * answer 409 `already_member` (UX Addendum A3).
 */
import type { components } from "@/generated/schema";

export type TenantSummary = components["schemas"]["TenantSummary"];

export interface DirectoryRow {
  id: string;
  name: string;
  slug?: string;
  /** The caller is a member: "Open organization" only, no support session (409 `already_member`). */
  member: boolean;
}

export function filterTenants(tenants: readonly TenantSummary[], query: string): TenantSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...tenants];
  return tenants.filter(
    (t) => (t.name ?? "").toLowerCase().includes(q) || (t.slug ?? "").toLowerCase().includes(q),
  );
}

export function directoryRows(
  tenants: readonly TenantSummary[],
  memberships: readonly { tenant_id?: string }[],
): DirectoryRow[] {
  const member = new Set(memberships.map((m) => m.tenant_id));
  return tenants.flatMap((t) =>
    t.id
      ? [
          {
            id: t.id,
            name: t.name || t.slug || t.id,
            slug: t.slug,
            member: member.has(t.id),
          },
        ]
      : [],
  );
}
