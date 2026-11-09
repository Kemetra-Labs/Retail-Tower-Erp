/**
 * RT-1304 data layer: the ONE wrapped operation of the Backend-Core POS pilot release
 * resolver (`pos-pilot-releases.openapi.yaml`, RT-1292): `consolePilotGetLatestPosRelease`.
 * The platform allowlist and registry operations in the same document are composed in
 * the generated client but never called here.
 *
 * Every eligible call issues a NEW presigned link, writes an audit row and spends the
 * write-class rate budget, so a caller must invoke it only from an explicit activation.
 * It is sent once: no retry, no cache. `downloadUrl` is a bearer capability: this
 * wrapper returns it to the caller and never logs, stores or forwards it.
 *
 * Same `{ status, data?, error?, retryAfter? }` shape as `src/lib/erp-mapping-queries.ts`;
 * cookie transport is on the generated client. No hand-rolled fetch.
 */
import { apiClient } from "@/generated/client";
import type { PosPilotReleasesSchema } from "@/generated/schema";
import { classifyRateLimit } from "@/lib/rate-limit";

type Schemas = PosPilotReleasesSchema.components["schemas"];

type LatestPilotRelease = Schemas["LatestPilotRelease"];

export interface LatestPilotReleaseResult {
  status: number;
  data?: LatestPilotRelease;
  error?: unknown;
  /** The 429 wait in seconds (shared RT-621 classifier), when sent. */
  retryAfter?: number;
}

/** GET /api/v1/pos-pilot-releases/latest. A request that gets no answer rejects. */
export async function consolePilotGetLatestPosRelease(): Promise<LatestPilotReleaseResult> {
  const { data, error, response } = await apiClient.GET("/api/v1/pos-pilot-releases/latest");
  const result: LatestPilotReleaseResult = { status: response.status, data, error };
  const wait = classifyRateLimit({
    status: response.status,
    retryAfter: response.headers.get("Retry-After"),
  })?.retryAfterSeconds;
  if (wait !== undefined) result.retryAfter = wait;
  return result;
}
