/**
 * RT-726 sale sync-ops route registration (spec 032 §9). Mounts inside the
 * protected layout (`/` → ProtectedArea → AppShell → <Outlet/>), behind RF-1's
 * context gate. Pure additive registration. The API is the authority on who
 * may read; the page and the sidebar entry mirror its roles (owner /
 * tenant_admin). The sync status, timeline and repair live on the sale detail.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const NeedsRepairList = lazyPage(() => import("@/sale-sync/NeedsRepairList"), "NeedsRepairList");

export const saleSyncRoutes = <Route path="sales-needing-repair" element={<NeedsRepairList />} />;
