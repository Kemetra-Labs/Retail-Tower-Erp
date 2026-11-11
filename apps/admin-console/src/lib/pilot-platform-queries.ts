/**
 * RT-1329: the platform-admin operations of `pos-pilot-releases.openapi.yaml`
 * behind the Platform Console "POS pilot" page: two reads (RT-1328) and three
 * writes (activate a release, add and remove an allowlisted tenant).
 *
 * This file never calls the tenant resolver (`consolePilotGetLatestPosRelease`,
 * src/lib/pilot-release-queries.ts): nothing here issues a presigned URL. There
 * is no Withdraw: it is the promotion workflow's OIDC-only operation (D-5a).
 *
 * Each call goes through the generated client (cookie transport, the auth
 * interceptor and the RT-621 rate-limit tracking). A write is sent once: the
 * query client never retries a mutation. `rateLimitSeq` is the 429's own count
 * on the shared clock, for the page to claim (RT-931, RT-940).
 */
import { apiClient } from "@/generated/client";
import type { PilotReleaseList, PilotTenantList } from "./pilot-platform-types";
import { rateLimitSeqOf } from "./rate-limit";

export interface PilotCallResult<D> {
  status: number;
  data?: D;
  error?: unknown;
  rateLimitSeq?: number;
}

/** GET /api/v1/platform/pos-pilot-releases (`platformListPilotReleases`). */
export async function platformListPilotReleases(): Promise<PilotCallResult<PilotReleaseList>> {
  const { data, error, response } = await apiClient.GET("/api/v1/platform/pos-pilot-releases");
  return { status: response.status, data, error, rateLimitSeq: rateLimitSeqOf(response) };
}

/** GET /api/v1/platform/pos-pilot-tenants (`platformListPilotTenants`). */
export async function platformListPilotTenants(): Promise<PilotCallResult<PilotTenantList>> {
  const { data, error, response } = await apiClient.GET("/api/v1/platform/pos-pilot-tenants");
  return { status: response.status, data, error, rateLimitSeq: rateLimitSeqOf(response) };
}

/** POST /api/v1/platform/pos-pilot-releases/{releaseId}/activate. No body. */
export async function platformActivatePilotRelease(releaseId: string) {
  const { error, response } = await apiClient.POST(
    "/api/v1/platform/pos-pilot-releases/{releaseId}/activate",
    { params: { path: { releaseId } } },
  );
  return { status: response.status, error, rateLimitSeq: rateLimitSeqOf(response) };
}

/** PUT /api/v1/platform/pos-pilot-tenants/{tenantId}: 201 added, 200 already listed. */
export async function platformAddPilotTenant(tenantId: string) {
  const { error, response } = await apiClient.PUT("/api/v1/platform/pos-pilot-tenants/{tenantId}", {
    params: { path: { tenantId } },
  });
  return { status: response.status, error, rateLimitSeq: rateLimitSeqOf(response) };
}

/** DELETE /api/v1/platform/pos-pilot-tenants/{tenantId}: 204 either way. */
export async function platformRemovePilotTenant(tenantId: string) {
  const { error, response } = await apiClient.DELETE(
    "/api/v1/platform/pos-pilot-tenants/{tenantId}",
    { params: { path: { tenantId } } },
  );
  return { status: response.status, error, rateLimitSeq: rateLimitSeqOf(response) };
}
