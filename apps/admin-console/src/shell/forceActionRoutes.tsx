/**
 * RT-1440 (U1) route registration for the open shifts of a store. Mounts inside the protected
 * layout behind RF-1's context gate. The API is the authority on who may read (the uniform 404
 * for everyone but an owner or an all-store tenant_admin); the page reads as "not available".
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const OpenShiftsPage = lazyPage(() => import("@/force-actions/OpenShiftsPage"), "OpenShiftsPage");
const ForceClosedPage = lazyPage(() => import("@/force-actions/ForceClosedPage"), "ForceClosedPage");

export const forceActionRoutes = (
  <>
    <Route path="stores/:storeId/open-shifts" element={<OpenShiftsPage />} />
    <Route path="shifts/force-closed" element={<ForceClosedPage />} />
  </>
);
