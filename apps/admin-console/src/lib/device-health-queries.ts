/**
 * RT-1312 data layer: the two Console reads of Backend-Core POS device health
 * (`pos-device-health.openapi.yaml`, RT-327): `consoleListDeviceHealth` and
 * `consoleGetDeviceHealth`. They are read here only for the till's unsent sale
 * counts (`saleQueue`, as of the device's last stored heartbeat). The heartbeat
 * and the platform version-policy operations in the same document are composed
 * in the generated client but never called here.
 *
 * Roles `owner`, `tenant_admin`, `store_manager`; anything outside the caller's
 * scope is the same non-disclosing 404. Same `{ status, data?, error? }` shape as
 * `src/lib/device-queries.ts`; cookie transport is on the generated client. No
 * hand-rolled fetch.
 */
import { apiClient } from "@/generated/client";
import type { PosDeviceHealthSchema } from "@/generated/schema";

type Schemas = PosDeviceHealthSchema.components["schemas"];

export type DeviceHealthView = Schemas["DeviceHealthView"];
export type DeviceHealthPage = Schemas["DeviceHealthPage"];
export type DeviceHealthListQuery = NonNullable<
  PosDeviceHealthSchema.operations["consoleListDeviceHealth"]["parameters"]["query"]
>;

/** GET /api/v1/device-health: one keyset page, by `deviceId` ascending. */
export async function consoleListDeviceHealth(query: DeviceHealthListQuery = {}) {
  const { data, error, response } = await apiClient.GET("/api/v1/device-health", {
    params: { query },
  });
  return { status: response.status, data, error };
}

/** GET /api/v1/device-health/{deviceId}: a refusal is the same non-disclosing 404. */
export async function consoleGetDeviceHealth(deviceId: string) {
  const { data, error, response } = await apiClient.GET("/api/v1/device-health/{deviceId}", {
    params: { path: { deviceId } },
  });
  return { status: response.status, data, error };
}
