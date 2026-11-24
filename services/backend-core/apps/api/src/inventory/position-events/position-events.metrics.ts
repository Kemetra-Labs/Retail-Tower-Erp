/**
 * Position-event metrics — RT-1584 (009 FR-024 allow-and-flag).
 *
 * Unlabeled: `assertMetricLabels` runs at module load and refuses any label
 * outside the `inventory-position-negative.labels.ts` entry. Instruments are
 * no-ops until an OTel MetricReader is registered.
 */
import { assertMetricLabels, getMeter, type Counter } from '@data-pulse-2/shared';

assertMetricLabels('inventory_position_negative_total', []);

const meter = getMeter('api');

const _positionNegative: Counter = meter.createCounter('inventory_position_negative_total', {
  description:
    'Status moves and relocations that left their source position (store, product, location, status, tracking identity) below zero under the allow-and-flag policy (009 FR-024; RT-1584). A move never changes the store on-hand, so inventory_negative_balance_total cannot count it. Unlabeled: the event is on its audit row (sourcePositionNegative).',
});

/** A SIGNAL: never blocks or rolls back the move. */
export function recordInventoryPositionNegative(): void {
  _positionNegative.add(1);
}
