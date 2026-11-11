/**
 * RT-1329: the types of the POS pilot platform page. `PilotRelease` and
 * `PilotTenant` are the generated schemas of `pos-pilot-releases.openapi.yaml`.
 *
 * The two list envelopes are local until RT-1328 (the platform-admin reads
 * `platformListPilotReleases` and `platformListPilotTenants`) is merged and the
 * contracts pin moves to it. They follow the shape agreed with RT-1328:
 * 200 `{ items: PilotRelease[] }` and 200 `{ items: PilotTenant[] }`. Once the
 * generated client has both operations, these two interfaces and the cast in
 * pilot-platform-queries.ts are replaced by the generated types.
 */
import type { PosPilotReleasesSchema } from "@/generated/schema";

type Schemas = PosPilotReleasesSchema.components["schemas"];

export type PilotRelease = Schemas["PilotRelease"];
export type PilotTenant = Schemas["PilotTenant"];

/** GET /api/v1/platform/pos-pilot-releases (RT-1328), newest `registeredAt` first. */
export interface PilotReleaseList {
  items: PilotRelease[];
}

/** GET /api/v1/platform/pos-pilot-tenants (RT-1328). */
export interface PilotTenantList {
  items: PilotTenant[];
}
