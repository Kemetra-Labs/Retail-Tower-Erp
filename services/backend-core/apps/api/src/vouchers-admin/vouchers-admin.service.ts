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
import { assertStoresEligible, insertEligibleStores, insertVoucherBatch } from "./voucher-issue";
import { decodeVoucherCursor, encodeVoucherCursor, GET_SQL, LIST_SQL } from "./vouchers-admin.queries";

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

export interface VoucherScoped {
  readonly tenantId: string;
}

export interface IssueVouchersInput extends VoucherScoped {
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly body: VoucherIssueDto;
}

export interface CancelVoucherInput extends VoucherScoped {
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly voucherId: string;
}

export interface ListVouchersInput extends VoucherScoped {
  readonly query: VoucherListQuery;
}

@Injectable()
export class VouchersAdminService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  issue(input: IssueVouchersInput): Promise<VoucherIssueBody> {
    const { tenantId, body } = input;
    return runWithTenantContext(this.pool, tenantScope(tenantId), async (client) => {
      const storeIds = body.applies_to_all_stores ? [] : (body.eligible_store_ids ?? []);
      if (storeIds.length > 0) await assertStoresEligible(client, tenantId, storeIds);
      const currencyCode = await tenantCurrency(client, tenantId);
      const batchId = newId();
      const expiresAt = body.expires_at ?? null;
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
          expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(),
        })),
      };
    });
  }

  async list(input: ListVouchersInput): Promise<VoucherPageBody> {
    const { query } = input;
    const keyset = query.cursor === undefined ? null : decodeVoucherCursor(query.cursor);
    const limit = query.page_size ?? VOUCHER_PAGE_SIZE_DEFAULT;
    return runWithTenantContext(this.pool, tenantScope(input.tenantId), async (client) => {
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
      const r = await client.query<VoucherReadRow>(GET_SQL, [input.tenantId, input.voucherId]);
      const row = r.rows[0];
      if (!row) throw new VoucherNotFoundError();
      return toVoucher(row);
    });
  }

  cancel(input: CancelVoucherInput): Promise<VoucherCancelBody> {
    const { tenantId, voucherId } = input;
    return runWithTenantContext(this.pool, tenantScope(tenantId), async (client) => {
      // One conditional write settles a race with redeem: exactly one wins.
      const won = await client.query<{ batch_id: string; cancelled_at: Date }>(
        `UPDATE vouchers
            SET status = 'cancelled', cancelled_at = now(), cancelled_by_user_id = $3
          WHERE tenant_id = $1 AND id = $2 AND status = 'active'
          RETURNING batch_id::text AS batch_id, cancelled_at`,
        [tenantId, voucherId, input.actorUserId],
      );
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
      return await settleLostCancel(client, tenantId, voucherId);
    });
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

/** Zero rows cancelled: already cancelled (200), redeemed (409) or absent (404). */
async function settleLostCancel(client: PoolClient, tenantId: string, voucherId: string): Promise<VoucherCancelBody> {
  const r = await client.query<{ status: string; cancelled_at: Date | null }>(
    `SELECT status, cancelled_at FROM vouchers WHERE tenant_id = $1 AND id = $2`,
    [tenantId, voucherId],
  );
  const row = r.rows[0];
  if (!row) throw new VoucherNotFoundError();
  if (row.status === "cancelled" && row.cancelled_at !== null) return cancelResult(voucherId, row.cancelled_at, true);
  throw new VoucherAlreadyRedeemedError();
}

function cancelResult(voucherId: string, cancelledAt: Date, already: boolean): VoucherCancelBody {
  return { voucher_id: voucherId, status: "cancelled", cancelled_at: cancelledAt.toISOString(), already_cancelled: already };
}
