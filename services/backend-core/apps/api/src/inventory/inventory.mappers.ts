/**
 * Inventory row -> wire mappers (RT-1221 PR 1).
 *
 * Moved verbatim out of `inventory.service.ts`; `InventoryService` re-exports
 * `toMovementBody` and `toTrackingIdentityBody`, which were public there.
 */
import {
  DEFAULT_INVENTORY_STATUS,
  NOT_POSTED,
  type MovementRow,
  type StockMovementBody,
  type TrackingIdentityBody,
  type TrackingIdentityRow,
} from './inventory.types';

/** Also used by `TrackingIdentityReadsService` (RT-1081 `getTrackingIdentity`). */
export function toTrackingIdentityBody(t: Omit<TrackingIdentityRow, 'sort_expiry'>): TrackingIdentityBody {
  return {
    id: t.id,
    productId: t.tenant_product_ref,
    kind: t.kind,
    code: t.code,
    expiryDate: t.expiry_date,
    manufacturedOn: t.manufactured_on,
    origin: t.origin,
  };
}

export function toMovementBody(r: MovementRow): StockMovementBody {
  return {
    id: r.id,
    storeId: r.store_id,
    movementType: r.movement_type,
    quantity: r.quantity,
    stockingUnit: r.stocking_unit,
    tenantProductRef: r.tenant_product_ref,
    reason: r.reason,
    occurredAt: r.occurred_at.toISOString(),
    receivedAt: r.received_at.toISOString(),
    saleId: r.sale_id,
    saleLineId: r.sale_line_id,
    terminalEventRef: r.terminal_event_ref,
    transferGroupId: r.transfer_group_id,
    stockCountId: r.stock_count_id,
    createdBy: r.created_by,
    origin: r.origin,
    integrationState: r.integration_state ?? null,
    erpConfirmedAt: r.erp_confirmed_at ? r.erp_confirmed_at.toISOString() : null,
    ...toPositionBody(r),
    trackingIdentityId: r.tracking_identity_id,
  };
}

/**
 * RT-432 (RT-290 G4-5): a movement's position. A movement recorded before 0044
 * has none and is read as (the store's primary location, sellable).
 */
function toPositionBody(
  r: MovementRow,
): Pick<StockMovementBody, 'stockLocationId' | 'inventoryStatus' | 'positionInterpreted'> {
  if (r.stock_location_id !== null && r.inventory_status !== null) {
    return {
      stockLocationId: r.stock_location_id,
      inventoryStatus: r.inventory_status,
      positionInterpreted: false,
    };
  }
  if (!r.primary_location_id) {
    // 0044 gives every store a primary location; a missing one is a broken
    // invariant, never a position to guess.
    throw new Error(`InventoryService: store ${r.store_id} has no primary stock location`);
  }
  return {
    stockLocationId: r.primary_location_id,
    inventoryStatus: DEFAULT_INVENTORY_STATUS,
    positionInterpreted: true,
  };
}

/** RT-425: a just-written Retail effect, whose integration record is `not_posted`. */
export function asNotPosted(r: MovementRow): MovementRow {
  return { ...r, integration_state: NOT_POSTED, erp_confirmed_at: null };
}
