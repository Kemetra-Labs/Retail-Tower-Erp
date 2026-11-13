/**
 * sale-void-vouchers.ts — RT-1343 item 3 (owner decision 2026-11-12): a full
 * void of a completed voucher-paid sale RESTORES each voucher: the redemption its
 * `voucher` tenders reference is reversed and the voucher is `active` again.
 *
 * Called by `recordVoid` on the created path only, after the `sale_voids`
 * insert, with the `sales` row already locked (`lockSaleForReversal`). Lock order
 * is therefore sale → voucher → redemption (see `reverseRedemptionInTx`), the
 * same as every other voucher writer. A replayed void never reaches this, so it
 * cannot reverse twice; a redemption somebody already reversed answers
 * `alreadyReversed` and changes nothing.
 *
 * A refusal or an invariant break throws and rolls the whole void back: a void
 * never lands with its voucher still spent. That is a plain 500 on purpose (fail
 * closed): capture pins the store and the FK pins the tenant, and no writer leaves
 * a voucher non-`redeemed` under an open redemption, so only corrupted data gets here.
 * The credit-sale void (`credit-sale-reversal.store.ts`) calls the same helper in
 * RT-1343 item 2. The tenders are walked in
 * redemption-id order so two voucher tenders of one sale always lock the same
 * way.
 */
import type { PoolClient } from "pg";

import { reverseRedemptionInTx } from "../../vouchers-pos/voucher-redemption-reversal";

export interface VoidVoucherScope {
  readonly tenantId: string;
  readonly storeId: string;
  readonly saleId: string;
  /** The till that sent the void. */
  readonly deviceId: string;
  /** The void's verified actor: the `voucher.reversed` audit row names it. */
  readonly actorUserId: string;
  readonly requestId: string | null;
}

/** Reverse the redemption of every `voucher` tender of the voided sale; returns how many were reversed now. */
export async function reverseVoucherTendersOfVoidedSale(client: PoolClient, scope: VoidVoucherScope): Promise<number> {
  const tenders = await client.query<{ redemption_id: string }>(
    // ORDER BY the uuid column (not the text alias): capture sorts the uuid, and the lock order must match.
    `SELECT t.redemption_id::text AS redemption_id
       FROM sale_tenders t
      WHERE t.tenant_id = $1 AND t.sale_id = $2 AND t.method = 'voucher' AND t.redemption_id IS NOT NULL
      ORDER BY t.redemption_id`,
    [scope.tenantId, scope.saleId],
  );
  let reversed = 0;
  for (const tender of tenders.rows) {
    const done = await reverseRedemptionInTx(client, {
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      deviceId: scope.deviceId,
      actorUserId: scope.actorUserId,
      requestId: scope.requestId,
      redemptionId: tender.redemption_id,
      allowConsumingSaleId: scope.saleId,
    });
    if (!done.alreadyReversed) reversed += 1;
  }
  return reversed;
}
