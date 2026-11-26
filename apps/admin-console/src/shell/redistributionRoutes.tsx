/**
 * RT-1601 redistribution proposals route registration. Mounts inside the protected layout route
 * (`/` → ProtectedArea → AppShell → <Outlet/>), behind RF-1's context gate, under the Inventory
 * section (the Inventory nav entry stays selected by its prefix match). Each page owns its
 * no-active-tenant prompt and its role gate; Backend-Core answers the non-disclosing 404 otherwise.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const RedistributionList = lazyPage(
  () => import("@/redistribution/RedistributionList"),
  "RedistributionList",
);
const RedistributionPage = lazyPage(
  () => import("@/redistribution/RedistributionPage"),
  "RedistributionPage",
);

export const redistributionRoutes = (
  <>
    <Route path="inventory/redistribution" element={<RedistributionList />} />
    <Route path="inventory/redistribution/:proposalId" element={<RedistributionPage />} />
  </>
);
