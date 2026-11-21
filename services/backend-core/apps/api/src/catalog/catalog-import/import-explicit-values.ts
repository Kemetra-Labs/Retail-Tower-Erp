/**
 * RT-1507 / RT-1536 (spec 049 section 8.2): the values the rows of one product state, for the plan's conflict detection. ONE
 * function for the publish and the preview, so the preview names exactly the conflicts the publish refuses.
 */
import type { PoolClient } from "pg";

import type { BatchRow } from "./catalog-import.projections";
import { loadRowCells, type LoadedPlanRow } from "./catalog-import.publish-repository";
import type { ColumnMapping } from "./import-mapping";
import { parseRows } from "./import-row-parse";

/**
 * What each row that shares its product with another row states for it, field by field (as the field changes name them),
 * read from the staged cells through the same parse validate used. Only those rows' cells are read: a row alone on its
 * product cannot disagree with anyone.
 */
export async function explicitValues(client: PoolClient, tenantId: string, batch: BatchRow, rows: readonly LoadedPlanRow[]): Promise<Map<number, Record<string, string>>> {
  const perProduct = new Map<string, number[]>();
  for (const r of rows) {
    if ((r.status !== "ready_update" && r.status !== "unchanged") || r.outcome.matchedProduct === null) continue;
    const id = r.outcome.matchedProduct.productId;
    const numbers = perProduct.get(id);
    if (numbers === undefined) perProduct.set(id, [r.rowNumber]);
    else numbers.push(r.rowNumber);
  }
  const shared = [...perProduct.values()].filter((numbers) => numbers.length > 1).flat();
  const cells = await loadRowCells(client, tenantId, batch.id, shared);
  const explicit = new Map<number, Record<string, string>>();
  for (const p of parseRows(batch.mapping as ColumnMapping[], cells)) {
    const values: Record<string, string> = {};
    if (p.name !== null) values["name"] = p.name.value;
    if (p.description !== null) values["description"] = p.description.value;
    if (p.category !== null) values["category"] = p.category.value;
    if (p.brand !== null) values["brand"] = p.brand.value;
    if (p.taxCategory !== null) values["tax_category"] = p.taxCategory.value;
    if (p.isActive !== null) values["is_active"] = String(p.isActive.value);
    explicit.set(p.rowNumber, values);
  }
  return explicit;
}
