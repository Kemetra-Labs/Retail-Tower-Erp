/**
 * RT-18 shift-close review route registration. Mounts inside the protected
 * layout (`/` → ProtectedArea → AppShell → <Outlet/>), behind RF-1's context
 * gate. Pure additive registration. The API is the authority on who may read
 * (non-disclosing 404 otherwise); the sidebar entry mirrors its roles.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const ShiftCloseDetail = lazyPage(
  () => import("@/shift-closes/ShiftCloseDetail"),
  "ShiftCloseDetail",
);
const ShiftCloseList = lazyPage(() => import("@/shift-closes/ShiftCloseList"), "ShiftCloseList");

export const shiftCloseRoutes = (
  <>
    <Route path="shift-closes" element={<ShiftCloseList />} />
    <Route path="shift-closes/:shiftId" element={<ShiftCloseDetail />} />
  </>
);
