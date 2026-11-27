import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const ForgotPassword = lazyPage(() => import("@/auth/ForgotPassword"), "ForgotPassword");
const ResetPassword = lazyPage(() => import("@/auth/ResetPassword"), "ResetPassword");

/**
 * Public password-recovery routes (RT-1497, security: []) — lazy-loaded
 * siblings of `/signin` and `/accept-invitation`.
 */
export const passwordResetRoutes = (
  <>
    <Route path="/forgot-password" element={<ForgotPassword />} />
    <Route path="/reset-password" element={<ResetPassword />} />
  </>
);
