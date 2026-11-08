/**
 * RT-455 part 1 data layer: typed wrappers over the generated `apiClient` for
 * the tenant's tracked-selling switch (`inventory/inventory.yaml` 1.12.0-draft,
 * RT-451 S2; runtime on `main` since #434):
 *
 *   - `getTrackedSellingSetting`: on/off, the last change and the unmet RT-50
 *     Q13 preconditions. A store_manager reads on/off only (OD-T6). While the
 *     deployment gate `POS_TRACKED_SELLING_ENABLED` is off it answers the
 *     non-disclosing 404.
 *   - `setTrackedSellingSetting`: owner or tenant_admin; switching on can be
 *     refused with 409 `tracked_selling_preconditions_unmet`, switching off is
 *     always accepted (OD-T3). Setting the current value again is a no-op, so a
 *     repeat after a lost answer is safe.
 *
 * Same `{ status, data?, error?, retryAfter? }` shape as `tracking-queries.ts`.
 */
import { apiClient } from "@/generated/client";
import type { InventorySchema } from "@/generated/schema";
import { resultOf } from "@/lib/inventory-queries";

type Schemas = InventorySchema.components["schemas"];

export type TrackedSellingSetting = Schemas["TrackedSellingSetting"];
export type TrackedSellingPrecondition = Schemas["TrackedSellingPrecondition"];
export type SetTrackedSellingCommand = Schemas["SetTrackedSellingSettingCommand"];

/** GET /api/inventory/v1/settings/tracked-selling */
export async function getTrackedSellingSetting() {
  return resultOf(await apiClient.GET("/api/inventory/v1/settings/tracked-selling"));
}

/** PUT /api/inventory/v1/settings/tracked-selling */
export async function setTrackedSellingSetting(body: SetTrackedSellingCommand) {
  return resultOf(await apiClient.PUT("/api/inventory/v1/settings/tracked-selling", { body }));
}
