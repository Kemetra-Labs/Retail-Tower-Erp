/**
 * Inventory wire/row types and SQL column constants (RT-1221 PR 1).
 *
 * Moved verbatim out of `inventory.service.ts`; `InventoryService` re-exports the
 * names that were public there, so existing imports keep working. Declarations
 * that were file-private now carry `export` so the service and the mappers can
 * import them.
 */
import type { InventoryStatus } from '@data-pulse-2/db';

import type { StockMovementScope } from './movement-list.cursor';

/** The set of manually-creatable movement types (contract enum, FR-002). */
export const MANUAL_MOVEMENT_TYPES = ['inbound', 'outbound', 'adjustment'] as const;
export type ManualMovementType = (typeof MANUAL_MOVEMENT_TYPES)[number];

/** Server-resolved + body-validated input to createStockMovement (FR-052). */
export interface CreateStockMovementInput {
  /** Resolved from the principal — never the body. */
  readonly tenantId: string;
  /** Resolved from the path — never the body. */
  readonly storeId: string;
  /** Resolved from the principal — never the body. */
  readonly userId: string;
  readonly movementType: ManualMovementType;
  /** SIGNED exact-decimal quantity string, in `stockingUnit`. */
  readonly quantity: string;
  readonly stockingUnit: string;
  readonly tenantProductRef?: string | null | undefined;
  readonly reason?: string | null | undefined;
  /** Business-event time; defaults to now() server-side when omitted. */
  readonly occurredAt?: string | null | undefined;
  readonly saleId?: string | null | undefined;
  readonly saleLineId?: string | null | undefined;
  readonly terminalEventRef?: string | null | undefined;
  /**
   * RT-432: a location of the path store; defaults to the store's primary
   * location (RT-290 G4-6).
   */
  readonly stockLocationId?: string | null | undefined;
  /** RT-432: defaults to `sellable` (RT-290 G4-6). */
  readonly inventoryStatus?: InventoryStatus | null | undefined;
}

/**
 * Worker-internal input to backfillRestockInbound (009-RESTOCK, T090/T091).
 *
 * A void/refund/return → restock is a manual/backfill inbound movement referencing the originating 008
 * void/refund terminal event (or a customer return) as provenance, deduped on
 * `(sourceSystem, externalId)` per FR-031 (FR-025/R6). Automatic restock-on-void
 * is DEFERRED (FR-060) — this is the manual/backfill entry only, no auto route.
 */
export interface BackfillRestockInboundInput {
  readonly tenantId: string;
  readonly storeId: string;
  /** The restock actor (a service principal resolved by the processor). */
  readonly userId: string;
  /** Restock origin (e.g. "pos-restock") — half of the dedup pair (FR-031). */
  readonly sourceSystem: string;
  /** External natural key (e.g. the void/refund event id) — the other half. */
  readonly externalId: string;
  readonly movementType: 'inbound';
  /** SIGNED exact-decimal quantity string (inbound ⇒ positive). */
  readonly quantity: string;
  readonly stockingUnit: string;
  readonly tenantProductRef?: string | null | undefined;
  readonly reason?: string | null | undefined;
  readonly occurredAt?: string | null | undefined;
  /**
   * The originating 008 void/refund terminal event (or return) — provenance
   * only, read by value, never an FK (R8); the ledger never mutates the 008 fact.
   */
  readonly terminalEventRef?: string | null | undefined;
  /** Optional originating sale provenance, if the restock traces to a sale. */
  readonly saleId?: string | null | undefined;
  readonly saleLineId?: string | null | undefined;
  /** Carried into the audit metadata for traceability across the backfill. */
  readonly correlationId?: string | null | undefined;
}

/** Server-resolved input to createStockTransfer (009-US5, FR-020). */
export interface CreateStockTransferInput {
  /** Resolved from the principal — never the body. */
  readonly tenantId: string;
  /** Resolved from the principal — never the body. */
  readonly userId: string;
  /** Source store; authorized at the controller against the principal's scope. */
  readonly sourceStoreId: string;
  /** Destination store; a TARGET ref, resolved within tenant scope (FR-051). */
  readonly destinationStoreId: string;
  readonly tenantProductRef: string;
  /** STRICTLY POSITIVE exact-decimal magnitude string (the transfer amount). */
  readonly quantity: string;
  readonly stockingUnit: string;
  readonly reason?: string | null | undefined;
}

/** The linked-movement pair a transfer produces (contract `StockTransfer`). */
export interface StockTransferBody {
  readonly transferGroupId: string;
  readonly outbound: StockMovementBody;
  readonly inbound: StockMovementBody;
}

/** Server-resolved input to recordStockCount (009-US6, FR-021). */
export interface RecordStockCountInput {
  /** Resolved from the principal — never the body. */
  readonly tenantId: string;
  /** Resolved from the path — never the body. */
  readonly storeId: string;
  /** Resolved from the principal — never the body. */
  readonly userId: string;
  readonly tenantProductRef: string;
  /** The physical count (non-negative) at numeric(19,4). */
  readonly countedQuantity: string;
  readonly stockingUnit: string;
  readonly countedAt?: string | null | undefined;
}

/** Result of a recorded count (contract `StockCountResult`). */
export interface StockCountResultBody {
  readonly stockCountId: string;
  readonly countedQuantity: string;
  /** Signed variance (counted − derived on-hand). Zero ⇒ no correction. */
  readonly variance: string;
  /** The appended count_correction movement, or null on zero variance. */
  readonly correctionMovement: StockMovementBody | null;
}

/** Wire projection of a stock_movements row (contract `StockMovement`, §IV). */
export interface StockMovementBody {
  readonly id: string;
  readonly storeId: string;
  readonly movementType: string;
  readonly quantity: string;
  readonly stockingUnit: string;
  readonly tenantProductRef: string | null;
  readonly reason: string | null;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly saleId: string | null;
  readonly saleLineId: string | null;
  readonly terminalEventRef: string | null;
  readonly transferGroupId: string | null;
  readonly stockCountId: string | null;
  readonly createdBy: string;
  /** RT-425 (RT-289 G2-2): the effect's origin — `retail` | `erp_external`. */
  readonly origin: string;
  /**
   * RT-425 (RT-289 G2-3): the effect's ERP integration state, or null when the
   * effect has no integration record.
   */
  readonly integrationState: string | null;
  /** RT-425 (RT-289 G2-4): when ERP confirmed the effect; null until then. */
  readonly erpConfirmedAt: string | null;
  /** RT-432 (RT-290 G4-1): the effect's stock location. */
  readonly stockLocationId: string;
  /** RT-432 (RT-290 G4-2): the effect's inventory status. */
  readonly inventoryStatus: string;
  /**
   * RT-432 (RT-290 G4-5): true for a movement recorded before positions existed,
   * whose position is read as (the store's primary location, sellable).
   */
  readonly positionInterpreted: boolean;
  /**
   * RT-448 (RT-50 G7-2): the tracking identity of the movement's own product;
   * null for an untracked product and for every movement written today.
   */
  readonly trackingIdentityId: string | null;
}

/** RT-432: one inventory status's share of the on-hand (contract `StatusQuantity`). */
export interface StatusQuantityBody {
  readonly inventoryStatus: InventoryStatus;
  readonly quantity: string;
}

/** Wire projection of the derived on-hand (contract `OnHand`, FR-003/024). */
export interface OnHandBody {
  readonly storeId: string;
  readonly productId: string;
  /** Physical on-hand: every location and status of the store (732, 973). */
  readonly quantity: string;
  readonly stockingUnit: string | null;
  readonly negativeBalance: boolean;
  /** RT-432: the `sellable` share (733); ATS is derived from it later (742). */
  readonly sellableQuantity: string;
  /** RT-432: one entry per inventory status, in enum order (745). */
  readonly statusQuantities: readonly StatusQuantityBody[];
}

/** RT-432: wire projection of a stock location (contract `StockLocation`). */
export interface StockLocationBody {
  readonly id: string;
  readonly storeId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly isActive: boolean;
}

export interface StockLocationListBody {
  readonly items: readonly StockLocationBody[];
}

/** RT-448: wire projection of a tracking identity (contract `TrackingIdentity`). */
export interface TrackingIdentityBody {
  readonly id: string;
  readonly productId: string;
  readonly kind: string;
  readonly code: string;
  /** Calendar date `YYYY-MM-DD`, or null. */
  readonly expiryDate: string | null;
  readonly manufacturedOn: string | null;
  readonly origin: string;
}

export interface TrackingIdentityListBody {
  readonly items: readonly TrackingIdentityBody[];
  /** Opaque cursor for the next page; null when exhausted. */
  readonly nextCursor: string | null;
}

export interface TrackingIdentityRow {
  id: string;
  tenant_product_ref: string;
  kind: string;
  code: string;
  expiry_date: string | null;
  manufactured_on: string | null;
  origin: string;
  /** The keyset sort value: the expiry date, or `infinity`. */
  sort_expiry: string;
}

export interface StockMovementListBody {
  readonly items: readonly StockMovementBody[];
  readonly nextCursor: string | null;
}

/** Raw row shape from the explicit-column SELECT. */
export interface MovementRow {
  id: string;
  store_id: string;
  movement_type: string;
  quantity: string;
  stocking_unit: string;
  tenant_product_ref: string | null;
  reason: string | null;
  occurred_at: Date;
  received_at: Date;
  sale_id: string | null;
  sale_line_id: string | null;
  terminal_event_ref: string | null;
  transfer_group_id: string | null;
  stock_count_id: string | null;
  created_by: string;
  origin: string;
  /** From inventory_effect_integration; absent on a bare RETURNING row. */
  integration_state?: string | null;
  erp_confirmed_at?: Date | null;
  /** RT-432: NULL only on a movement recorded before 0044. */
  stock_location_id: string | null;
  inventory_status: string | null;
  /** RT-432: the store's primary location, joined on reads (G4-5). */
  primary_location_id?: string | null;
  /** RT-448 (G7-2): the typed tracking reference; NULL when untracked. */
  tracking_identity_id: string | null;
}

export const MOVEMENT_COLUMN_NAMES = [
  'id', 'store_id', 'movement_type', 'quantity', 'stocking_unit', 'tenant_product_ref',
  'reason', 'occurred_at', 'received_at', 'sale_id', 'sale_line_id', 'terminal_event_ref',
  'transfer_group_id', 'stock_count_id', 'created_by', 'origin',
  'stock_location_id', 'inventory_status', 'tracking_identity_id',
] as const;

export const MOVEMENT_COLUMNS = MOVEMENT_COLUMN_NAMES.join(', ');

/**
 * RT-425: movement columns qualified by `m`, plus the effect's integration
 * state, for reads that LEFT JOIN inventory_effect_integration `i`.
 * RT-432: plus the store's primary location, for reads that LEFT JOIN it as
 * `p` (MOVEMENT_POSITION_JOIN) to resolve a pre-0044 movement's position.
 */
export const MOVEMENT_COLUMNS_WITH_INTEGRATION = [
  ...MOVEMENT_COLUMN_NAMES.map((c) => `m.${c}`),
  'i.state AS integration_state',
  'i.erp_confirmed_at',
  'p.id AS primary_location_id',
].join(', ');

/**
 * RT-731: the listStockMovements predicate for a listing without productId.
 * `$2` is the (null) productId, referenced so every variant binds it.
 */
export const MOVEMENT_SCOPE_PREDICATES: Readonly<Record<StockMovementScope, string>> = {
  adhoc: '($2::uuid IS NULL AND m.tenant_product_ref IS NULL)',
  all: '($2::uuid IS NULL)',
};

/** RT-432 (G4-5): the store's primary location, for reading legacy positions. */
export const MOVEMENT_POSITION_JOIN =
  "LEFT JOIN stock_locations p ON p.store_id = m.store_id AND p.kind = 'primary'";

/** RT-432 (RT-290 G4-6): the status a V1 write lands in unless told otherwise. */
export const DEFAULT_INVENTORY_STATUS: InventoryStatus = 'sellable';

/** RT-432: the position a movement is written at. */
export interface EffectPosition {
  readonly stockLocationId: string;
  readonly inventoryStatus: InventoryStatus;
}

/** RT-425: the state every Retail effect starts in until an ERP intent exists. */
export const NOT_POSTED = 'not_posted';

/** Normalized, validated fields of the provenance-dedup restock backfill entry. */
export interface NormalizedBackfillFields {
  sourceSystem: string;
  externalId: string;
  stockingUnit: string;
  reason: string | null;
  tenantProductRef: string | null;
}
