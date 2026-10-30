/**
 * 017 payer-accounts route registration. Mounts inside the protected layout
 * route (`/` → ProtectedArea → AppShell → <Outlet/>), behind RF-1's context
 * gate. Pure additive route registration — one reviewable seam. The PayerList
 * surface owns its own no-active-tenant scope prompt.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const PayerList = lazyPage(() => import("@/payers/PayerList"), "PayerList");

export const payerRoutes = <Route path="payer-accounts" element={<PayerList />} />;
