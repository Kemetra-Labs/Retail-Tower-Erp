/**
 * RT-1109 vouchers route registration. Mounts inside the protected layout route
 * (`/` → ProtectedArea → AppShell → <Outlet/>), behind RF-1's context gate. The
 * VoucherList surface owns its no-active-tenant prompt and its role gate.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const VoucherList = lazyPage(() => import("@/vouchers/VoucherList"), "VoucherList");

export const voucherRoutes = <Route path="vouchers" element={<VoucherList />} />;
