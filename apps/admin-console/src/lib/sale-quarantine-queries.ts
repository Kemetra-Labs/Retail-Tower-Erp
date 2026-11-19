import { apiClient } from "@/generated/client";
import type { SaleSyncOpsSchema } from "@/generated/schema";
/**
 * RT-1312 (Phase 3(b) slice B) data layer: typed wrappers over the generated `apiClient` for the
 * three quarantine operations the Console uses, from the Backend-Core sale sync-ops contract
 * (`sale-sync-ops/sale-sync-ops.yaml` 1.3.0-draft):
 *
 *   - `consoleListQuarantinedSales`: sales a till could not get Backend-Core to accept, keyset paged.
 *   - `consoleGetQuarantinedSale`: one item, any state.
 *   - `consoleWriteOffQuarantinedSale`: the one write, closing an open item without a sale.
 *     `Idempotency-Key` is required; the caller owns the key.
 *
 * Not here: `consoleRepairQuarantinedSale` (slice C, still contract-only). These are NOT the
 * ERP-sync dead-letter wrappers of `sale-sync-ops-queries.ts` (RT-726): a quarantined sale has no
 * `sales` row. Boundary: Backend-Core only. No POS route, no ERP call. Cookie transport is on the
 * generated client.
 */
import { resultOf } from "@/lib/api-result";

type Schemas = SaleSyncOpsSchema.components["schemas"];

export type QuarantinedSale = Schemas["QuarantinedSale"];
export type QuarantinedSalePage = Schemas["QuarantinedSalePage"];
export type QuarantineListQuery = NonNullable<
  SaleSyncOpsSchema.operations["consoleListQuarantinedSales"]["parameters"]["query"]
>;

/** GET /api/v1/catalog/sale-sync-ops/quarantined-sales */
export async function consoleListQuarantinedSales(query: QuarantineListQuery) {
  return resultOf(
    await apiClient.GET("/api/v1/catalog/sale-sync-ops/quarantined-sales", {
      params: { query },
    }),
  );
}

/** GET /api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef} */
export async function consoleGetQuarantinedSale(quarantineRef: string) {
  return resultOf(
    await apiClient.GET("/api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}", {
      params: { path: { quarantineRef } },
    }),
  );
}

/**
 * POST /api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}/write-off. Sent once per
 * operator confirmation, never retried here. The same key with the same note replays the stored
 * outcome; the same key with a different note is a 409, so the caller binds the key to the note.
 */
export async function consoleWriteOffQuarantinedSale(
  quarantineRef: string,
  note: string,
  idempotencyKey: string,
) {
  return resultOf(
    await apiClient.POST(
      "/api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}/write-off",
      {
        params: { path: { quarantineRef }, header: { "Idempotency-Key": idempotencyKey } },
        body: { note },
      },
    ),
  );
}
