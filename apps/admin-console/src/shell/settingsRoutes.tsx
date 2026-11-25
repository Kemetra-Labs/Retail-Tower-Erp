/**
 * RF-7 (spec 016) route registration: the Settings destination at `/settings`,
 * inside the protected layout behind RF-1's context gate. A thin hub over the
 * tenant sections that already exist (branding, cash policy, AI plan,
 * tracked selling); listed in the sidebar's Management group for owner /
 * tenant_admin (settingsLogic).
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const SettingsPage = lazyPage(() => import("@/settings/SettingsPage"), "SettingsPage");

export const settingsRoutes = <Route path="settings" element={<SettingsPage />} />;
