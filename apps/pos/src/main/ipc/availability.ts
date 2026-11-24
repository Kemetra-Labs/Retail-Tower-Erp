import type { IpcMain } from 'electron';

import { AVAILABILITY_IPC_CHANNELS } from '../../shared/availability/channels.js';
import type {
  AvailabilityBandsResponse,
  AvailabilityRefreshResponse,
  AvailabilityStatusResponse,
} from '../../shared/availability/types.js';
import type { AvailabilityService } from '../availability/availability-service.js';

/**
 * RT-1578 (RT-1511 S3) — `availability:*` IPC registration. A thin wire-up: every handler first requires an
 * operator session (any role: cashier, manager and admin all see availability), then answers from the
 * availability service. Read-only and status-only; no handler reserves, holds or writes stock (FR-6).
 *
 * `status` and `refresh` take no payload (identity and scope come from the pairing, never the renderer).
 * `bands` takes a bounded list of product ids; a malformed or oversized list is refused generically.
 */

/** The most product ids one `bands` call may ask about (a search page or a cart, with room to spare). */
export const MAX_BAND_PRODUCT_IDS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AvailabilityHandlerDeps {
  readonly service: Pick<AvailabilityService, 'freshness' | 'states' | 'refresh'>;
  /** True while an operator session is active. */
  readonly hasSession: () => boolean;
}

function productIdsOf(request: unknown): readonly string[] | null {
  if (typeof request !== 'object' || request === null) return null;
  const ids = (request as Record<string, unknown>)['product_ids'];
  if (!Array.isArray(ids) || ids.length > MAX_BAND_PRODUCT_IDS) return null;
  const valid = ids.every((id): id is string => typeof id === 'string' && UUID.test(id));
  return valid ? ids : null;
}

export function registerAvailabilityHandlers(
  ipcMain: IpcMain,
  deps: AvailabilityHandlerDeps,
): void {
  const { service, hasSession } = deps;

  ipcMain.handle(
    AVAILABILITY_IPC_CHANNELS.STATUS,
    async (): Promise<AvailabilityStatusResponse> => {
      if (!hasSession()) return { kind: 'refused', reason: 'no_session' };
      return { kind: 'ok', ...(await service.freshness()) };
    },
  );

  ipcMain.handle(
    AVAILABILITY_IPC_CHANNELS.BANDS,
    async (_event, request: unknown): Promise<AvailabilityBandsResponse> => {
      if (!hasSession()) return { kind: 'refused', reason: 'no_session' };
      const ids = productIdsOf(request);
      if (ids === null) return { kind: 'refused', reason: 'invalid_request' };
      const { freshness, states } = await service.states(ids);
      return { kind: 'ok', states, ...freshness };
    },
  );

  ipcMain.handle(
    AVAILABILITY_IPC_CHANNELS.REFRESH,
    async (): Promise<AvailabilityRefreshResponse> => {
      if (!hasSession()) return { kind: 'refused', reason: 'no_session' };
      return { kind: 'done', outcome: await service.refresh() };
    },
  );
}
