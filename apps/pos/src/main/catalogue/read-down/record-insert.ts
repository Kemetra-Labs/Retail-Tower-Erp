/**
 * Shared row-insert for the catalogue read-down (010 + RT-1487).
 *
 * The snapshot path stages rows into `products_staging` / `product_barcodes_staging`
 * and promotes them; the RT-1487 delta path writes the same rows straight into the
 * live `products` / `product_barcodes` inside its own transaction. Both use this one
 * insert so the stored fold columns never drift between the two paths
 * (fold-parity with 009's query fold, SC-9).
 */

import type { DatabaseHandle } from '../../db/client.js';
import { normalize } from '../normalize.js';
import type { MappedRecord } from './map-sellable-row.js';

// Explicit live/staging column lists (NOT `SELECT *`) so the promote INSERT…SELECT
// can never silently misalign if a future migration reorders columns.
export const PRODUCT_COLUMNS = [
  'product_id',
  'tenant_id',
  'branch_id',
  'sku',
  'sku_norm',
  'name_ar',
  'name_en',
  'name_fold',
  'aliases_json',
  'alias_fold',
  'price_minor',
  'tax_category',
  'unit_pack_label',
  'active',
  'controlled_substance',
  'prescription_required',
  'row_version',
  'created_at',
  'updated_at',
] as const;

export const BARCODE_COLUMNS = [
  'barcode_id',
  'product_id',
  'tenant_id',
  'barcode',
  'barcode_norm',
  'barcode_kind',
  'created_at',
] as const;

interface PrepareRun {
  run(...params: unknown[]): unknown;
}

/**
 * R1 fold composition (verified against 009 `search.ts` — it LIKEs `name_fold`
 * and `alias_fold` as two separate columns, never concatenated):
 *   name_fold  = normalize(name_ar + ' ' + (name_en ?? ''))
 *   alias_fold = normalize(aliases.join(' '))  (null when no aliases)
 *   sku_norm / barcode_norm = normalize(raw value)
 */
function nameFold(nameAr: string, nameEn: string | null): string {
  return normalize(`${nameAr} ${nameEn ?? ''}`);
}

function aliasFold(aliasesJson: string | null): string | null {
  if (aliasesJson === null) return null;
  const aliases = JSON.parse(aliasesJson) as unknown;
  if (!Array.isArray(aliases) || aliases.length === 0) return null;
  return normalize((aliases as string[]).join(' '));
}

/** Writes one mapped record (product + its exploded barcodes), stamped with scope. */
export type RecordInsert = (tenantId: string, branchId: string, rec: MappedRecord) => void;

/**
 * Prepare the product + barcode INSERTs for one table pair ONCE and return a
 * per-record writer. The caller owns the transaction.
 */
export function prepareRecordInsert(
  db: DatabaseHandle,
  productTable: 'products' | 'products_staging',
  barcodeTable: 'product_barcodes' | 'product_barcodes_staging',
): RecordInsert {
  const productStmt = db.prepare(`
    INSERT INTO ${productTable} (${PRODUCT_COLUMNS.join(', ')})
    VALUES (${PRODUCT_COLUMNS.map(() => '?').join(', ')})
  `) as PrepareRun;
  const barcodeStmt = db.prepare(`
    INSERT INTO ${barcodeTable} (${BARCODE_COLUMNS.join(', ')})
    VALUES (${BARCODE_COLUMNS.map(() => '?').join(', ')})
  `) as PrepareRun;

  return (tenantId, branchId, rec) => {
    const p = rec.product;
    productStmt.run(
      p.product_id,
      tenantId,
      branchId,
      p.sku,
      normalize(p.sku),
      p.name_ar,
      p.name_en,
      nameFold(p.name_ar, p.name_en),
      p.aliases_json,
      aliasFold(p.aliases_json),
      p.price_minor,
      p.tax_category,
      p.unit_pack_label,
      p.active,
      p.controlled_substance,
      p.prescription_required,
      p.row_version,
      p.created_at,
      p.updated_at,
    );

    // Explode the barcode records (duplicates preserved — no dedupe, FR-4).
    for (const b of rec.barcodes) {
      barcodeStmt.run(
        b.barcode_id,
        b.product_id,
        tenantId,
        b.barcode,
        normalize(b.barcode),
        b.barcode_kind,
        p.created_at,
      );
    }
  };
}
