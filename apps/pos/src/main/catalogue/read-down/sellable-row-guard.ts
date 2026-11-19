/**
 * Structural transport-boundary guard for one `SellableCatalogRow`, shared by
 * the snapshot page (010) and the delta `upsert` op (RT-1487). Per-row money and
 * shape mapping (`mapSellableRow`) still guards downstream in the writer.
 */

import type { SellableCatalogRow } from './map-sellable-row.js';

/** Narrow an unknown value to a `SellableCatalogRow` (structural; never throws). */
export function isSellableCatalogRow(value: unknown): value is SellableCatalogRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  const price = row['price'];
  if (typeof price !== 'object' || price === null) return false;
  const priceObj = price as Record<string, unknown>;
  return (
    typeof row['product_id'] === 'string' &&
    typeof row['sku'] === 'string' &&
    typeof row['name'] === 'string' &&
    typeof priceObj['amount'] === 'string' &&
    typeof priceObj['currency_code'] === 'string' &&
    typeof row['tax_category'] === 'string' &&
    typeof row['active'] === 'boolean' &&
    typeof row['row_cursor'] === 'string'
  );
}
