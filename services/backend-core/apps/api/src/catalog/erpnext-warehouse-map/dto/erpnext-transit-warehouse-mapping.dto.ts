/**
 * RT-1574 — the tenant transit warehouse mapping: its set request (strict Zod) and its wire projection.
 *
 * Mirrors `SetErpnextTransitWarehouseMappingRequest` and `ErpnextTransitWarehouseMapping`
 * (packages/contracts/openapi/catalog/erpnext-warehouse-map.yaml 1.2.0-draft). The transit row belongs to the tenant
 * (`purpose = 'transit'`, `store_id` NULL, migration 0125), so the projection has neither `store_id` nor `purpose`.
 */
import { z } from "zod";

/** Strict (§XII): only the Warehouse reference; tenant, purpose, version and actor are server-resolved. */
export const SetErpnextTransitWarehouseMappingRequestSchema = z
  .object({
    erpnext_warehouse_ref: z.string().min(1).max(180),
  })
  .strict();

export type SetErpnextTransitWarehouseMappingRequestDto = z.infer<
  typeof SetErpnextTransitWarehouseMappingRequestSchema
>;

/** The service row shape (camelCase) of the tenant's transit mapping. */
export interface ErpnextTransitWarehouseMapRow {
  readonly id: string;
  readonly erpnextWarehouseRef: string;
  readonly version: number;
  readonly setBy: string | null;
  readonly setAt: Date;
  readonly retiredAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The wire body (snake_case, §IV). */
export interface ErpnextTransitWarehouseMappingBody {
  readonly id: string;
  readonly erpnext_warehouse_ref: string;
  readonly version: number;
  readonly set_by: string | null;
  readonly set_at: string;
  readonly retired_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export function toErpnextTransitWarehouseMapping(row: ErpnextTransitWarehouseMapRow): ErpnextTransitWarehouseMappingBody {
  return {
    id: row.id,
    erpnext_warehouse_ref: row.erpnextWarehouseRef,
    version: row.version,
    set_by: row.setBy,
    set_at: row.setAt.toISOString(),
    retired_at: row.retiredAt === null ? null : row.retiredAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
