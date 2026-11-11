/**
 * Pre-authentication of `posQuarantineSale` callers (RT-1312 Phase 3(b),
 * decision P5; the RT-1295 rule for a raised body limit).
 *
 * `registerJsonBodyParsers` reads a quarantine upload body of up to 256 kB
 * before Nest runs the route's guard. For a large body (above 100 kB, chunked
 * or compressed) this authorizer runs the route's own guard,
 * `PosDeviceAuthGuard`, on the request headers first, so only a live paired
 * device can make the API buffer more than the 100 kB every route accepts. The
 * route's guard still runs again after parsing; this is an early gate, not a
 * replacement. A refusal is the guard's own non-disclosing 401.
 *
 * The guard reads route metadata (`@ReportsBuildIdentity`) through
 * `getHandler()` / `getClass()`. There is no route yet here, so the context
 * hands it an empty function with no metadata: the guard then treats the
 * request as a non-reporting operation, which `posQuarantineSale` is.
 */
import type { SnapshotCallerAuthorizer } from "../common/json-body-limits";
import type { DeviceRepository } from "../pos-operators/device.repository";
import { PosDeviceAuthGuard } from "./pos-device-auth.guard";
import { preRouteHttpContext } from "./pre-route-context";

/** A function that carries no Nest metadata, standing in for the not-yet-routed handler and class. */
function noRoute(): void {
  return undefined;
}

/** The production `authorizeQuarantineUpload` for `registerJsonBodyParsers` (main.ts). */
export function posDeviceCallerAuthorizer(devices: DeviceRepository): SnapshotCallerAuthorizer {
  const guard = new PosDeviceAuthGuard(devices);
  return async (req, res) => {
    await guard.canActivate(preRouteHttpContext(req, res, () => noRoute));
  };
}
