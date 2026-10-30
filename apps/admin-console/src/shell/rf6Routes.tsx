/**
 * RF-6 nested route registration (T009). Mounts inside the protected layout
 * route (`/` → ProtectedArea → AppShell → <Outlet/>), behind RF-1's context
 * gate (FR-006-005). The `<Outlet/>` already exists from slice 004, so this is
 * pure additive route registration. One reviewable seam per slice.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const AuditSearch = lazyPage(() => import("@/audit/AuditSearch"), "AuditSearch");

export const rf6Routes = <Route path="audit" element={<AuditSearch />} />;
