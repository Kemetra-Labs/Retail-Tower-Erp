/**
 * ConsolePeopleService — RT-1063: the console people-name read
 * (`console-people.openapi.yaml`, decision record RT-968). Read only.
 *
 * DATA ACCESS — one parameterized query under `runWithTenantContext`, so the
 * `memberships` and `store_access` RLS policies apply, plus an explicit
 * `tenant_id` predicate on both. `users` has no RLS: a user row is reached
 * only through a membership of the session tenant.
 *
 * Who resolves (RT-968 D-2 / D-3):
 *   - A *person of the tenant* has a `memberships` row of the session tenant
 *     with `deleted_at` null, revoked or not. A soft-deleted membership row
 *     does not count.
 *   - `owner` / `tenant_admin`: every person of the tenant, whatever their
 *     own store grant.
 *   - Every other admitted caller (`store_manager`): only a person whose
 *     membership grants a store of the caller's operator-surface store scope
 *     (`callerStoreScope`, active-store narrowing included): `all`, or a
 *     `specific` membership with a `store_access` row for a scoped store. A
 *     tenant-wide scope resolves every person; an empty scope resolves none.
 *
 * What a resolved person returns: `user_id` and `display_name` only. The
 * name of a soft-deleted user is never read; a null or blank name is null.
 * Every other id is absent, and absence never says why (FR-ISO-4).
 *
 * Indexes (no migration): the membership probe is served by
 * `memberships_tenant_user_active_uidx (tenant_id, user_id) WHERE deleted_at
 * IS NULL`, the grant probe by the `store_access` primary key
 * `(membership_id, store_id)`, the user rows by `users` primary key.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { MembershipRepository } from "../context/membership.repository";
import { callerStoreScope, scopeStoreIds } from "../context/operator-store-scope";
import type { ResolvedContext } from "../context/types";

/** Roles that resolve every person of the tenant (D-2). */
const TENANT_WIDE_ROLES: ReadonlySet<string> = new Set(["owner", "tenant_admin"]);

export interface PersonName {
  readonly user_id: string;
  readonly display_name: string | null;
}

export interface PeopleNames {
  readonly items: PersonName[];
}

export interface ListPeopleNamesInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
  /** Distinct, lower-cased, at most 200. */
  readonly ids: readonly string[];
}

/**
 * $1 tenant, $2 requested ids, $3 the caller's scoped store ids (null = no
 * store filter; empty = no store, so nobody resolves, not even an `all`
 * member). The name of a soft-deleted user is not selected.
 */
const PEOPLE_NAMES_SQL = `
  SELECT u.id::text AS user_id,
         CASE WHEN u.deleted_at IS NULL THEN u.display_name END AS display_name
    FROM users u
   WHERE u.id = ANY($2::uuid[])
     AND EXISTS (
       SELECT 1 FROM memberships m
        WHERE m.tenant_id = $1::uuid
          AND m.user_id = u.id
          AND m.deleted_at IS NULL
          AND (
            $3::uuid[] IS NULL
            OR (cardinality($3::uuid[]) > 0 AND m.store_access_kind = 'all')
            OR EXISTS (
              SELECT 1 FROM store_access sa
               WHERE sa.tenant_id = $1::uuid
                 AND sa.membership_id = m.id
                 AND sa.store_id = ANY($3::uuid[])
            )
          )
     )
   ORDER BY u.id`;

interface RawRow {
  readonly user_id: string;
  readonly display_name: string | null;
}

/** `users.display_name` trimmed; null when null or blank. Never a substitute. */
export function displayNameOf(raw: string | null): string | null {
  const trimmed = raw?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** The rows as the contract's items, by `user_id` ascending. */
export function projectPeopleNames(rows: readonly RawRow[]): PeopleNames {
  const items = rows
    .map((r) => ({ user_id: r.user_id.toLowerCase(), display_name: displayNameOf(r.display_name) }))
    .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
  return { items };
}

@Injectable()
export class ConsolePeopleService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /** The resolvable ids among `input.ids`; the caller's role and scope are read on every request. */
  async listNames(input: ListPeopleNamesInput): Promise<PeopleNames> {
    return await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const userId = input.context.userId;
        const roleCode =
          userId !== null
            ? await this.memberships.findRoleCodeForUserInTenant(userId, input.tenantId, client)
            : null;
        const storeIds =
          roleCode !== null && TENANT_WIDE_ROLES.has(roleCode)
            ? null
            : scopeStoreIds(await callerStoreScope(client, this.memberships, input));
        const r = await client.query<RawRow>(PEOPLE_NAMES_SQL, [input.tenantId, input.ids, storeIds]);
        return projectPeopleNames(r.rows);
      },
    );
  }
}
