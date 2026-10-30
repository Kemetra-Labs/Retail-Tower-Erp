/**
 * RT-371 device registry route registration (RT-372 adds the pending pairing codes). Mounts inside the protected
 * layout (`/` → ProtectedArea → AppShell → <Outlet/>), behind RF-1's context
 * gate. Pure additive registration. The API is the authority on who may read
 * (non-disclosing 404 otherwise); the sidebar entry mirrors its roles.
 */
import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const DeviceDetail = lazyPage(() => import("@/devices/DeviceDetail"), "DeviceDetail");
const DeviceList = lazyPage(() => import("@/devices/DeviceList"), "DeviceList");
const PairingCodes = lazyPage(() => import("@/devices/PairingCodes"), "PairingCodes");

export const deviceRoutes = (
  <>
    <Route path="devices" element={<DeviceList />} />
    <Route path="devices/pairing-codes" element={<PairingCodes />} />
    <Route path="devices/:deviceId" element={<DeviceDetail />} />
  </>
);
