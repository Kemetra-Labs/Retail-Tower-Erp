import { ipcRenderer } from 'electron';

import { AVAILABILITY_IPC_CHANNELS } from '../shared/availability/channels.js';
import type {
  AvailabilityBandsRequest,
  AvailabilityBandsResponse,
  AvailabilityBridgeAPI,
  AvailabilityRefreshResponse,
  AvailabilityStatusResponse,
} from '../shared/availability/types.js';

/**
 * RT-1578 (RT-1511 S3, spec 013) — `availability.*` preload bridge. A thin contextBridge surface: each member
 * is one `ipcRenderer.invoke` on a typed channel. Main-process session gating is the security boundary.
 * Read-only: no member reserves or writes stock (FR-6), and none can block a sale (FR-5).
 */
export const availability: AvailabilityBridgeAPI = {
  status: (req) =>
    ipcRenderer.invoke(
      AVAILABILITY_IPC_CHANNELS.STATUS,
      req,
    ) as Promise<AvailabilityStatusResponse>,
  bands: (req: AvailabilityBandsRequest) =>
    ipcRenderer.invoke(AVAILABILITY_IPC_CHANNELS.BANDS, req) as Promise<AvailabilityBandsResponse>,
  refresh: (req) =>
    ipcRenderer.invoke(
      AVAILABILITY_IPC_CHANNELS.REFRESH,
      req,
    ) as Promise<AvailabilityRefreshResponse>,
};
