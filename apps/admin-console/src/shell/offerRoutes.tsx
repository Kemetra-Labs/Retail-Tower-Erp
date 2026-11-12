/**
 * RT-1338 offers and brands route registration. Mounts inside the protected layout route
 * (`/` → ProtectedArea → AppShell → <Outlet/>), behind RF-1's context gate. Each surface owns its
 * no-active-tenant prompt and its role gate. `offers/new` is a static segment, so it wins over
 * `offers/:offerId`. «العلامات التجارية» sits beside the items it classifies.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const OfferList = lazyPage(() => import("@/offers/OfferList"), "OfferList");
const OfferPage = lazyPage(() => import("@/offers/OfferPage"), "OfferPage");
const BrandList = lazyPage(() => import("@/brands/BrandList"), "BrandList");

export const offerRoutes = (
  <>
    <Route path="offers" element={<OfferList />} />
    <Route path="offers/new" element={<OfferPage />} />
    <Route path="offers/:offerId" element={<OfferPage />} />
    <Route path="catalog/brands" element={<BrandList />} />
  </>
);
