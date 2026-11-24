/**
 * Inventory source-position negative signal — RT-1584 (RT-1125 R-30, R-31;
 * 009 FR-024 allow-and-flag). Increments once per status move or relocation
 * that left its source position (store, product, location, status, tracking
 * identity) below zero. A move never changes the store on-hand, so
 * `inventory_negative_balance_total` cannot count it. UNLABELED: the event is
 * on the move's audit row (`sourcePositionNegative`); a tenant, store, product
 * or location label is a cardinality + §XIV hazard.
 */
export const METRIC_LABELS: Readonly<Record<string, readonly string[]>> = {
  inventory_position_negative_total: [],
};
