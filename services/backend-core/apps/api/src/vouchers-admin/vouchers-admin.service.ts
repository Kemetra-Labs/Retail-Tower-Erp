/**
 * VouchersAdminService — RT-1108: issue, list, read and cancel promotional
 * vouchers (`vouchers-admin.openapi.yaml`, RT-922 sections 5.2 to 5.5).
 *
 * Tenant scope comes from the session (`tenantId` is never a request value);
 * RLS enforces it and every statement also names `tenant_id`.
 *
 *   - issue: one transaction. Eligible stores are checked, the batch and any
 *     eligibility rows are inserted, `voucher.issued` is audited, all on the
 *     same client. The codes exist in memory only and leave in the one response.
 *   - list / get: the effective status is derived in SQL (`expired` is a stored
 *     `active` whose `expires_at` has passed, RT-922 section 5.4). No code, no hash.
 *   - store scope (RT-131, "the role never widens a membership"): the caller's scope
 *     is `callerStoreScope` (an owner / tenant_admin is not narrowed by the active
 *     store, a `specific` membership stays specific). Issue: every subset store must
 *     be in scope (else the same 404 as an absent store), an all-stores batch needs
 *     tenant-wide scope (else 403). List, get and cancel cover only vouchers the
 *     caller has authority over (`authoritySql`), in the SQL so pagination holds.
 *   - cancel: one conditional UPDATE of exactly the three status columns the
 *     domain role may change, `WHERE status = 'active'` (an expired voucher is
 *     cancellable). Zero rows re-reads the voucher to tell cancelled, redeemed
 *     and absent apart.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { MembershipRepository } from "../context/membership.repository";
import { callerStoreScope, scopeStoreIds } from "../context/operator-store-scope";
import type { ResolvedContext } from "../context/types";
import {
  toVoucher,
  VOUCHER_PAGE_SIZE_DEFAULT,
  type VoucherBody,
  type VoucherCancelBody,
  type VoucherIssueBody,
  type VoucherIssueDto,
  type VoucherListQuery,
  type VoucherPageBody,
  type VoucherReadRow,
} from "./vouchers-admin.dto";
import { insertVoucherAudit, VOUCHER_CANCELLED_ACTION, VOUCHER_ISSUED_ACTION } from "./vouchers-admin-audit";
import {
  assertStoresEligible,
  insertEligibleStores,
  insertVoucherBatch,
  VoucherScopeInsufficientError,
} from "./voucher-issue";
import {
  CANCEL_SQL,
  decodeVoucherCursor,
  encodeVoucherCursor,
  GET_SQL,
  LIST_SQL,
  RECHECK_SQL,
} from "./vouchers-admin.queries";

/** The voucher is absent or of another tenant (404 `voucher_not_found`, non-disclosing). */
export class VoucherNotFoundError extends Error {
  constructor() {
    super("voucher not found");
    this.name = "VoucherNotFoundError";
  }
}

/** The voucher was redeemed, so it cannot be cancelled (409 `voucher_already_redeemed`). */
export class VoucherAlreadyRedeemedError extends Error {
  constructor() {
    super("voucher already redeemed");
    this.name = "VoucherAlreadyRedeemedError";
  }
}

interface VoucherScoped {
  readonly tenantId: string;
  /** The session's resolved context: its store scope bounds the call. */
  readonly context: ResolvedContext;
}

interface IssueVouchersInput extends VoucherScoped {
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly body: VoucherIssueDto;
}

interface CancelVoucherInput extends VoucherScoped {
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly voucherId: string;
}

interface ListVouchersInput extends VoucherScoped {
  readonly query: VoucherListQuery;
}

@Injectable()
export class VouchersAdminService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly memberships: MembershipRepository,
  ) {}

  issue(input: IssueVouchersInput): Promise<VoucherIssueBody> {
    const { tenantId, body } = input;
    return runWithTenantContext(this.pool, tenantScope(tenantId), async (client) => {
      const scope = await callerStoreScope(client, this.memberships, input);
      const storeIds = body.applies_to_all_stores ? [] : (body.eligible_store_ids ?? []);
      if (body.applies_to_all_stores && scope.kind !== "tenant") throw new VoucherScopeInsufficientError();
      if (storeIds.length > 0) await assertStoresEligible(client, tenantId, scope, storeIds);
      const currencyCode = await tenantCurrency(client, tenantId);
      const batchId = newId();
      const expiresAt = body.expires_at === undefined || body.expires_at === null ? null : new Date(body.expires_at).toISOString();
      const inserted = await insertVoucherBatch(client, {
        tenantId,
        batchId,
        actorUserId: input.actorUserId,
        count: body.count,
        amountMinor: body.amount_minor,
        currencyCode,
        expiresAt,
        appliesToAllStores: body.applies_to_all_stores,
        note: body.note ?? null,
      });
      if (storeIds.length > 0) {
        await insertEligibleStores(client, tenantId, inserted.map((v) => v.voucherId), storeIds);
      }
      await insertVoucherAudit(client, {
        tenantId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        action: VOUCHER_ISSUED_ACTION,
        targetType: "voucher_batch",
        targetId: batchId,
        // Never the codes, the hashes or the note.
        metadata: {
          batch_id: batchId,
          count: body.count,
          amount_minor: body.amount_minor,
          currency_code: currencyCode,
          expires_at: expiresAt,
          applies_to_all_stores: body.applies_to_all_stores,
          eligible_store_ids: storeIds,
        },
      });
      return {
        batch_id: batchId,
        vouchers: inserted.map((v) => ({
          voucher_id: v.voucherId,
          code: v.code,
          amount_minor: body.amount_minor,
          currency_code: currencyCode,
          expires_at: expiresAt,
        })),
      };
    });
  }

  async list(input: ListVouchersInput): Promise<VoucherPageBody> {
    const { query } = input;
    const keyset = query.cursor === undefined ? null : decodeVoucherCursor(query.cursor);
    const limit = query.page_size ?? VOUCHER_PAGE_SIZE_DEFAULT;
    return runWithTenantContext(this.pool, tenantScope(input.tenantId), async (client) => {
      const authority = await this.authority(client, input);
      const r = await client.query<VoucherReadRow & { created_at_key: string }>(LIST_SQL, [
        input.tenantId,
        query.status ?? null,
        query.batch_id ?? null,
        query.eligible_store_id ?? null,
        query.expires_from ?? null,
        query.expires_before ?? null,
        keyset?.createdAtKey ?? null,
        keyset?.voucherId ?? null,
        limit + 1,
        ...authority,
      ]);
      const page = r.rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toVoucher),
        next_cursor: r.rows.length > limit && last ? encodeVoucherCursor(last.created_at_key, last.id) : null,
      };
    });
  }

  get(input: VoucherScoped & { readonly voucherId: string }): Promise<VoucherBody> {
    return runWithTenantContext(this.pool, tenantScope(input.tenantId), async (client) => {
      const authority = await this.authority(client, input);
      const r = await client.query<VoucherReadRow>(GET_SQL, [input.tenantId, input.voucherId, ...authority]);
      const row = r.rows[0];
      if (!row) throw new VoucherNotFoundError();
      return toVoucher(row);
    });
  }

  cancel(input: CancelVoucherInput): Promise<VoucherCancelBody> {
    const { tenantId, voucherId } = input;
    return runWithTenantContext(this.pool, tenantScope(tenantId), async (client) => {
      const authority = await this.authority(client, input);
      // One conditional write settles a race with redeem: exactly one wins.
      const won = await client.query<{ batch_id: string; cancelled_at: Date }>(CANCEL_SQL, [
        tenantId,
        voucherId,
        input.actorUserId,
        ...authority,
      ]);
      const cancelled = won.rows[0];
      if (cancelled) {
        await insertVoucherAudit(client, {
          tenantId,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          action: VOUCHER_CANCELLED_ACTION,
          targetType: "voucher",
          targetId: voucherId,
          metadata: { voucher_id: voucherId, batch_id: cancelled.batch_id },
        });
        return cancelResult(voucherId, cancelled.cancelled_at, false);
      }
      return await settleLostCancel(client, input, authority);
    });
  }

  /** The caller's store authority as the SQL parameters `[tenant-wide, scoped store ids]`. */
  private async authority(client: PoolClient, input: VoucherScoped): Promise<[boolean, readonly string[]]> {
    const ids = scopeStoreIds(await callerStoreScope(client, this.memberships, input));
    return [ids === null, ids ?? []];
  }
}

/** The RLS context of a Console request: the session tenant, never a platform admin. */
const tenantScope = (tenantId: string) => ({ tenantId, isPlatformAdmin: false });

/** The tenant default currency (`tenants.default_currency_code`, RT-922 section 4 item 2). */
async function tenantCurrency(client: PoolClient, tenantId: string): Promise<string> {
  const r = await client.query<{ default_currency_code: string }>(
    `SELECT default_currency_code FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const row = r.rows[0];
  if (!row) throw new Error("tenant not found for the session");
  return row.default_currency_code;
}

/** Zero rows cancelled: already cancelled (200), redeemed (409), or absent or out of authority (404). */
async function settleLostCancel(
  client: PoolClient,
  input: { readonly tenantId: string; readonly voucherId: string },
  authority: readonly [boolean, readonly string[]],
): Promise<VoucherCancelBody> {
  const r = await client.query<{ status: string; cancelled_at: Date | null }>(RECHECK_SQL, [
    input.tenantId,
    input.voucherId,
    ...authority,
  ]);
  const row = r.rows[0];
  if (!row) throw new VoucherNotFoundError();
  if (row.status === "cancelled" && row.cancelled_at !== null) {
    return cancelResult(input.voucherId, row.cancelled_at, true);
  }
  if (row.status === "redeemed") throw new VoucherAlreadyRedeemedError();
  // Stored `active` after a lost update cannot happen (the update would have matched it).
  throw new Error(`unexpected voucher status after a lost cancel: ${row.status}`);
}

function cancelResult(voucherId: string, cancelledAt: Date, already: boolean): VoucherCancelBody {
  return { voucher_id: voucherId, status: "cancelled", cancelled_at: cancelledAt.toISOString(), already_cancelled: already };
}
