/**
 * RT-178 ERPNext stock discrepancy route registration. Mounts inside the
 * protected layout (`/` → ProtectedArea → AppShell → <Outlet/>), behind RF-1's
 * context gate. Pure additive registration. The API is the authority on who
 * may read (non-disclosing 404 otherwise); the sidebar entry mirrors its roles.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const StockDiscrepancyStore = lazyPage(
  () => import("@/stock-discrepancies/StockDiscrepancyStore"),
  "StockDiscrepancyStore",
);
const StockDiscrepancyStores = lazyPage(
  () => import("@/stock-discrepancies/StockDiscrepancyStores"),
  "StockDiscrepancyStores",
);

export const stockDiscrepancyRoutes = (
  <>
    <Route path="stock-discrepancies" element={<StockDiscrepancyStores />} />
    <Route path="stock-discrepancies/:storeId" element={<StockDiscrepancyStore />} />
  </>
);
