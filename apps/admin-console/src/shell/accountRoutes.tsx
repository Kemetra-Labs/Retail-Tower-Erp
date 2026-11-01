/**
 * RT-807 (PW-1) route registration: the «حسابي» page at `/account`, inside the
 * protected layout behind RF-1's context gate. Reached from the user menu, not
 * from the sidebar, so no navigation entry is selected on it.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const AccountPage = lazyPage(() => import("@/account/AccountPage"), "AccountPage");

export const accountRoutes = <Route path="account" element={<AccountPage />} />;
