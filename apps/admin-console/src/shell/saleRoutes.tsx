/**
 * RT-587 sales route registration (spec 012). Mounts inside the protected
 * layout (`/` → ProtectedArea → AppShell → <Outlet/>), behind RF-1's context
 * gate. Pure additive registration. The API is the authority on who may read
 * (non-disclosing 404 otherwise); the sidebar entry mirrors its roles.
 * RT-821: the daily received-sales report is a Sales sibling (RT-751 D6),
 * reached from the Sales screen, not from its own sidebar entry (UX-09).
 * RT-1020: the Reports index (`/reports`) is the one sidebar entry that lists
 * it, with the review screens and the proposed reports.
 * RT-1054: the sales-by-store report (`/sales-by-store`) is listed there too.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const ReportsIndex = lazyPage(() => import("@/reports/ReportsIndex"), "ReportsIndex");
const SalesByStore = lazyPage(() => import("@/sales-by-store/SalesByStore"), "SalesByStore");
const SalesDaily = lazyPage(() => import("@/sales-daily/SalesDaily"), "SalesDaily");
const SaleDetail = lazyPage(() => import("@/sales/SaleDetail"), "SaleDetail");
const SaleList = lazyPage(() => import("@/sales/SaleList"), "SaleList");

export const saleRoutes = (
  <>
    <Route path="sales" element={<SaleList />} />
    <Route path="sales/:saleRef" element={<SaleDetail />} />
    <Route path="reports" element={<ReportsIndex />} />
    <Route path="sales-daily" element={<SalesDaily />} />
    <Route path="sales-by-store" element={<SalesByStore />} />
  </>
);
