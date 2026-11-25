/**
 * RT-1597 — the quantities already on open shipment Transfers, per store × product, for the W9 redistribution proposals
 * (RT-1596 §3.1, candidate W1). Read only, on the caller's tenant-scoped client (RLS FORCE on the 0125 tables, so another
 * tenant's Transfers are invisible).
 *
 * Why these quantities: a Draft reserves nothing (806), so its source stock still counts in ATS and must be netted by the
 * caller; an approved Transfer is already reserved, so it has already left the source's ATS. Towards the destination,
 * nothing on a Transfer is in its ATS until received, so every open Transfer into it counts.
 *
 *   - `outboundDraft`: the line quantity of `draft` Transfers out of the store.
 *   - `inboundDraft`, `inboundApproved`: the line quantity of `draft` / `approved` Transfers into the store.
 *   - `inboundInTransit`: the In Transit quantity (`dispatched - received - short_closed`, G4-1; the same expression as
 *     `OnHand.availability.inTransitInbound`) of `in_transit` AND `partially_received` Transfers into the store. A partly
 *     received Transfer still has goods on the way; leaving it out would propose a move those goods already cover.
 *   - `inbound`: the sum of the three inbound quantities.
 *
 * Quantities are exact `numeric(19,4)` strings in the line's stocking unit, summed across tracking identities. A row
 * where every quantity is zero is not returned.
 */
import type { PoolClient } from 'pg';

export interface OpenTransferQuantityRow {
  readonly storeId: string;
  readonly productId: string;
  readonly stockingUnit: string;
  readonly outboundDraft: string;
  readonly inboundDraft: string;
  readonly inboundApproved: string;
  readonly inboundInTransit: string;
  readonly inbound: string;
}

interface QuantityRow {
  readonly store_id: string;
  readonly product_id: string;
  readonly stocking_unit: string;
  readonly outbound_draft: string;
  readonly inbound_draft: string;
  readonly inbound_approved: string;
  readonly inbound_in_transit: string;
  readonly inbound: string;
}

const OPEN_QUANTITIES_SQL = `
  WITH legs AS (
    SELECT t.source_store_id AS store_id, l.tenant_product_ref AS product_id, l.stocking_unit,
           l.quantity AS outbound_draft, 0::numeric AS inbound_draft, 0::numeric AS inbound_approved,
           0::numeric AS inbound_in_transit
      FROM shipment_transfer_lines l
      JOIN shipment_transfers t ON t.id = l.transfer_id AND t.tenant_id = l.tenant_id
     WHERE t.state = 'draft'
       AND ($1::uuid[] IS NULL OR t.source_store_id = ANY($1::uuid[]))
    UNION ALL
    SELECT t.destination_store_id, l.tenant_product_ref, l.stocking_unit,
           0::numeric,
           CASE WHEN t.state = 'draft' THEN l.quantity ELSE 0 END,
           CASE WHEN t.state = 'approved' THEN l.quantity ELSE 0 END,
           CASE WHEN t.state IN ('in_transit', 'partially_received')
                THEN l.dispatched_quantity - l.received_quantity - l.short_closed_quantity ELSE 0 END
      FROM shipment_transfer_lines l
      JOIN shipment_transfers t ON t.id = l.transfer_id AND t.tenant_id = l.tenant_id
     WHERE t.state IN ('draft', 'approved', 'in_transit', 'partially_received')
       AND ($1::uuid[] IS NULL OR t.destination_store_id = ANY($1::uuid[]))
  )
  SELECT store_id::text AS store_id, product_id::text AS product_id, stocking_unit,
         SUM(outbound_draft)::numeric(19,4)::text AS outbound_draft,
         SUM(inbound_draft)::numeric(19,4)::text AS inbound_draft,
         SUM(inbound_approved)::numeric(19,4)::text AS inbound_approved,
         SUM(inbound_in_transit)::numeric(19,4)::text AS inbound_in_transit,
         SUM(inbound_draft + inbound_approved + inbound_in_transit)::numeric(19,4)::text AS inbound
    FROM legs
   GROUP BY store_id, product_id, stocking_unit
  HAVING SUM(outbound_draft) <> 0 OR SUM(inbound_draft + inbound_approved + inbound_in_transit) <> 0
   ORDER BY store_id, product_id, stocking_unit`;

/** The open quantities of every store of the tenant, or of `storeIds` only (an empty list reads nothing). */
export async function readOpenTransferQuantities(
  client: PoolClient,
  input: { readonly storeIds?: readonly string[] | undefined } = {},
): Promise<readonly OpenTransferQuantityRow[]> {
  const result = await client.query<QuantityRow>(OPEN_QUANTITIES_SQL, [input.storeIds ?? null]);
  return result.rows.map((r) => ({
    storeId: r.store_id,
    productId: r.product_id,
    stockingUnit: r.stocking_unit,
    outboundDraft: r.outbound_draft,
    inboundDraft: r.inbound_draft,
    inboundApproved: r.inbound_approved,
    inboundInTransit: r.inbound_in_transit,
    inbound: r.inbound,
  }));
}
