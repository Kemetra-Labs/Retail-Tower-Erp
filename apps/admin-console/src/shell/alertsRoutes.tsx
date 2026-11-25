import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const AlertsPage = lazyPage(() => import("@/alerts/AlertsPage"), "AlertsPage");

export const alertsRoutes = <Route path="alerts" element={<AlertsPage />} />;
