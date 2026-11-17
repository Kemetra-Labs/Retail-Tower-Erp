/**
 * Data layer for the owner's store deletion (RT-1437 A2; RT-1441 U2): typed wrappers over the
 * generated `apiClient`, the same `{ status, data?, error? }` shape as `src/lib/force-action-queries.ts`.
 * Cookie transport is on the generated client; no hand-rolled fetch.
 *
 *   - `previewStoreDeletion`: what deleting the store would change, and the guards that refuse it
 *     now. A snapshot, not a reservation: the delete decides again, and the fingerprint it carries
 *     is the preview's. Owner only: a `tenant_admin` is 403 `store_deletion_owner_only`.
 *   - `consoleReauthenticate`: the password re-entry (D2b). Answers a single-use grant, valid for
 *     5 minutes and bound to this session and store. The password goes in the body and nowhere else.
 *   - `consoleDeleteStore`: the delete. `Idempotency-Key` is required; the answer carries
 *     `Idempotent-Replayed: true` on a replay of a recorded delete.
 *
 * The Console decides nothing here: every verdict, blocker and effect is the server's.
 */
import { apiClient } from "@/generated/client";
import type { StoresSchema } from "@/generated/schema";

type StoreSchemas = StoresSchema.components["schemas"];

export type StoreDeletionPreview = StoreSchemas["StoreDeletionPreview"];
export type StoreDeletionRequest = StoreSchemas["StoreDeletionRequest"];

/** GET /api/v1/stores/{store_id}/deletion-preview: read-only, owner only. */
export async function previewStoreDeletion(storeId: string) {
  const { data, error, response } = await apiClient.GET(
    "/api/v1/stores/{store_id}/deletion-preview",
    { params: { path: { store_id: storeId } } },
  );
  return { status: response.status, data, error };
}

/** POST /api/v1/auth/reauth: the grant for one store deletion (purpose `store_deletion`). */
export async function consoleReauthenticate(storeId: string, password: string) {
  const { data, error, response } = await apiClient.POST("/api/v1/auth/reauth", {
    body: { purpose: "store_deletion", storeId, password },
  });
  return { status: response.status, data, error };
}

/** POST /api/v1/stores/{store_id}/deletion: 200 on the first delete and on a same-key replay. */
export async function consoleDeleteStore(
  storeId: string,
  body: StoreDeletionRequest,
  idempotencyKey: string,
) {
  const { data, error, response } = await apiClient.POST("/api/v1/stores/{store_id}/deletion", {
    params: { path: { store_id: storeId }, header: { "Idempotency-Key": idempotencyKey } },
    body,
  });
  return {
    status: response.status,
    data,
    error,
    replayed: response.headers.get("Idempotent-Replayed") === "true",
  };
}
