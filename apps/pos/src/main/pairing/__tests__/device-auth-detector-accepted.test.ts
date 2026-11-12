import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEVICE_401_CONFIRM_MS,
  createDeviceAuthDetector,
  type DeviceAuthOutcome,
} from '../device-auth-detector.js';

/**
 * RT-1348 — the detector tells the pairing store when Backend-Core ACCEPTED the
 * device credential (a device-bearer 2xx), so a legacy pairing (no stored
 * origin) can adopt the origin it was just accepted on. Only a 2xx counts.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function build(probeAnswer: DeviceAuthOutcome = 'ok') {
  const onDeviceAccepted = vi.fn();
  const onConfirmed = vi.fn();
  const detector = createDeviceAuthDetector({
    probe: () => Promise.resolve(probeAnswer),
    confirmDelayMs: () => DEVICE_401_CONFIRM_MS,
    onConfirmed,
    onDeviceAccepted,
  });
  return { detector, onDeviceAccepted, onConfirmed };
}

describe('device auth detector — onDeviceAccepted (RT-1348)', () => {
  it('fires on a device-bearer 2xx', () => {
    const { detector, onDeviceAccepted } = build();
    detector.observe('cashier_admissions', 200);
    expect(onDeviceAccepted).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 500, 503])('does not fire on a %i', (status) => {
    const { detector, onDeviceAccepted } = build();
    detector.observe('read_down', status);
    expect(onDeviceAccepted).not.toHaveBeenCalled();
  });

  it('fires when the confirmation call is answered 2xx after a first 401', async () => {
    const { detector, onDeviceAccepted, onConfirmed } = build('ok');
    detector.observe('cashier_admissions', 401);
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS);
    expect(onDeviceAccepted).toHaveBeenCalledTimes(1);
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('does not fire when the revocation is confirmed (two 401s)', async () => {
    const { detector, onDeviceAccepted, onConfirmed } = build('unauthorized');
    detector.observe('cashier_admissions', 401);
    await vi.advanceTimersByTimeAsync(DEVICE_401_CONFIRM_MS);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onDeviceAccepted).not.toHaveBeenCalled();
  });

  it('does not fire once the detector is stopped', () => {
    const { detector, onDeviceAccepted } = build();
    detector.stop();
    detector.observe('cashier_admissions', 200);
    expect(onDeviceAccepted).not.toHaveBeenCalled();
  });

  it('contains a throwing hook: the 2xx still resets a pending count', () => {
    const detector = createDeviceAuthDetector({
      probe: () => Promise.resolve('unauthorized'),
      confirmDelayMs: () => DEVICE_401_CONFIRM_MS,
      onConfirmed: () => undefined,
      onDeviceAccepted: () => {
        throw new Error('disk');
      },
    });
    detector.observe('cashier_admissions', 401);
    expect(detector.state).toBe('suspect');
    expect(() => {
      detector.observe('cashier_admissions', 200);
    }).not.toThrow();
    expect(detector.state).toBe('clear');
  });
});
