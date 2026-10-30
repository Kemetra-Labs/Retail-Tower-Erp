/**
 * RT-765 / RT-766 catalog route registration (CAT-C1a, CAT-C1b). Mounts inside
 * the protected layout (`/` → ProtectedArea → AppShell → <Outlet/>), behind
 * RF-1's context gate. Pure additive registration. The API is the authority on
 * who may read (non-disclosing 404 otherwise); the sidebar entry mirrors its
 * roles. The product detail is a full, deep-linkable page (RT-752 D3), and the
 * edit form is its own route under it (RT-768). There is NO `/new` route: product
 * create is held by owner decision D9 (RT-768 comment 13487) until pricing lands
 * (RT-484 / RT-485). «الأصناف» stays selected on every child route (NavLink prefix
 * match).
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const CatalogProductDetail = lazyPage(
  () => import("@/catalog/CatalogProductDetail"),
  "CatalogProductDetail",
);
const CatalogProductEdit = lazyPage(
  () => import("@/catalog/CatalogProductEdit"),
  "CatalogProductEdit",
);
const CatalogProductList = lazyPage(
  () => import("@/catalog/CatalogProductList"),
  "CatalogProductList",
);

export const catalogRoutes = (
  <>
    <Route path="catalog/products" element={<CatalogProductList />} />
    <Route path="catalog/products/:productId" element={<CatalogProductDetail />} />
    <Route path="catalog/products/:productId/edit" element={<CatalogProductEdit />} />
  </>
);
