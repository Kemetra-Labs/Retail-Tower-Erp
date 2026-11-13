/**
 * RT-1350 slice 5a data layer: one typed wrapper over the generated `apiClient` for
 * the tenant access state the Console banner reads (RT-1353 contract):
 *
 *   - `consoleGetTenantAccessEntitlement`: GET /api/v1/tenants/{tenant_id}/access-entitlement
 *
 * Boundary: the two platform-admin writes in the same document
 * (`platformRequestTenantUnlock`, `platformMarkTenantProvisioned`) are not wrapped
 * here; the Platform Console slice (6b) owns them. The Console never decides access:
 * it shows the server's state. Same `{ status, data, error }` shape as
 * `src/lib/ai-entitlements-queries.ts`; cookie transport is on the generated client.
 */
import { apiClient } from "@/generated/client";

/** Owner, tenant_admin and store_manager may read it; others get a 404. */
export async function consoleGetTenantAccessEntitlement(tenantId: string) {
  const { data, error, response } = await apiClient.GET(
    "/api/v1/tenants/{tenant_id}/access-entitlement",
    { params: { path: { tenant_id: tenantId } } },
  );
  return { status: response.status, data, error };
}
