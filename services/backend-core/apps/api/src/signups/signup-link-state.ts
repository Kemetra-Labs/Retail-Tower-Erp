/**
 * The identity-link state of a user at the configured provider (RT-1350 slice 3),
 * read on the AUTH LOOKUP pool: the domain role holds no SELECT on
 * `external_identity_links` (docs/operations/database-roles.md). `disabled` means the
 * user has links to this provider and none is active, so the account was switched off
 * and must get neither a signup link nor a session.
 */
import type { Pool } from "pg";

import type { LinkState } from "./signups.service";

export function linkStateReader(
  lookupPool: Pool,
  providerKey: string | null,
): (userId: string) => Promise<LinkState> {
  return async (userId) => {
    if (providerKey === null) return "none";
    const r = await lookupPool.query<{ total: string; active: string }>(
      `SELECT count(*)::text AS total, count(*) FILTER (WHERE status = 'active')::text AS active
         FROM external_identity_links WHERE user_id = $1 AND provider_key = $2`,
      [userId, providerKey],
    );
    const total = Number(r.rows[0]?.total ?? "0");
    const active = Number(r.rows[0]?.active ?? "0");
    if (total === 0) return "none";
    return active > 0 ? "active" : "disabled";
  };
}
