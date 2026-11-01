/**
 * MembershipsService — slice US4 (T173/T174).
 *
 * Active-tenant context (NOT path-as-context)
 * -------------------------------------------
 * Tenant id comes from `ResolvedContext.tenantId`, populated by
 * `TenantContextGuard` before this service is reached. The service
 * never reads the membership's `tenant_id` from the URL path.
 *
 * Authorization layering
 * ----------------------
 *   - Authentication: `AuthGuard` (controller class-level).
 *   - Active tenant: `TenantContextGuard` (controller class-level) —
 *     missing active tenant → 401 before this service runs.
 *   - Role gating: `RolesGuard` + `@Roles("owner","tenant_admin",{denyAs:403})`
 *     on DELETE and PATCH methods. Insufficient role → 403 before this runs.
 *
 * Error contract
 * --------------
 *   - 401 (no active tenant)     → TenantContextGuard
 *   - 403 (insufficient role)    → RolesGuard (denyAs: 403)
 *   - 404 (not found / already revoked / cross-tenant) → this service
 *   - 400 (invalid role_code / invalid store_ids / logic conflict) → this service
 *   - 403 (role hierarchy, RT-1028)  → this service, via `MembershipHierarchy`
 *
 * Role hierarchy (RT-1028, RT-132 D1–D5a)
 * ---------------------------------------
 * Both mutations lock the tenant's active owner rows first, then read the
 * target, then validate (404, then 400), then apply the hierarchy (403). A
 * refusal rolls the transaction back and is audited in a fresh one.
 */
import { BadRequestException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import {
  runWithTenantContext,
  type TenantContext,
} from "@data-pulse-2/db";
import { PG_POOL } from "../auth/auth.module";
import type { ResolvedContext } from "../context/types";
import type { MembershipDetail } from "../context/membership.repository";
import type { MembershipUpdateDto } from "./dto";
import {
  MembershipChangeRefusedError,
  MembershipHierarchy,
  membershipRevokeRefusal,
  membershipUpdateRefusal,
} from "./membership-hierarchy";
import { MembershipsRepository } from "./memberships.repository";

type TenantTxRunner = <T>(
  pool: Pool,
  ctx: TenantContext,
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;

function txCtx(ctx: ResolvedContext): TenantContext {
  return {
    tenantId: ctx.tenantId,
    isPlatformAdmin: ctx.isPlatformAdmin,
  };
}

const PLATFORM_ADMIN_CODE = "platform_admin";

@Injectable()
export class MembershipsService {
  private readonly tx: TenantTxRunner;

  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
    private readonly memberships: MembershipsRepository,
    private readonly hierarchy: MembershipHierarchy,
    @Optional() tx?: TenantTxRunner,
  ) {
    this.tx = tx ?? runWithTenantContext;
  }

  /**
   * `DELETE /api/v1/memberships/:membership_id`.
   *
   * Returns `void` on success; throws `NotFoundException` (→ 404) when the
   * membership is not found, belongs to a different tenant, is already revoked,
   * or is soft-deleted; `MembershipChangeRefusedError` (→ 403) on a hierarchy
   * refusal (RT-1028).
   */
  async revoke(ctx: ResolvedContext, membershipId: string): Promise<void> {
    await this.refusalAudited(ctx, async (client) => {
      const tenantId = ctx.tenantId as string;
      const activeOwners = await this.hierarchy.lockActiveOwnerCount(client, tenantId);
      const existing = await this.memberships.findActive(client, membershipId, tenantId);
      if (!existing) throw new NotFoundException("Not Found");

      const actor = await this.hierarchy.actorFor(client, ctx);
      const reason = membershipRevokeRefusal(actor, existing, activeOwners);
      if (reason) {
        throw new MembershipChangeRefusedError({
          operation: "membership.revoke",
          reason,
          targetMembershipId: existing.id,
          targetRoleCode: existing.roleCode,
          requestedRoleCode: null,
          requestedStoreAccessKind: null,
        });
      }

      const updated = await this.memberships.revoke(client, membershipId, tenantId);
      if (!updated) throw new NotFoundException("Not Found");
    });
  }

  /**
   * `PATCH /api/v1/memberships/:membership_id`.
   *
   * Validates the requested changes, then applies them atomically within a
   * single `runWithTenantContext` transaction:
   *   0. Lock the tenant's active owner rows (RT-1028 last-owner rule).
   *   1. Load existing membership (404 if not found/revoked/cross-tenant).
   *   2. If `role_code` provided: look up role_id in tenant; reject
   *      `platform_admin`; unknown code → 400.
   *   3. Resolve effective kind (`body.store_access_kind ?? existing.storeAccessKind`).
   *   4. Validate `store_ids`: required + non-empty for "specific"; must all
   *      belong to active tenant.
   *   5. If `store_ids` provided without `store_access_kind`: only valid when
   *      existing kind is already "specific" (otherwise 400 — ambiguous intent).
   *   5b. Role hierarchy on the post-change grant (403, RT-1028).
   *   6. Apply UPDATE memberships + DELETE/INSERT store_access.
   *   7. Return the updated `MembershipDetail`.
   */
  async update(ctx: ResolvedContext, membershipId: string, dto: MembershipUpdateDto): Promise<MembershipDetail> {
    return await this.refusalAudited(ctx, async (client) => {
      const tenantId = ctx.tenantId as string;

      // Step 0: owner-set lock, before the target is read
      const activeOwners = await this.hierarchy.lockActiveOwnerCount(client, tenantId);

      // Step 1: load existing row (404 gate)
      const existing = await this.memberships.findActive(client, membershipId, tenantId);
      if (!existing) throw new NotFoundException("Not Found");

      // Step 2: role validation
      const roleId = await this.resolveRoleId(client, tenantId, dto.role_code);

      // Steps 3-5: validate the store-access change
      const storeIds = dto.store_ids;
      await this.validateStoreAccess(client, tenantId, dto, existing.storeAccessKind);

      // Step 5b: role hierarchy on the post-change grant
      const actor = await this.hierarchy.actorFor(client, ctx);
      const next = {
        roleCode: dto.role_code ?? existing.roleCode,
        storeAccessKind: dto.store_access_kind ?? existing.storeAccessKind,
      };
      const reason = membershipUpdateRefusal(actor, existing, next, activeOwners);
      if (reason) {
        throw new MembershipChangeRefusedError({
          operation: "membership.update",
          reason,
          targetMembershipId: existing.id,
          targetRoleCode: existing.roleCode,
          requestedRoleCode: dto.role_code ?? null,
          requestedStoreAccessKind: dto.store_access_kind ?? null,
        });
      }

      // Step 6/7: apply and return
      return this.memberships.update(client, existing, {
        roleId,
        storeAccessKind: dto.store_access_kind,
        storeIds: storeIds && storeIds.length > 0 ? [...new Set(storeIds)] : storeIds,
      });
    });
  }

  /**
   * Run `work` in a tenant transaction. On a hierarchy refusal the
   * transaction has rolled back by the time this catches it, so the
   * refusal's audit row is written in a fresh one.
   */
  private async refusalAudited<T>(ctx: ResolvedContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.tx(this.pool, txCtx(ctx), work);
    } catch (err) {
      if (err instanceof MembershipChangeRefusedError) {
        await this.tx(this.pool, txCtx(ctx), (client) => this.hierarchy.recordRefusal(client, ctx, err.audit));
      }
      throw err;
    }
  }

  /** Step 2: resolve `role_code` to a role id in the tenant; undefined when not changing the role. */
  private async resolveRoleId(
    client: PoolClient,
    tenantId: string,
    roleCode: string | undefined,
  ): Promise<string | undefined> {
    if (roleCode === undefined) return undefined;
    if (roleCode === PLATFORM_ADMIN_CODE) {
      throw new BadRequestException("platform_admin is a platform-level role and cannot be assigned to a tenant membership");
    }
    const found = await this.memberships.findRoleId(client, tenantId, roleCode);
    if (!found) throw new BadRequestException(`Unknown role_code: ${roleCode}`);
    return found;
  }

  /** Steps 3-5: `store_ids` / `store_access_kind` consistency, tenant membership and uniqueness. */
  private async validateStoreAccess(
    client: PoolClient,
    tenantId: string,
    dto: MembershipUpdateDto,
    existingKind: string,
  ): Promise<void> {
    // Step 3/5: store_ids without explicit kind change
    if (dto.store_ids !== undefined && dto.store_access_kind === undefined && existingKind !== "specific") {
      throw new BadRequestException(
        "store_ids can only be updated without store_access_kind when the existing access kind is 'specific'",
      );
    }

    // Step 4: validate store_ids belong to active tenant
    const effectiveKind = dto.store_access_kind ?? existingKind;
    const storeIds = dto.store_ids;
    const isStoreAccessUpdate = dto.store_access_kind === "specific" || storeIds !== undefined;
    if (effectiveKind !== "specific") return;
    if (isStoreAccessUpdate && (!storeIds || storeIds.length === 0)) {
      throw new BadRequestException("store_ids must be non-empty when store_access_kind is 'specific'");
    }
    if (storeIds && storeIds.length > 0) {
      const invalid = await this.memberships.findInvalidStoreIds(client, tenantId, storeIds);
      if (invalid.length > 0) {
        throw new BadRequestException(`store_ids not found in active tenant: ${invalid.join(", ")}`);
      }
      // Deduplicate (Zod allows duplicates in arrays)
      if (new Set(storeIds).size !== storeIds.length) {
        throw new BadRequestException("store_ids must not contain duplicates");
      }
    }
  }
}
