/**
 * RT-560 ERP connection & sync status route registration (spec 016 Phase A).
 * Mounts inside the protected layout (`/` → ProtectedArea → AppShell →
 * <Outlet/>), behind RF-1's context gate. Pure additive registration. The API
 * is the authority on who may read; the page and the sidebar entry mirror its
 * roles (owner / tenant_admin).
 *
 * RT-725 adds the ERPNext item and warehouse mappings as a child of the same
 * area, so the sidebar entry stays the one ERP entry.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const ErpMappings = lazyPage(() => import("@/erp-mappings/ErpMappings"), "ErpMappings");
const ErpStatus = lazyPage(() => import("@/erp-status/ErpStatus"), "ErpStatus");

export const erpStatusRoutes = (
  <>
    <Route path="erp-connection" element={<ErpStatus />} />
    <Route path="erp-connection/mappings" element={<ErpMappings />} />
  </>
);
