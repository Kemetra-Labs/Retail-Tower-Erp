/**
 * RT-728 inventory read-view route registration. Mounts inside the protected
 * layout (`/` → ProtectedArea → AppShell → <Outlet/>), behind RF-1's context
 * gate. Pure additive registration. The API is the authority on who may read
 * (non-disclosing 404 outside the caller's stores); the pages and the sidebar
 * entry mirror the console read roles. The product page is reached from a
 * movement row, never from a free-text product id.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const InventoryProduct = lazyPage(() => import("@/inventory/InventoryProduct"), "InventoryProduct");
const InventoryStore = lazyPage(() => import("@/inventory/InventoryStore"), "InventoryStore");
const InventoryStores = lazyPage(() => import("@/inventory/InventoryStores"), "InventoryStores");

export const inventoryRoutes = (
  <>
    <Route path="inventory" element={<InventoryStores />} />
    <Route path="inventory/stores/:storeId" element={<InventoryStore />} />
    <Route path="inventory/stores/:storeId/products/:productId" element={<InventoryProduct />} />
  </>
);
