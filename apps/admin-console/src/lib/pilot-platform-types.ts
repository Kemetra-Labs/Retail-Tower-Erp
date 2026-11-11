/**
 * RT-1329: the generated types of the POS pilot platform page, from
 * `pos-pilot-releases.openapi.yaml` (the two list envelopes are RT-1328's
 * `platformListPilotReleases` and `platformListPilotTenants`).
 */
import type { PosPilotReleasesSchema } from "@/generated/schema";

type Schemas = PosPilotReleasesSchema.components["schemas"];

export type PilotRelease = Schemas["PilotRelease"];
export type PilotTenant = Schemas["PilotTenant"];
/** 200 of GET /api/v1/platform/pos-pilot-releases, newest `registeredAt` first. */
export type PilotReleaseList = Schemas["PilotReleaseList"];
/** 200 of GET /api/v1/platform/pos-pilot-tenants. */
export type PilotTenantList = Schemas["PilotTenantList"];
