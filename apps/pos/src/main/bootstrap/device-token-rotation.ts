import type { Logger } from 'pino';

import type { WorkerRegistry } from '../app/bootstrap-workers.js';
import { createBackendRotationClient } from '../device-token-rotation/rotation-client.js';
import {
  createDeviceTokenRotation,
  type DeviceTokenRotation,
} from '../device-token-rotation/rotation-coordinator.js';
import { readRotationHint } from '../device-token-rotation/rotation-policy.js';
import type { FetchLike } from '../http/transport.js';
import type { DeviceTokenRotationStore } from '../pairing/store.js';
import { uuidv7 } from '../returns/uuidv7.js';

/** The first check after start: the paired workers and the network are up by then. */
export const ROTATION_START_DELAY_MS = 20_000;
/** Then hourly: the 15-day threshold needs no finer clock. */
export const ROTATION_TICK_MS = 60 * 60 * 1000;

interface DeviceTokenRotationWiringDeps {
  baseUrl: string;
  /** The shared Backend-Core fetch (request id, build identity, status observer). */
  fetch: FetchLike;
  store: DeviceTokenRotationStore;
  workerRegistry: Pick<WorkerRegistry, 'register'>;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

interface DeviceTokenRotationWiring {
  /** `deps.fetch`, also reading the RT-639 rotate-soon hint off every answer. */
  fetch: FetchLike;
  /** Wraps the RT-215 confirmation probe: in the grace, rotate first. */
  recoveryFirst: DeviceTokenRotation['recoveryFirst'];
}

/**
 * RT-373 — the device token rotation (see `device-token-rotation/rotation-coordinator.ts`).
 * Checks 20 s after start and hourly, and on every due RT-639 hint read off the
 * shared fetch. Nothing is sent while unpaired or revoked (the store hands out no
 * credential then). Stops with the other workers, before the database closes.
 */
export function registerDeviceTokenRotation(
  deps: DeviceTokenRotationWiringDeps,
): DeviceTokenRotationWiring {
  const rotation = createDeviceTokenRotation({
    store: deps.store,
    client: createBackendRotationClient(deps.baseUrl, deps.fetch),
    now: Date.now,
    newIdempotencyKey: () => uuidv7(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    logger: deps.logger,
  });
  const tick = (): void => {
    void rotation.rotateIfDue();
  };
  let interval: ReturnType<typeof setInterval> | null = null;
  const first = setTimeout(() => {
    tick();
    interval = setInterval(tick, ROTATION_TICK_MS);
  }, ROTATION_START_DELAY_MS);
  deps.workerRegistry.register('device token rotation', () => {
    rotation.stop();
    clearTimeout(first);
    if (interval !== null) clearInterval(interval);
  });

  const fetch: FetchLike = async (input, init) => {
    const response = await deps.fetch(input, init);
    try {
      rotation.observeHint(readRotationHint(response.headers));
    } catch {
      // Observation is best-effort; the answer goes back untouched.
    }
    return response;
  };
  return { fetch, recoveryFirst: (probe) => rotation.recoveryFirst(probe) };
}
