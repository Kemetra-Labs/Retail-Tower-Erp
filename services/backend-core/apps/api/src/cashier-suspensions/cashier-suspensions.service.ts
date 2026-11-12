/**
 * CashierSuspensionsService: RT-1138, the per-store cashier suspension state
 * (`cashier_suspensions`, 0106) and its write API.
 *
 *   - `suspend` / `reactivate`: one transaction in the caller's tenant context
 *     (RLS fences every read and write to that tenant). Each checks the store
 *     is the caller's tenant's and inside the caller's store scope, and that
 *     the target is a cashier of that store (the RT-113 admission predicates,
 *     minus suspension), then writes the state and its audit row together.
 *     A replay and a no-op change nothing and audit nothing.
 *   - `list`: the cashiers currently suspended at one store.
 *
 * Every refusal for a store or cashier the caller may not see is the same 404:
 * another tenant's store, a store outside the caller's scope, a user who is
 * not a cashier of the store. Nothing about existence is disclosed (§II).
 *
 * Audit rows hold ids and an outcome only (§XIV): the actor, the store, the
 * cashier. No name, no reason text.
 */
import { HttpException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { resolveStoreScope } from "../context/store-scope";
import type { ResolvedContext } from "../context/types";
import { CASHIER_ROLE_CODE } from "../pos-cashier-admissions/cashier-eligibility";

const CASHIER_SUSPENDED_ACTION = "cashier.suspended";
const CASHIER_REACTIVATED_ACTION = "cashier.reactivated";
const AUDIT_TARGET = "cashier_suspension";

type SuspensionOutcome = "suspended" | "already_suspended" | "reactivated" | "already_active";

/** `CashierSuspension` on the wire. */
interface CashierSuspensionBody {
  readonly store_id: string;
  readonly user_id: string;
  readonly status: "suspended" | "active";
  readonly changed_at: string | null;
}

/** `CashierSuspensionChange` on the wire. */
export interface CashierSuspensionChangeBody {
  readonly outcome: SuspensionOutcome;
  readonly suspension: CashierSuspensionBody;
}

/** `CashierSuspensionList` on the wire: only the cashiers currently suspended. */
export interface CashierSuspensionListBody {
  readonly store_id: string;
  readonly suspensions: CashierSuspensionBody[];
}

export interface SuspensionActionInput {
  readonly ctx: ResolvedContext;
  readonly storeId: string;
  readonly userId: string;
  readonly requestId: string | null;
}

interface SuspensionRow {
  readonly user_id: string;
  readonly status: "suspended" | "active";
  readonly changed_at: Date;
}

/** Same-tenant store, live and in the caller's scope; else the 404. */
const STORE_SQL = `SELECT 1 FROM stores WHERE id = $2::uuid AND tenant_id = $1::uuid AND deleted_at IS NULL`;

/**
 * The user is a cashier of store `$2`: an active `store_staff` membership of
 * tenant `$1` that reaches the store, and the user is not deleted. Suspension
 * is NOT part of this: a suspended cashier can be reactivated and re-suspended.
 */
const CASHIER_SQL = `
  SELECT 1
    FROM memberships m
    JOIN roles r ON r.id = m.role_id
    JOIN users u ON u.id = m.user_id
   WHERE m.tenant_id = $1::uuid AND m.user_id = $3::uuid
     AND m.revoked_at IS NULL AND m.deleted_at IS NULL
     AND u.deleted_at IS NULL
     AND r.code = '${CASHIER_ROLE_CODE}'
     AND (m.store_access_kind = 'all'
          OR EXISTS (SELECT 1 FROM store_access sa WHERE sa.membership_id = m.id AND sa.store_id = $2::uuid))
   LIMIT 1`;

/** Create the row as suspended, or flip an active row; a row already suspended is left alone (no row returned). */
const SUSPEND_SQL = `
  INSERT INTO cashier_suspensions (tenant_id, store_id, user_id, status, changed_by_user_id)
  VALUES ($1::uuid, $2::uuid, $3::uuid, 'suspended', $4::uuid)
  ON CONFLICT (tenant_id, store_id, user_id) DO UPDATE
     SET status = 'suspended', changed_at = now(), changed_by_user_id = EXCLUDED.changed_by_user_id
   WHERE cashier_suspensions.status <> 'suspended'
  RETURNING user_id, status, changed_at`;

const REACTIVATE_SQL = `
  UPDATE cashier_suspensions
     SET status = 'active', changed_at = now(), changed_by_user_id = $4::uuid
   WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND user_id = $3::uuid AND status = 'suspended'
  RETURNING user_id, status, changed_at`;

const READ_ONE_SQL = `
  SELECT user_id, status, changed_at FROM cashier_suspensions
   WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND user_id = $3::uuid`;

const LIST_SQL = `
  SELECT user_id, status, changed_at FROM cashier_suspensions
   WHERE tenant_id = $1::uuid AND store_id = $2::uuid AND status = 'suspended'
   ORDER BY changed_at DESC, user_id`;

/** One of the two writes: its SQL, the outcomes with and without a change, and its audit action. */
interface ChangeKind {
  readonly sql: string;
  readonly changed: SuspensionOutcome;
  readonly unchanged: SuspensionOutcome;
  readonly audit: string;
}

const SUSPEND: ChangeKind = {
  sql: SUSPEND_SQL,
  changed: "suspended",
  unchanged: "already_suspended",
  audit: CASHIER_SUSPENDED_ACTION,
};

const REACTIVATE: ChangeKind = {
  sql: REACTIVATE_SQL,
  changed: "reactivated",
  unchanged: "already_active",
  audit: CASHIER_REACTIVATED_ACTION,
};

function bodyOf(storeId: string, userId: string, row: SuspensionRow | undefined): CashierSuspensionBody {
  return {
    store_id: storeId,
    user_id: userId,
    status: row?.status ?? "active",
    changed_at: row?.changed_at.toISOString() ?? null,
  };
}

/** The caller's tenant as a string, or the 404 (a platform admin with no active tenant has no cashiers here). */
function tenantOf(ctx: ResolvedContext): string {
  if (ctx.tenantId === null) throw notFound();
  return ctx.tenantId;
}

function notFound(): HttpException {
  return new NotFoundException({ code: "not_found", message: "Not Found" });
}

function inScope(ctx: ResolvedContext, storeId: string): boolean {
  const scope = resolveStoreScope(ctx);
  return scope.kind === "tenant" || scope.storeIds.some((id) => id.toLowerCase() === storeId.toLowerCase());
}

@Injectable()
export class CashierSuspensionsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async suspend(input: SuspensionActionInput): Promise<CashierSuspensionChangeBody> {
    return await this.change(input, SUSPEND);
  }

  async reactivate(input: SuspensionActionInput): Promise<CashierSuspensionChangeBody> {
    return await this.change(input, REACTIVATE);
  }

  async list(ctx: ResolvedContext, storeId: string): Promise<CashierSuspensionListBody> {
    const tenantId = tenantOf(ctx);
    return await runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      await this.requireStore(client, ctx, tenantId, storeId);
      const r = await client.query<SuspensionRow>(LIST_SQL, [tenantId, storeId]);
      return {
        store_id: storeId,
        suspensions: r.rows.map((row) => bodyOf(storeId, row.user_id, row)),
      };
    });
  }

  /** The shared shell: tenant context, store and cashier checks, the write, then its audit row. */
  private async change(input: SuspensionActionInput, kind: ChangeKind): Promise<CashierSuspensionChangeBody> {
    const tenantId = tenantOf(input.ctx);
    const actorUserId = input.ctx.userId;
    if (actorUserId === null) throw notFound();
    return await runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      await this.requireStore(client, input.ctx, tenantId, input.storeId);
      const cashier = await client.query(CASHIER_SQL, [tenantId, input.storeId, input.userId]);
      if (cashier.rowCount === 0) throw notFound();
      const written = await client.query<SuspensionRow>(kind.sql, [tenantId, input.storeId, input.userId, actorUserId]);
      const changed = written.rows[0];
      if (changed !== undefined) {
        await insertAudit(client, { tenantId, actorUserId, input, action: kind.audit });
        return { outcome: kind.changed, suspension: bodyOf(input.storeId, input.userId, changed) };
      }
      // Nothing to change (a replay): report the stored row, change and audit nothing.
      const stored = await client.query<SuspensionRow>(READ_ONE_SQL, [tenantId, input.storeId, input.userId]);
      return { outcome: kind.unchanged, suspension: bodyOf(input.storeId, input.userId, stored.rows[0]) };
    });
  }

  private async requireStore(client: PoolClient, ctx: ResolvedContext, tenantId: string, storeId: string): Promise<void> {
    if (!inScope(ctx, storeId)) throw notFound();
    const store = await client.query(STORE_SQL, [tenantId, storeId]);
    if (store.rowCount === 0) throw notFound();
  }
}

async function insertAudit(
  client: PoolClient,
  e: { tenantId: string; actorUserId: string; input: SuspensionActionInput; action: string },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, '{}'::jsonb)`,
    [newId(), e.actorUserId, e.tenantId, e.input.storeId, e.action, AUDIT_TARGET, e.input.userId, e.input.requestId],
  );
}
