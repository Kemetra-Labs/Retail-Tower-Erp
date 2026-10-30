/**
 * RT-727 ERPNext product-master reconciliation route registration. Mounts
 * inside the protected layout (`/` → ProtectedArea → AppShell → <Outlet/>),
 * behind RF-1's context gate. Pure additive registration. The API is the
 * authority on who may use it (a non-disclosing 404 otherwise); the page and
 * the sidebar entry mirror its roles (owner / tenant_admin).
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const ProductReconciliation = lazyPage(
  () => import("@/product-reconciliation/ProductReconciliation"),
  "ProductReconciliation",
);
const RunResults = lazyPage(() => import("@/product-reconciliation/RunResults"), "RunResults");

export const productReconciliationRoutes = (
  <>
    <Route path="product-reconciliation" element={<ProductReconciliation />} />
    <Route path="product-reconciliation/runs/:runId" element={<RunResults />} />
  </>
);
