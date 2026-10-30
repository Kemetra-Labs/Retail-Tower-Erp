/**
 * RF-5 nested route registration (T015). Mounts inside the protected layout
 * route (`/` → ProtectedArea → AppShell → <Outlet/>), behind RF-1's context
 * gate. The public accept-invitation route (SF5-4) is NOT here — it registers in
 * App.tsx alongside `/signin`, outside the gate (`security: []`).
 *
 * One reviewable seam per slice (sibling of rf2Routes).
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const MemberList = lazyPage(() => import("@/operators/MemberList"), "MemberList");

export const rf5Routes = <Route path="operators" element={<MemberList />} />;
