/**
 * Data layer for the Console force actions on a shift (RT-1437 A1; RT-1440 U1): typed wrappers
 * over the generated `apiClient`, the same `{ status, data?, error? }` shape as
 * `src/lib/device-queries.ts`. Cookie transport is on the generated client; no hand-rolled fetch.
 *
 *   - `consoleListOpenShifts`: every open shift of a store with the server's verdict (D6).
 *   - `consoleGetForceClosePreview`: what a force close of one shift would change. A snapshot,
 *     not a reservation: the write decides again, and the fingerprint it carries is the preview's.
 *   - `consoleForceCloseShift`: the close, as NOT COUNTED. `Idempotency-Key` is required.
 *
 * The Console decides nothing here: every verdict, blocker and effect is the server's.
 */
import { apiClient } from "@/generated/client";
import type { ConsoleForceActionsSchema } from "@/generated/schema";

type Schemas = ConsoleForceActionsSchema.components["schemas"];

export type OpenShiftList = Schemas["OpenShiftList"];
export type OpenShiftSummary = Schemas["OpenShiftSummary"];
export type ForceClosePreview = Schemas["ForceClosePreview"];
export type ConsoleForceCloseRequest = Schemas["ConsoleForceCloseRequest"];

/** GET /api/v1/stores/{store_id}/open-shifts: owner or all-store tenant_admin; else the uniform 404. */
export async function consoleListOpenShifts(storeId: string) {
  const { data, error, response } = await apiClient.GET("/api/v1/stores/{store_id}/open-shifts", {
    params: { path: { store_id: storeId } },
  });
  return { status: response.status, data, error };
}

/** GET /api/v1/shifts/{shift_id}/force-close-preview: read-only; a finished shift is previewed too. */
export async function consoleGetForceClosePreview(shiftId: string) {
  const { data, error, response } = await apiClient.GET(
    "/api/v1/shifts/{shift_id}/force-close-preview",
    { params: { path: { shift_id: shiftId } } },
  );
  return { status: response.status, data, error };
}

/** POST /api/v1/shifts/{shift_id}/force-close: idempotent per shift and reason; 201 first, 200 replay. */
export async function consoleForceCloseShift(
  shiftId: string,
  body: ConsoleForceCloseRequest,
  idempotencyKey: string,
) {
  const { data, error, response } = await apiClient.POST("/api/v1/shifts/{shift_id}/force-close", {
    params: { path: { shift_id: shiftId }, header: { "Idempotency-Key": idempotencyKey } },
    body,
  });
  return { status: response.status, data, error };
}
