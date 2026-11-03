/**
 * RT-455 route registration: the tracking holds screen and one tracking
 * identity's detail, inside the protected layout behind RF-1's context gate.
 * The API is the authority on who may read; the pages mirror its roles. The
 * identity detail is reached from a hold row or a product's batch table.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const TrackingHolds = lazyPage(() => import("@/tracking/TrackingHolds"), "TrackingHolds");
const TrackingIdentityDetail = lazyPage(
  () => import("@/tracking/TrackingIdentityDetail"),
  "TrackingIdentityDetail",
);

export const trackingRoutes = (
  <>
    <Route path="tracking" element={<TrackingHolds />} />
    <Route path="tracking/identities/:identityId" element={<TrackingIdentityDetail />} />
  </>
);
