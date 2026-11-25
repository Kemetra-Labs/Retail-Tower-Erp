/**
 * RT-1598 (W9 N1) — the typed problem and result of the stage-1 redistribution engine (RT-1596 master plan
 * §3.1, P-1, P-9, P-10). Internal TypeScript types, not the API contract: RT-1599 owns the OpenAPI shape.
 * Deviations from the §3.1 sketch are listed in this directory's README.
 */

/** A `numeric(19,4)` decimal string in the product's stocking unit (at most 15 integer digits). */
export type Qty = string;

type StoreExclusionV1 =
  | 'pos_queue_unknown'
  | 'pos_queue_dead_letter_or_held'
  | 'device_heartbeat_stale'
  | 'inactive';

export interface RedistributionStoreV1 {
  readonly storeId: string;
  /** The store's tenant; every store of a problem must belong to `RedistributionProblemV1.tenantId`. */
  readonly tenantId: string;
  /** Wall-clock time of that store's reads (ISO 8601). */
  readonly readAt: string;
  readonly eligibleAsSource: boolean;
  /** Any exclusion bars the store as a source; `inactive` also bars it as a destination. */
  readonly exclusion?: StoreExclusionV1;
}

/** One sellable product at one store (a row exists only where the catalog page lists the product). */
export interface RedistributionRowV1 {
  readonly storeId: string;
  readonly productId: string;
  readonly stockingUnit: string;
  /** Batch/expiry tracked products are excluded in v1. */
  readonly tracked: boolean;
  /** W3 formula, unchanged; may be negative. */
  readonly availableToSell: Qty;
  /** Catalog-resolved (store level, else tenant default); `null` when no level is set: the row is skipped. */
  readonly reorderLevel: Qty | null;
  /** Drafts not yet approved (approved transfers are already reserved inside ATS). */
  readonly openOutboundDraft: Qty;
  /** Draft + approved + in_transit towards this store. */
  readonly openInbound: Qty;
}

export interface RedistributionLimitsV1 {
  readonly maxStores: number;
  readonly maxRows: number;
  readonly deadlineMs: number;
  /** Lines per (source, destination) transfer; at most the W3 limit of 100. */
  readonly maxLinesPerTransfer: number;
}

/**
 * P-10 source buffer: `max(minimum, percentOfReorderLevel% of reorderLevel)`, rounded UP (toward protecting
 * the source) either at the 0.0001 scale or to a whole stocking unit. A placeholder, tuned in RT-1598/RT-1602.
 */
export interface BufferPolicyV1 {
  /** At least one stocking unit (`1.0000`): a smaller minimum is refused as `input_invalid_buffer_policy`. */
  readonly minimum: Qty;
  /** An integer 0..100. */
  readonly percentOfReorderLevel: number;
  readonly rounding: 'scale' | 'whole_unit';
}

export interface RedistributionProblemV1 {
  readonly kind: 'store_redistribution';
  readonly version: 1;
  readonly tenantId: string;
  readonly computedAt: string;
  readonly stores: ReadonlyArray<RedistributionStoreV1>;
  readonly rows: ReadonlyArray<RedistributionRowV1>;
  readonly limits: RedistributionLimitsV1;
  /** Defaults to `DEFAULT_BUFFER_POLICY_V1`. */
  readonly buffer?: BufferPolicyV1;
}

type MoveWarningCodeV1 = 'source_near_reorder_level';

export interface RedistributionMoveV1 {
  readonly productId: string;
  readonly sourceStoreId: string;
  readonly destinationStoreId: string;
  readonly quantity: Qty;
  readonly stockingUnit: string;
  readonly warnings: ReadonlyArray<MoveWarningCodeV1>;
}

export type RedistributionWarningCodeV1 =
  | 'store_excluded_as_source'
  | 'negative_available_to_sell'
  | 'reorder_level_missing'
  | 'tracked_product_skipped'
  | 'stocking_unit_mismatch';

/** A reviewer-facing note on the input. Row-level notes are counted per store, not listed per row. */
export interface RedistributionWarningV1 {
  readonly code: RedistributionWarningCodeV1;
  readonly storeId?: string;
  readonly productId?: string;
  readonly count?: number;
  readonly detail?: string;
}

export type RedistributionViolationCodeV1 =
  // the problem itself is malformed
  | 'input_unsupported_problem'
  | 'input_invalid_limits'
  | 'input_invalid_buffer_policy'
  | 'input_duplicate_store'
  | 'input_tenant_mismatch'
  | 'input_unknown_store'
  | 'input_duplicate_row'
  | 'input_malformed_quantity'
  // a line of the plan breaks a rule
  | 'malformed_quantity'
  | 'non_positive_quantity'
  | 'self_move'
  | 'unknown_store'
  | 'tenant_mismatch'
  | 'excluded_source'
  | 'inactive_destination'
  | 'not_sellable_at_source'
  | 'not_sellable_at_destination'
  | 'tracked_product'
  | 'stocking_unit_mismatch'
  | 'reorder_level_missing'
  | 'duplicate_line'
  // the plan as a whole breaks a rule
  | 'store_both_source_and_destination'
  | 'transfer_too_many_lines'
  | 'source_floor_breached'
  | 'destination_overfilled'
  | 'deficit_increased'
  | 'objective_mismatch';

export interface RedistributionViolationV1 {
  readonly code: RedistributionViolationCodeV1;
  readonly productId?: string;
  readonly storeId?: string;
  readonly sourceStoreId?: string;
  readonly destinationStoreId?: string;
  readonly detail?: string;
}

export interface RedistributionObjectiveV1 {
  readonly deficitBefore: Qty;
  readonly deficitAfter: Qty;
  readonly storePairs: number;
  readonly lines: number;
}

export type RedistributionStatusV1 =
  | 'proposed'
  | 'nothing_to_move'
  | 'refused_too_large'
  | 'deadline_exceeded'
  | 'invalid';

export interface RedistributionResultV1 {
  readonly status: RedistributionStatusV1;
  readonly rule: { readonly name: 'reorder_gap_greedy'; readonly version: string };
  /** Empty unless `proposed`: never a partial result. */
  readonly moves: ReadonlyArray<RedistributionMoveV1>;
  /** `null` when nothing was computed or the plan was rejected. */
  readonly objective: RedistributionObjectiveV1 | null;
  /** `null` when the validator did not run (refused or out of time). */
  readonly validator: {
    readonly passed: boolean;
    readonly violations: ReadonlyArray<RedistributionViolationV1>;
  } | null;
  readonly warnings: ReadonlyArray<RedistributionWarningV1>;
}
