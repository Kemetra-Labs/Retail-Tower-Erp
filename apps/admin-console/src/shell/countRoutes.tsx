/**
 * RT-1425 Count Session route registration. Mounts inside the protected layout
 * behind RF-1's context gate, beside the inventory routes it hangs off: a store's
 * counts (list and open) and one session. The API is the authority on who may use
 * them (non-disclosing 404 outside the caller's stores); the pages mirror the
 * inventory read roles.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const CountSessions = lazyPage(() => import("@/count-sessions/CountSessions"), "CountSessions");
const CountSessionDetail = lazyPage(
  () => import("@/count-sessions/CountSessionPage"),
  "CountSessionDetail",
);

export const countRoutes = (
  <>
    <Route path="inventory/stores/:storeId/counts" element={<CountSessions />} />
    <Route path="inventory/stores/:storeId/counts/:sessionId" element={<CountSessionDetail />} />
  </>
);
